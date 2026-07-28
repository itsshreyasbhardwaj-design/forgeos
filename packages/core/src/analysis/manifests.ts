import { basename } from './languages.js';
import type { RepoSnapshot, SourceFile } from '../fs/types.js';

/**
 * Package manifest parsing across ecosystems.
 *
 * Manifests are parsed rather than lockfiles: a lockfile is an order of
 * magnitude larger, and the declared range is what a human can actually act on
 * when a vulnerability is reported. Where a lockfile would add real value
 * (exact transitive versions) the ecosystem's own tooling does it better.
 */
export type Ecosystem = 'npm' | 'pypi' | 'go' | 'cargo' | 'maven' | 'gem' | 'composer' | 'nuget';

export interface Dependency {
  readonly name: string;
  /** Declared range, verbatim from the manifest. */
  readonly range: string;
  readonly ecosystem: Ecosystem;
  readonly scope: 'runtime' | 'development' | 'peer' | 'optional';
  /** Manifest the dependency was declared in. */
  readonly manifest: string;
}

export interface PackageManifest {
  readonly path: string;
  readonly ecosystem: Ecosystem;
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly license?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies: readonly Dependency[];
  /** Declared entry points, used by the architecture documentation generator. */
  readonly entryPoints?: readonly string[];
}

const MANIFEST_FILES: Readonly<Record<string, Ecosystem>> = {
  'package.json': 'npm',
  'requirements.txt': 'pypi',
  'pyproject.toml': 'pypi',
  'pipfile': 'pypi',
  'go.mod': 'go',
  'cargo.toml': 'cargo',
  'pom.xml': 'maven',
  'build.gradle': 'maven',
  'build.gradle.kts': 'maven',
  gemfile: 'gem',
  'composer.json': 'composer',
};

export function isManifest(path: string): Ecosystem | null {
  const base = basename(path).toLowerCase();
  if (base.endsWith('.csproj') || base.endsWith('.fsproj')) return 'nuget';
  return MANIFEST_FILES[base] ?? null;
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface NpmManifest {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  main?: string;
  module?: string;
  types?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function parseNpm(path: string, text: string): PackageManifest | null {
  const json = safeJson<NpmManifest>(text);
  if (!json) return null;

  const dependencies: Dependency[] = [];
  const add = (record: Record<string, string> | undefined, scope: Dependency['scope']): void => {
    for (const [name, range] of Object.entries(record ?? {})) {
      dependencies.push({ name, range: String(range), ecosystem: 'npm', scope, manifest: path });
    }
  };
  add(json.dependencies, 'runtime');
  add(json.devDependencies, 'development');
  add(json.peerDependencies, 'peer');
  add(json.optionalDependencies, 'optional');

  const entryPoints = [json.main, json.module, json.types].filter(
    (value): value is string => typeof value === 'string'
  );
  if (typeof json.bin === 'string') entryPoints.push(json.bin);
  else if (json.bin) entryPoints.push(...Object.values(json.bin));

  return {
    path,
    ecosystem: 'npm',
    ...(json.name ? { name: json.name } : {}),
    ...(json.version ? { version: json.version } : {}),
    ...(json.description ? { description: json.description } : {}),
    ...(typeof json.license === 'string' ? { license: json.license } : {}),
    ...(json.scripts ? { scripts: json.scripts } : {}),
    dependencies,
    entryPoints,
  };
}

/** `package==1.2.3`, `package>=1.0,<2`, `package[extra]~=1.0`, `-r other.txt`. */
function parseRequirements(path: string, text: string): PackageManifest {
  const dependencies: Dependency[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '' || line.startsWith('-')) continue;
    const match = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    dependencies.push({
      name: match[1],
      range: (match[2] ?? '').replace(/;.*$/, '').trim() || '*',
      ecosystem: 'pypi',
      scope: /dev|test/i.test(path) ? 'development' : 'runtime',
      manifest: path,
    });
  }
  return { path, ecosystem: 'pypi', dependencies };
}

/**
 * A deliberately small TOML reader: section headers plus `key = value` pairs.
 * Enough for `[project]`, `[tool.poetry.dependencies]` and `[dependencies]`,
 * which is all any manifest actually needs from us.
 */
export function parseSimpleToml(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current = 'root';
  sections.set(current, new Map());

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '') continue;

    const header = /^\[+([^\]]+)\]+$/.exec(line);
    if (header?.[1]) {
      current = header[1].trim();
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }

    const pair = /^([A-Za-z0-9_."-]+)\s*=\s*(.+)$/.exec(line);
    if (pair?.[1]) {
      const key = pair[1].replace(/^["']|["']$/g, '');
      const value = (pair[2] ?? '').trim().replace(/^["']|["'],?$/g, '');
      sections.get(current)?.set(key, value);
    }
  }
  return sections;
}

function parsePyproject(path: string, text: string): PackageManifest {
  const sections = parseSimpleToml(text);
  const project = sections.get('project');
  const dependencies: Dependency[] = [];

  // PEP 621: dependencies = ["httpx>=0.27", "pydantic>=2"]
  const inline = project?.get('dependencies');
  if (inline) {
    for (const entry of inline.matchAll(/["']([^"']+)["']/g)) {
      const spec = entry[1] ?? '';
      const match = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(spec);
      if (match?.[1]) {
        dependencies.push({
          name: match[1],
          range: (match[2] ?? '*').trim() || '*',
          ecosystem: 'pypi',
          scope: 'runtime',
          manifest: path,
        });
      }
    }
  }

  // Poetry style.
  for (const [sectionName, entries] of sections) {
    if (!/dependencies$/.test(sectionName)) continue;
    const development = /dev|test/i.test(sectionName);
    for (const [name, range] of entries) {
      if (name.toLowerCase() === 'python') continue;
      dependencies.push({
        name,
        range: range.replace(/[{}]/g, '').trim() || '*',
        ecosystem: 'pypi',
        scope: development ? 'development' : 'runtime',
        manifest: path,
      });
    }
  }

  return {
    path,
    ecosystem: 'pypi',
    ...(project?.get('name') ? { name: project.get('name') as string } : {}),
    ...(project?.get('version') ? { version: project.get('version') as string } : {}),
    ...(project?.get('description') ? { description: project.get('description') as string } : {}),
    dependencies,
  };
}

function parseGoMod(path: string, text: string): PackageManifest {
  const dependencies: Dependency[] = [];
  let moduleName: string | undefined;
  let inBlock = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('//')[0]?.trim() ?? '';
    if (line === '') continue;

    const moduleMatch = /^module\s+(\S+)/.exec(line);
    if (moduleMatch?.[1]) {
      moduleName = moduleMatch[1];
      continue;
    }
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }

    const single = /^require\s+(\S+)\s+(\S+)/.exec(line);
    const inner = inBlock ? /^(\S+)\s+(\S+)/.exec(line) : null;
    const match = single ?? inner;
    if (match?.[1] && match[2]) {
      dependencies.push({
        name: match[1],
        range: match[2],
        ecosystem: 'go',
        scope: 'runtime',
        manifest: path,
      });
    }
  }

  return { path, ecosystem: 'go', ...(moduleName ? { name: moduleName } : {}), dependencies };
}

function parseCargo(path: string, text: string): PackageManifest {
  const sections = parseSimpleToml(text);
  const pkg = sections.get('package');
  const dependencies: Dependency[] = [];

  for (const [sectionName, entries] of sections) {
    if (!/^(dependencies|dev-dependencies|build-dependencies)$/.test(sectionName)) continue;
    for (const [name, value] of entries) {
      const version = /version\s*=\s*["']([^"']+)["']/.exec(value)?.[1] ?? value;
      dependencies.push({
        name,
        range: version.replace(/[{}]/g, '').trim() || '*',
        ecosystem: 'cargo',
        scope: sectionName === 'dependencies' ? 'runtime' : 'development',
        manifest: path,
      });
    }
  }

  return {
    path,
    ecosystem: 'cargo',
    ...(pkg?.get('name') ? { name: pkg.get('name') as string } : {}),
    ...(pkg?.get('version') ? { version: pkg.get('version') as string } : {}),
    ...(pkg?.get('description') ? { description: pkg.get('description') as string } : {}),
    ...(pkg?.get('license') ? { license: pkg.get('license') as string } : {}),
    dependencies,
  };
}

function parseMavenPom(path: string, text: string): PackageManifest {
  const dependencies: Dependency[] = [];
  for (const block of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const body = block[1] ?? '';
    const groupId = /<groupId>([^<]+)<\/groupId>/.exec(body)?.[1]?.trim();
    const artifactId = /<artifactId>([^<]+)<\/artifactId>/.exec(body)?.[1]?.trim();
    const version = /<version>([^<]+)<\/version>/.exec(body)?.[1]?.trim() ?? '*';
    const scope = /<scope>([^<]+)<\/scope>/.exec(body)?.[1]?.trim();
    if (!groupId || !artifactId) continue;
    dependencies.push({
      name: `${groupId}:${artifactId}`,
      range: version,
      ecosystem: 'maven',
      scope: scope === 'test' ? 'development' : 'runtime',
      manifest: path,
    });
  }
  return { path, ecosystem: 'maven', dependencies };
}

function parseGradle(path: string, text: string): PackageManifest {
  const dependencies: Dependency[] = [];
  const pattern =
    /(implementation|api|compileOnly|runtimeOnly|testImplementation)\s*[('"]+([^:'")]+):([^:'")]+):?([^'")]*)['")]+/g;
  for (const match of text.matchAll(pattern)) {
    dependencies.push({
      name: `${match[2]}:${match[3]}`,
      range: match[4] || '*',
      ecosystem: 'maven',
      scope: match[1]?.startsWith('test') ? 'development' : 'runtime',
      manifest: path,
    });
  }
  return { path, ecosystem: 'maven', dependencies };
}

function parseGemfile(path: string, text: string): PackageManifest {
  const dependencies: Dependency[] = [];
  for (const match of text.matchAll(/^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm)) {
    dependencies.push({
      name: match[1] ?? '',
      range: match[2] ?? '*',
      ecosystem: 'gem',
      scope: 'runtime',
      manifest: path,
    });
  }
  return { path, ecosystem: 'gem', dependencies };
}

function parseComposer(path: string, text: string): PackageManifest {
  const json = safeJson<{
    name?: string;
    description?: string;
    license?: string;
    require?: Record<string, string>;
    'require-dev'?: Record<string, string>;
  }>(text);
  if (!json) return { path, ecosystem: 'composer', dependencies: [] };

  const dependencies: Dependency[] = [];
  for (const [name, range] of Object.entries(json.require ?? {})) {
    if (name === 'php' || name.startsWith('ext-')) continue;
    dependencies.push({ name, range, ecosystem: 'composer', scope: 'runtime', manifest: path });
  }
  for (const [name, range] of Object.entries(json['require-dev'] ?? {})) {
    dependencies.push({ name, range, ecosystem: 'composer', scope: 'development', manifest: path });
  }
  return {
    path,
    ecosystem: 'composer',
    ...(json.name ? { name: json.name } : {}),
    ...(json.description ? { description: json.description } : {}),
    ...(json.license ? { license: json.license } : {}),
    dependencies,
  };
}

function parseCsproj(path: string, text: string): PackageManifest {
  const dependencies: Dependency[] = [];
  for (const match of text.matchAll(
    /<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g
  )) {
    dependencies.push({
      name: match[1] ?? '',
      range: match[2] ?? '*',
      ecosystem: 'nuget',
      scope: 'runtime',
      manifest: path,
    });
  }
  return { path, ecosystem: 'nuget', dependencies };
}

export function parseManifest(file: SourceFile): PackageManifest | null {
  if (file.text === null) return null;
  const ecosystem = isManifest(file.path);
  if (!ecosystem) return null;
  const base = basename(file.path).toLowerCase();

  switch (base) {
    case 'package.json':
      return parseNpm(file.path, file.text);
    case 'requirements.txt':
      return parseRequirements(file.path, file.text);
    case 'pyproject.toml':
      return parsePyproject(file.path, file.text);
    case 'go.mod':
      return parseGoMod(file.path, file.text);
    case 'cargo.toml':
      return parseCargo(file.path, file.text);
    case 'pom.xml':
      return parseMavenPom(file.path, file.text);
    case 'build.gradle':
    case 'build.gradle.kts':
      return parseGradle(file.path, file.text);
    case 'gemfile':
      return parseGemfile(file.path, file.text);
    case 'composer.json':
      return parseComposer(file.path, file.text);
    default:
      return base.endsWith('.csproj') || base.endsWith('.fsproj')
        ? parseCsproj(file.path, file.text)
        : null;
  }
}

export function collectManifests(snapshot: RepoSnapshot): PackageManifest[] {
  const manifests: PackageManifest[] = [];
  for (const file of snapshot.files) {
    const manifest = parseManifest(file);
    if (manifest) manifests.push(manifest);
  }
  // Shallower manifests first: the root package describes the project.
  return manifests.sort(
    (a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path)
  );
}

/** Merge dependencies across manifests, keeping the shallowest declaration. */
export function mergeDependencies(manifests: readonly PackageManifest[]): Dependency[] {
  const byKey = new Map<string, Dependency>();
  for (const manifest of manifests) {
    for (const dependency of manifest.dependencies) {
      const key = `${dependency.ecosystem}:${dependency.name}`;
      if (!byKey.has(key)) byKey.set(key, dependency);
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}
