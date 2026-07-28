import { detectLanguage, extname, type LanguageDefinition } from './languages.js';
import { stripComments } from './complexity.js';
import { parseJsonc } from '../kernel/jsonc.js';

/**
 * Import extraction and resolution.
 *
 * Imports are the edges of every graph ForgeOS draws: the module graph, the
 * layer diagram, the cycle report and the blast-radius calculation all derive
 * from here. Extraction is per-language and pattern-based; *resolution* — the
 * part that turns `../utils/foo` into an actual file in the snapshot — is
 * shared, and is where most of the accuracy comes from.
 */
export interface RawImport {
  /** The specifier exactly as written in the source. */
  readonly specifier: string;
  readonly line: number;
  readonly kind: 'static' | 'dynamic' | 'type' | 'side-effect' | 're-export';
}

export interface ResolvedImport extends RawImport {
  /** Snapshot path when the specifier resolves to a file in this repository. */
  readonly target: string | null;
  /** Package name when the specifier points outside the repository. */
  readonly external: string | null;
}

interface ExtractorRule {
  readonly pattern: RegExp;
  readonly kind: RawImport['kind'];
  /** Which capture group holds the specifier. */
  readonly group: number;
}

const JS_RULES: readonly ExtractorRule[] = [
  { pattern: /^\s*import\s+type\s+[^'"]*from\s*['"]([^'"]+)['"]/gm, kind: 'type', group: 1 },
  { pattern: /^\s*import\s+[^'"]*from\s*['"]([^'"]+)['"]/gm, kind: 'static', group: 1 },
  { pattern: /^\s*import\s*['"]([^'"]+)['"]/gm, kind: 'side-effect', group: 1 },
  { pattern: /^\s*export\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*['"]([^'"]+)['"]/gm, kind: 're-export', group: 1 },
  { pattern: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'dynamic', group: 1 },
  { pattern: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'static', group: 1 },
];

const PYTHON_RULES: readonly ExtractorRule[] = [
  { pattern: /^\s*from\s+([.\w]+)\s+import\s+/gm, kind: 'static', group: 1 },
  { pattern: /^\s*import\s+([.\w]+(?:\s*,\s*[.\w]+)*)/gm, kind: 'static', group: 1 },
];

const GO_RULES: readonly ExtractorRule[] = [
  { pattern: /^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm, kind: 'static', group: 1 },
  { pattern: /^\s+(?:\w+\s+)?"([^"]+)"$/gm, kind: 'static', group: 1 },
];

const RUST_RULES: readonly ExtractorRule[] = [
  { pattern: /^\s*(?:pub\s+)?use\s+([\w:]+)/gm, kind: 'static', group: 1 },
];

const JVM_RULES: readonly ExtractorRule[] = [
  { pattern: /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm, kind: 'static', group: 1 },
];

const CSS_RULES: readonly ExtractorRule[] = [
  { pattern: /@import\s+(?:url\()?['"]([^'"]+)['"]/g, kind: 'static', group: 1 },
];

function rulesFor(language: LanguageDefinition | undefined): readonly ExtractorRule[] {
  switch (language?.id) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
    case 'vue':
    case 'svelte':
      return JS_RULES;
    case 'python':
      return PYTHON_RULES;
    case 'go':
      return GO_RULES;
    case 'rust':
      return RUST_RULES;
    case 'java':
    case 'kotlin':
    case 'scala':
    case 'csharp':
      return JVM_RULES;
    case 'css':
    case 'scss':
      return CSS_RULES;
    default:
      return [];
  }
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/** Extract every import specifier from a source file. */
export function extractImports(path: string, text: string): RawImport[] {
  const language = detectLanguage(path);
  const rules = rulesFor(language);
  if (rules.length === 0) return [];

  // Stripping comments prevents commented-out imports from becoming graph
  // edges. String contents must be preserved — the specifier is the string.
  const source = stripComments(text, language);
  const seen = new Set<string>();
  const imports: RawImport[] = [];

  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const captured = match[rule.group];
      if (!captured) continue;
      for (const raw of captured.split(',')) {
        const specifier = raw.trim().replace(/\s+as\s+\w+$/, '');
        if (specifier === '') continue;
        const line = lineNumberAt(source, match.index);
        const key = `${specifier}:${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        imports.push({ specifier, line, kind: rule.kind });
      }
      if (pattern.lastIndex <= match.index) pattern.lastIndex = match.index + 1;
    }
  }

  return imports.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}

/** Normalise `a/b/../c` to `a/c` without touching the filesystem. */
export function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** Extensions tried, in order, when a specifier omits one. */
const RESOLUTION_EXTENSIONS: readonly string[] = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.vue', '.svelte', '.py', '.go', '.rs', '.css', '.scss', '.json',
];

const INDEX_FILES: readonly string[] = ['index', '__init__', 'mod', 'main'];

/**
 * Resolve a specifier against the set of files in the snapshot.
 *
 * Mirrors Node/TypeScript resolution closely enough for graph purposes:
 * extension inference, directory index files, and TypeScript's convention of
 * importing `./foo.js` from `./foo.ts`.
 */
export function resolveSpecifier(
  fromPath: string,
  specifier: string,
  fileIndex: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string> = new Map()
): string | null {
  let candidate = specifier;
  let aliased = false;

  // Path aliases from tsconfig/jsconfig (`@/components` -> `src/components`).
  for (const [prefix, replacement] of aliases) {
    if (candidate === prefix || candidate.startsWith(`${prefix}/`)) {
      candidate = replacement + candidate.slice(prefix.length);
      aliased = true;
      break;
    }
  }

  // Python-style relative import: `.`, `..sibling`, `.pkg.module`.
  const pythonRelative = /^(\.+)([\w.]*)$/.exec(candidate);
  if (pythonRelative && !candidate.startsWith('./') && !candidate.startsWith('../')) {
    const levels = (pythonRelative[1] ?? '.').length;
    const upward = '../'.repeat(Math.max(0, levels - 1));
    const tail = (pythonRelative[2] ?? '').split('.').filter(Boolean).join('/');
    const base = normalizePath(`${dirname(fromPath)}/${upward}${tail}`);
    return tryPaths(base, fileIndex);
  }

  if (candidate.startsWith('.')) {
    return tryPaths(normalizePath(`${dirname(fromPath)}/${candidate}`), fileIndex);
  }

  if (aliased || candidate.startsWith('/')) {
    return tryPaths(normalizePath(candidate), fileIndex);
  }

  // A bare specifier is external unless it happens to name a file in the
  // repository — which is how absolute Python and Go intra-module imports look.
  return tryPaths(candidate.replace(/\./g, '/'), fileIndex);
}

function tryPaths(base: string, fileIndex: ReadonlySet<string>): string | null {
  if (fileIndex.has(base)) return base;

  // TypeScript ESM emits `./foo.js` for `./foo.ts`.
  const extension = extname(base);
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    const withoutExtension = base.slice(0, -extension.length);
    for (const candidateExt of ['.ts', '.tsx', '.mts', '.cts']) {
      if (fileIndex.has(withoutExtension + candidateExt)) return withoutExtension + candidateExt;
    }
  }

  if (extension === '') {
    for (const candidateExt of RESOLUTION_EXTENSIONS) {
      if (fileIndex.has(base + candidateExt)) return base + candidateExt;
    }
    for (const indexName of INDEX_FILES) {
      for (const candidateExt of RESOLUTION_EXTENSIONS) {
        const path = `${base}/${indexName}${candidateExt}`;
        if (fileIndex.has(path)) return path;
      }
    }
  }

  return null;
}

/**
 * Reduce a specifier to the package name it belongs to.
 * `@scope/pkg/sub` -> `@scope/pkg`; `lodash/fp` -> `lodash`.
 */
export function packageNameOf(specifier: string): string {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return specifier;
  const clean = specifier.replace(/^node:/, '');
  const parts = clean.split('/');
  if (clean.startsWith('@') && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? clean;
}

/** Parse `compilerOptions.paths` from a tsconfig into a simple prefix map. */
export function parsePathAliases(tsconfigText: string): Map<string, string> {
  const aliases = new Map<string, string>();

  // tsconfig files routinely contain comments and trailing commas, and their
  // `paths` values contain `/*` — which is why this needs a string-aware
  // parser rather than a regex pre-pass.
  const json = parseJsonc<{
    compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  }>(tsconfigText);
  if (!json) return aliases;

  const baseUrl = (json.compilerOptions?.baseUrl ?? '.').replace(/^\.\/?/, '');
  for (const [pattern, targets] of Object.entries(json.compilerOptions?.paths ?? {})) {
    const target = targets[0];
    if (!target) continue;
    const prefix = pattern.replace(/\/?\*$/, '');
    const replacement = normalizePath(`${baseUrl}/${target.replace(/\/?\*$/, '')}`);
    if (prefix) aliases.set(prefix, replacement);
  }
  return aliases;
}
