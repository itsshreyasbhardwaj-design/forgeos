import type { RepositoryAnalysis } from '../analysis/repository.js';
import type { PackageManifest } from '../analysis/manifests.js';
import { toMermaidErd, toMermaidFlowchart, toMermaidLayerDiagram } from '../graph/mermaid.js';
import { findLayerViolations } from '../graph/module-graph.js';
import { titleCase } from '../kernel/text.js';
import { contentHash } from '../kernel/hash.js';
import { deterministicId } from '../kernel/id.js';
import { undocumentedVariables } from '../analysis/environment.js';

/**
 * Documentation generation.
 *
 * Every sentence these generators emit is derived from something measured in
 * the repository. There is no lorem ipsum, no "TODO: describe your project",
 * and no invented feature list — if ForgeOS cannot determine something, it says
 * so explicitly and tells the reader what to fill in. Generated documentation
 * that quietly fabricates is worse than none, because it is believed.
 *
 * An AI provider can refine the prose afterwards; these functions produce the
 * factual skeleton it refines, which is what keeps the output grounded.
 */
export type DocumentKind =
  | 'readme'
  | 'architecture'
  | 'api'
  | 'setup'
  | 'deployment'
  | 'contributing';

export interface GeneratedDocument {
  readonly id: string;
  readonly kind: DocumentKind;
  readonly title: string;
  readonly markdown: string;
  /** Content hash, so versions can be compared without storing every revision. */
  readonly hash: string;
  readonly generatedAt: number;
  /** Sections a human must complete, surfaced in the editor as prompts. */
  readonly gaps: readonly string[];
  readonly wordCount: number;
}

function document(
  kind: DocumentKind,
  title: string,
  markdown: string,
  gaps: readonly string[],
  now: number
): GeneratedDocument {
  return {
    id: deterministicId('doc', kind, title, contentHash(markdown)),
    kind,
    title,
    markdown,
    hash: contentHash(markdown),
    generatedAt: now,
    gaps,
    wordCount: markdown.split(/\s+/).filter(Boolean).length,
  };
}

function rootManifest(analysis: RepositoryAnalysis): PackageManifest | undefined {
  return analysis.manifests[0];
}

/** The install/run commands a project actually supports, read from its files. */
export interface ProjectCommands {
  readonly packageManager: string;
  readonly install: string;
  readonly dev?: string;
  readonly build?: string;
  readonly test?: string;
  readonly lint?: string;
  readonly start?: string;
}

export function inferCommands(analysis: RepositoryAnalysis): ProjectCommands {
  const manifest = rootManifest(analysis);
  const has = (path: RegExp): boolean => analysis.files.some((file) => path.test(file.path)) ||
    analysis.graph.nodes.some((node) => path.test(node.path));
  const fileExists = (name: string): boolean =>
    analysis.tree.children?.some((child) => child.name === name) ?? false;

  if (manifest?.ecosystem === 'npm') {
    const packageManager = fileExists('pnpm-lock.yaml') || fileExists('pnpm-workspace.yaml')
      ? 'pnpm'
      : fileExists('yarn.lock')
        ? 'yarn'
        : fileExists('bun.lockb')
          ? 'bun'
          : 'npm';
    const scripts = manifest.scripts ?? {};
    const run = (script: string): string | undefined =>
      scripts[script] ? `${packageManager} ${packageManager === 'npm' ? 'run ' : ''}${script}` : undefined;

    return {
      packageManager,
      install: `${packageManager} install`,
      ...(run('dev') ? { dev: run('dev') as string } : {}),
      ...(run('build') ? { build: run('build') as string } : {}),
      ...(run('test') ? { test: run('test') as string } : {}),
      ...(run('lint') ? { lint: run('lint') as string } : {}),
      ...(run('start') ? { start: run('start') as string } : {}),
    };
  }

  if (manifest?.ecosystem === 'pypi') {
    const usesPoetry = analysis.manifests.some((m) => m.path.endsWith('pyproject.toml'));
    return {
      packageManager: usesPoetry ? 'poetry' : 'pip',
      install: usesPoetry ? 'poetry install' : 'pip install -r requirements.txt',
      ...(has(/manage\.py$/) ? { dev: 'python manage.py runserver' } : {}),
      test: usesPoetry ? 'poetry run pytest' : 'pytest',
    };
  }

  if (manifest?.ecosystem === 'go') {
    return { packageManager: 'go', install: 'go mod download', build: 'go build ./...', test: 'go test ./...' };
  }
  if (manifest?.ecosystem === 'cargo') {
    return { packageManager: 'cargo', install: 'cargo fetch', build: 'cargo build --release', test: 'cargo test' };
  }

  return { packageManager: 'unknown', install: 'See the project documentation.' };
}

function badge(label: string, value: string, colour: string): string {
  const encode = (text: string): string => encodeURIComponent(text.replace(/-/g, '--'));
  return `![${label}](https://img.shields.io/badge/${encode(label)}-${encode(value)}-${colour})`;
}

export function generateReadme(analysis: RepositoryAnalysis, now = Date.now()): GeneratedDocument {
  const { overview } = analysis;
  const commands = inferCommands(analysis);
  const gaps: string[] = [];
  const lines: string[] = [];

  lines.push(`# ${titleCase(overview.name)}`, '');

  if (overview.description) {
    lines.push(`> ${overview.description}`, '');
  } else {
    gaps.push('One-line project description — no package description or README summary was found.');
    lines.push('> _Add a one-line description of what this project does._', '');
  }

  const badges = [
    overview.primaryLanguage ? badge('language', overview.primaryLanguage, 'blue') : null,
    badge('health', `${analysis.debt.score}%`, analysis.debt.score >= 75 ? 'brightgreen' : 'orange'),
    rootManifest(analysis)?.license ? badge('license', rootManifest(analysis)!.license as string, 'green') : null,
  ].filter(Boolean);
  if (badges.length > 0) lines.push(badges.join(' '), '');

  // Overview
  lines.push('## Overview', '');
  lines.push(
    `${titleCase(overview.name)} is a ${overview.stackSummary === 'No framework detected' ? overview.primaryLanguage ?? 'software' : overview.stackSummary} project comprising ${overview.files.toLocaleString()} files and ${overview.code.toLocaleString()} lines of code.`,
    ''
  );

  const primaryStack = analysis.stack.filter((tech) => tech.confidence >= 0.7).slice(0, 10);
  if (primaryStack.length > 0) {
    lines.push('### Built with', '');
    for (const tech of primaryStack) {
      lines.push(`- **${tech.name}**${tech.version ? ` \`${tech.version}\`` : ''} — ${tech.category}`);
    }
    lines.push('');
  }

  // Structure
  const topLevel = (analysis.tree.children ?? [])
    .filter((child) => child.type === 'directory' && !child.name.startsWith('.'))
    .slice(0, 12);
  if (topLevel.length > 0) {
    lines.push('## Project structure', '');
    lines.push('```');
    for (const child of topLevel) {
      lines.push(`${child.name}/`.padEnd(28) + `${child.loc.toLocaleString()} LOC`);
    }
    lines.push('```', '');
  }

  // Getting started
  lines.push('## Getting started', '');
  lines.push('### Prerequisites', '');
  const runtimes = analysis.stack.filter((tech) => tech.category === 'build').slice(0, 3);
  lines.push(
    `- ${commands.packageManager === 'unknown' ? 'The toolchain for this project' : commands.packageManager}` +
      (runtimes.length > 0 ? ` (${runtimes.map((r) => r.name).join(', ')})` : ''),
    ''
  );

  lines.push('### Installation', '', '```bash', commands.install, '```', '');

  if (commands.dev || commands.build || commands.test) {
    lines.push('### Common tasks', '', '```bash');
    if (commands.dev) lines.push(`${commands.dev}          # start the development server`);
    if (commands.build) lines.push(`${commands.build}        # produce a production build`);
    if (commands.test) lines.push(`${commands.test}         # run the test suite`);
    if (commands.lint) lines.push(`${commands.lint}         # lint the codebase`);
    lines.push('```', '');
  }

  // Environment
  const envVars = analysis.environment;
  if (envVars.length > 0) {
    lines.push('## Configuration', '');
    lines.push('| Variable | Documented | Referenced in |', '| --- | --- | --- |');
    for (const variable of envVars.slice(0, 20)) {
      lines.push(
        `| \`${variable.name}\` | ${variable.documented ? 'yes' : '**no**'} | \`${variable.files[0] ?? '—'}\` |`
      );
    }
    lines.push('');
    const undocumented = undocumentedVariables(envVars);
    if (undocumented.length > 0) {
      gaps.push(
        `${undocumented.length} variable(s) are read by code but absent from any example env file: ${undocumented
          .slice(0, 8)
          .map((variable) => variable.name)
          .join(', ')}.`
      );
    }
  }

  // API
  if (analysis.api.routes.length > 0) {
    lines.push('## API', '');
    lines.push(
      `${analysis.api.routes.length} HTTP endpoint${analysis.api.routes.length === 1 ? '' : 's'} detected (${analysis.api.frameworks.join(', ')}).`,
      ''
    );
    lines.push('| Method | Path |', '| --- | --- |');
    for (const route of analysis.api.routes.slice(0, 15)) {
      lines.push(`| \`${route.method}\` | \`${route.path}\` |`);
    }
    if (analysis.api.routes.length > 15) {
      lines.push(`| … | _${analysis.api.routes.length - 15} more_ |`);
    }
    lines.push('');
  }

  // Testing
  lines.push('## Testing', '');
  if (overview.hasTests) {
    lines.push(
      `The suite contains ${overview.testFiles} test file${overview.testFiles === 1 ? '' : 's'}${commands.test ? `, run with \`${commands.test}\`` : ''}.`,
      ''
    );
  } else {
    gaps.push('No test files were found — document the testing approach or add tests.');
    lines.push('_No test files were detected in this repository._', '');
  }

  // Contributing / licence
  lines.push('## Contributing', '');
  lines.push(
    overview.hasContributing
      ? 'See [CONTRIBUTING.md](CONTRIBUTING.md).'
      : '_Contribution guidelines have not been written yet._',
    ''
  );
  if (!overview.hasContributing) gaps.push('Write contribution guidelines.');

  lines.push('## License', '');
  const license = rootManifest(analysis)?.license;
  if (license) {
    lines.push(`Released under the ${license} license.`, '');
  } else {
    gaps.push('No license was detected — add one to clarify how others may use this project.');
    lines.push('_No license file was detected._', '');
  }

  return document('readme', `${titleCase(overview.name)} — README`, lines.join('\n'), gaps, now);
}

export function generateArchitecture(
  analysis: RepositoryAnalysis,
  now = Date.now()
): GeneratedDocument {
  const gaps: string[] = [];
  const lines: string[] = [];

  lines.push(`# Architecture — ${titleCase(analysis.overview.name)}`, '');
  lines.push(
    `_Generated from static analysis of ${analysis.overview.files.toLocaleString()} files${analysis.snapshot.revision ? ` at commit \`${analysis.snapshot.revision.slice(0, 7)}\`` : ''}._`,
    ''
  );

  lines.push('## System overview', '');
  lines.push(
    `The codebase is organised into ${analysis.graph.nodes.length} modules connected by ${analysis.graph.edges.length} import relationships. ` +
      `${analysis.entryPoints.length} module${analysis.entryPoints.length === 1 ? ' is an entry point' : 's are entry points'} — nothing else in the repository imports them.`,
    ''
  );

  if (analysis.layers.length > 0) {
    lines.push('## Layers', '');
    lines.push('| Layer | Modules | Lines | Depends on |', '| --- | ---: | ---: | --- |');
    for (const layer of analysis.layers) {
      const dependsOn = Object.entries(layer.dependsOn)
        .map(([target, count]) => `${target} (${count})`)
        .join(', ');
      lines.push(
        `| ${layer.layer} | ${layer.modules} | ${layer.loc.toLocaleString()} | ${dependsOn || '—'} |`
      );
    }
    lines.push('');

    const violations = findLayerViolations(analysis.graph);
    lines.push('```mermaid', toMermaidLayerDiagram(analysis.layers, violations), '```', '');

    if (violations.length > 0) {
      lines.push('### Layering violations', '');
      lines.push(
        `${violations.length} import${violations.length === 1 ? '' : 's'} point against the intended dependency direction:`,
        ''
      );
      for (const violation of violations.slice(0, 10)) {
        lines.push(`- \`${violation.from}\` (${violation.fromLayer}) → \`${violation.to}\` (${violation.toLayer})`);
      }
      lines.push('');
    }
  } else {
    gaps.push('No conventional layer structure was detected — document the intended architecture.');
  }

  lines.push('## Module graph', '');
  lines.push('```mermaid', toMermaidFlowchart(analysis.graph, { maxNodes: 40 }), '```', '');

  if (analysis.cycles.length > 0) {
    lines.push('## Circular dependencies', '');
    for (const cycle of analysis.cycles.slice(0, 8)) {
      lines.push(
        `- ${cycle.crossesLayers ? '**Crosses layers.** ' : ''}${cycle.cycle.map((path) => `\`${path}\``).join(' → ')}`
      );
    }
    lines.push('');
  }

  if (analysis.schema.entities.length > 0) {
    lines.push('## Data model', '');
    lines.push(
      `${analysis.schema.entities.length} entities defined via ${analysis.schema.dialect} in ${analysis.schema.sources.map((source) => `\`${source}\``).join(', ')}.`,
      ''
    );
    lines.push('```mermaid', toMermaidErd(analysis.schema.entities, analysis.schema.relations), '```', '');
  }

  if (analysis.api.routes.length > 0) {
    lines.push('## HTTP surface', '');
    lines.push('| Method | Path | Handler |', '| --- | --- | --- |');
    for (const route of analysis.api.routes.slice(0, 30)) {
      lines.push(`| \`${route.method}\` | \`${route.path}\` | \`${route.file}\` |`);
    }
    lines.push('');
  }

  lines.push('## Key modules', '');
  lines.push('| Module | Lines | Complexity | Dependents |', '| --- | ---: | ---: | ---: |');
  for (const hotspot of analysis.hotspots.slice(0, 12)) {
    lines.push(`| \`${hotspot.path}\` | ${hotspot.loc} | ${hotspot.complexity} | ${hotspot.fanIn} |`);
  }
  lines.push('');

  gaps.push('Explain the *why* behind the structure — static analysis can only describe the *what*.');

  return document('architecture', `Architecture — ${titleCase(analysis.overview.name)}`, lines.join('\n'), gaps, now);
}

export function generateApiDocs(analysis: RepositoryAnalysis, now = Date.now()): GeneratedDocument {
  const gaps: string[] = [];
  const lines: string[] = [];

  lines.push(`# API reference — ${titleCase(analysis.overview.name)}`, '');

  if (analysis.api.routes.length === 0) {
    lines.push('_No HTTP endpoints were detected in this repository._', '');
    gaps.push('If this project exposes an API through a framework ForgeOS does not recognise, document it manually.');
    return document('api', `API reference — ${titleCase(analysis.overview.name)}`, lines.join('\n'), gaps, now);
  }

  lines.push(
    `${analysis.api.routes.length} endpoints across ${analysis.api.frameworks.join(', ')}.`,
    ''
  );

  const byPrefix = new Map<string, typeof analysis.api.routes>();
  for (const route of analysis.api.routes) {
    const prefix = `/${route.path.split('/').filter(Boolean)[0] ?? ''}`;
    const bucket = byPrefix.get(prefix) ?? [];
    (bucket as typeof analysis.api.routes[number][]).push(route);
    byPrefix.set(prefix, bucket as typeof analysis.api.routes);
  }

  for (const [prefix, routes] of [...byPrefix.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## \`${prefix}\``, '');
    for (const route of routes) {
      lines.push(`### \`${route.method} ${route.path}\``, '');
      lines.push(`Defined in \`${route.file}\`${route.line > 1 ? `:${route.line}` : ''}.`, '');

      const parameters = [...route.path.matchAll(/:(\w+)|\*(\w+)/g)].map(
        (match) => match[1] ?? match[2] ?? ''
      );
      if (parameters.length > 0) {
        lines.push('**Path parameters**', '');
        lines.push('| Name | Description |', '| --- | --- |');
        for (const parameter of parameters) {
          lines.push(`| \`${parameter}\` | _Describe this parameter._ |`);
        }
        lines.push('');
      }

      lines.push('```bash');
      lines.push(
        `curl -X ${route.method === 'ANY' ? 'GET' : route.method} "$BASE_URL${route.path.replace(/:(\w+)/g, '{$1}')}"`
      );
      lines.push('```', '');
    }
  }

  gaps.push('Request and response schemas are not derivable from routing alone — document them or import an OpenAPI spec.');

  return document('api', `API reference — ${titleCase(analysis.overview.name)}`, lines.join('\n'), gaps, now);
}

export function generateSetupGuide(analysis: RepositoryAnalysis, now = Date.now()): GeneratedDocument {
  const commands = inferCommands(analysis);
  const envVars = analysis.environment;
  const gaps: string[] = [];
  const lines: string[] = [];

  lines.push(`# Setup guide — ${titleCase(analysis.overview.name)}`, '');
  lines.push('## 1. Prerequisites', '');

  const engines = rootManifest(analysis);
  lines.push(`- **${commands.packageManager}** for dependency management`);
  if (engines?.ecosystem === 'npm') lines.push('- **Node.js** — check `engines` in `package.json` for the supported range');
  const database = analysis.stack.find((tech) => tech.category === 'database');
  if (database) lines.push(`- **${database.name}** running locally, or a connection string to a hosted instance`);
  lines.push('');

  lines.push('## 2. Clone and install', '', '```bash');
  lines.push(`git clone <repository-url>`);
  lines.push(`cd ${analysis.overview.name}`);
  lines.push(commands.install);
  lines.push('```', '');

  if (envVars.length > 0) {
    lines.push('## 3. Configure the environment', '');
    lines.push(
      'Create a `.env.local` file (or export these in your shell) with the following variables:',
      '',
      '```bash'
    );
    for (const variable of envVars.slice(0, 25)) {
      lines.push(`${variable.name}=`);
    }
    lines.push('```', '');
    gaps.push('Document which environment variables are required versus optional, and where to obtain each value.');
  }

  const step = envVars.length > 0 ? 4 : 3;
  if (analysis.schema.entities.length > 0) {
    lines.push(`## ${step}. Prepare the database`, '');
    lines.push(
      analysis.schema.dialect === 'prisma'
        ? 'Apply the schema:\n\n```bash\nnpx prisma migrate dev\n```'
        : `Apply the schema from ${analysis.schema.sources.map((source) => `\`${source}\``).join(', ')}.`,
      ''
    );
  }

  if (commands.dev) {
    lines.push(`## ${step + (analysis.schema.entities.length > 0 ? 1 : 0)}. Run it`, '', '```bash', commands.dev, '```', '');
  }

  if (commands.test) {
    lines.push('## Verify your setup', '', '```bash', commands.test, '```', '');
  }

  lines.push('## Troubleshooting', '');
  lines.push('_Document the failure modes new contributors actually hit here._', '');
  gaps.push('Add troubleshooting entries as contributors report setup problems.');

  return document('setup', `Setup guide — ${titleCase(analysis.overview.name)}`, lines.join('\n'), gaps, now);
}

export function generateDeploymentGuide(
  analysis: RepositoryAnalysis,
  now = Date.now()
): GeneratedDocument {
  const commands = inferCommands(analysis);
  const gaps: string[] = [];
  const lines: string[] = [];

  lines.push(`# Deployment — ${titleCase(analysis.overview.name)}`, '');

  const infrastructure = analysis.stack.filter((tech) => tech.category === 'infrastructure');
  const ci = analysis.stack.filter((tech) => tech.category === 'ci');

  lines.push('## Detected deployment surface', '');
  if (infrastructure.length === 0 && ci.length === 0) {
    lines.push('_No deployment configuration was detected in this repository._', '');
    gaps.push('Describe how and where this project is deployed.');
  } else {
    for (const tech of [...infrastructure, ...ci]) {
      lines.push(`- **${tech.name}** — ${tech.evidence[0]}`);
    }
    lines.push('');
  }

  if (commands.build) {
    lines.push('## Build', '', '```bash', commands.install, commands.build, '```', '');
  }
  if (commands.start) {
    lines.push('## Run', '', '```bash', commands.start, '```', '');
  }

  if (analysis.overview.hasDockerfile) {
    lines.push('## Container image', '', '```bash');
    lines.push(`docker build -t ${analysis.overview.name} .`);
    lines.push(`docker run --rm -p 3000:3000 --env-file .env ${analysis.overview.name}`);
    lines.push('```', '');
  }

  const envVars = analysis.environment;
  if (envVars.length > 0) {
    lines.push('## Environment', '');
    lines.push('These variables must be present in the deployment environment:', '');
    for (const variable of envVars.slice(0, 25)) lines.push(`- \`${variable.name}\``);
    lines.push('');
  }

  lines.push('## Pre-deployment checklist', '');
  lines.push(`- [ ] ${commands.test ? `\`${commands.test}\` passes` : 'Tests pass'}`);
  if (commands.build) lines.push(`- [ ] \`${commands.build}\` succeeds`);
  lines.push('- [ ] Secrets are supplied by the platform, not committed');
  lines.push('- [ ] Database migrations have been applied');
  lines.push('- [ ] A rollback path is documented and tested');
  lines.push('');

  lines.push('## Rollback', '');
  lines.push('_Document the exact rollback procedure — the middle of an incident is the wrong time to work it out._', '');
  gaps.push('Document the rollback procedure and who is on call.');

  return document('deployment', `Deployment — ${titleCase(analysis.overview.name)}`, lines.join('\n'), gaps, now);
}

/** Generate the full documentation set in one pass. */
export function generateAll(analysis: RepositoryAnalysis, now = Date.now()): GeneratedDocument[] {
  return [
    generateReadme(analysis, now),
    generateArchitecture(analysis, now),
    generateApiDocs(analysis, now),
    generateSetupGuide(analysis, now),
    generateDeploymentGuide(analysis, now),
  ];
}

export interface DocumentationCoverage {
  readonly score: number;
  readonly present: readonly string[];
  readonly missing: readonly string[];
}

/** How well documented the repository already is, before generation. */
export function assessDocumentation(analysis: RepositoryAnalysis): DocumentationCoverage {
  const checks: { name: string; present: boolean }[] = [
    { name: 'README', present: analysis.overview.hasReadme },
    { name: 'License', present: analysis.overview.hasLicense },
    { name: 'Contributing guide', present: analysis.overview.hasContributing },
    { name: 'Continuous integration', present: analysis.overview.hasCi },
    { name: 'Tests', present: analysis.overview.hasTests },
    { name: 'Inline documentation', present: analysis.overview.commentRatio >= 0.08 },
    { name: 'Project description', present: analysis.overview.description.length > 0 },
  ];

  const present = checks.filter((check) => check.present).map((check) => check.name);
  return {
    score: Math.round((present.length / checks.length) * 100),
    present,
    missing: checks.filter((check) => !check.present).map((check) => check.name),
  };
}
