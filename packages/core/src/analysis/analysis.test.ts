import { describe, expect, it } from 'vitest';
import { snapshotFromEntries } from '../fs/scan.js';
import {
  countLines,
  detectLanguage,
  summariseLanguages,
} from './languages.js';
import {
  cyclomaticComplexity,
  extractFunctions,
  maintainabilityIndex,
  maxNestingDepth,
  stripComments,
  stripNonCode,
} from './complexity.js';
import { extractImports, parsePathAliases, resolveSpecifier } from './imports.js';
import { collectManifests, parseSimpleToml } from './manifests.js';
import { detectStack } from './stack.js';
import { collectEnvironmentVariables, undocumentedVariables } from './environment.js';
import { analyseRepository } from './repository.js';

const TS = detectLanguage('a.ts');

describe('language detection and line counting', () => {
  it('distinguishes code, comment and blank lines', () => {
    const counts = countLines(
      ['// a comment', '', 'const x = 1;', '/* block', '   continues */', 'run();'].join('\n'),
      TS
    );
    expect(counts).toEqual({ total: 6, code: 2, comment: 3, blank: 1 });
  });

  it('does not treat a URL inside a string as a line comment', () => {
    const counts = countLines('const url = "https://example.com/path";', TS);
    expect(counts.code).toBe(1);
    expect(counts.comment).toBe(0);
  });

  it('closes a same-line block comment rather than swallowing the file', () => {
    const counts = countLines(['const a = 1; /* note */', 'const b = 2;'].join('\n'), TS);
    expect(counts.code).toBe(2);
  });

  it('recognises files by name as well as extension', () => {
    expect(detectLanguage('Dockerfile')?.id).toBe('dockerfile');
    expect(detectLanguage('src/app/page.tsx')?.id).toBe('tsx');
    expect(detectLanguage('notes.unknownext')).toBeUndefined();
  });

  it('reports language shares that sum to about 100 percent', () => {
    const breakdown = summariseLanguages([
      { path: 'a.ts', text: 'const a = 1;\nconst b = 2;', bytes: 20 },
      { path: 'b.py', text: 'x = 1', bytes: 6 },
    ]);
    const total = breakdown.reduce((sum, entry) => sum + entry.percentage, 0);
    expect(Math.round(total)).toBe(100);
  });
});

describe('complexity', () => {
  it('counts one decision point per branch keyword', () => {
    expect(cyclomaticComplexity('function f() { return 1; }', TS)).toBe(1);
    expect(cyclomaticComplexity('function f(a) { if (a) return 1; return 2; }', TS)).toBe(2);
  });

  // Regression: counting each operator with its own regex matched `??` and then
  // matched `?` twice inside it, inflating one operator into three branches.
  it('counts a nullish coalescing operator exactly once', () => {
    expect(cyclomaticComplexity('const x = a ?? b;', TS)).toBe(2);
    expect(cyclomaticComplexity('const x = a || b;', TS)).toBe(2);
    expect(cyclomaticComplexity('const x = a ? b : c;', TS)).toBe(2);
  });

  it('ignores branch-like tokens inside strings and comments', () => {
    expect(cyclomaticComplexity('const s = "if && || ??";', TS)).toBe(1);
    expect(cyclomaticComplexity('// if (a) { } else if (b) { }\nconst x = 1;', TS)).toBe(1);
  });

  it('measures nesting depth', () => {
    expect(maxNestingDepth('function f() { if (a) { while (b) { c(); } } }', TS)).toBe(3);
  });

  it('extracts functions with their own complexity', () => {
    const source = [
      'export function alpha(a, b) {',
      '  if (a) return 1;',
      '  return 2;',
      '}',
      '',
      'function beta() {',
      '  return 3;',
      '}',
    ].join('\n');

    const functions = extractFunctions(source, TS);
    const names = functions.map((fn) => fn.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');

    const alpha = functions.find((fn) => fn.name === 'alpha');
    expect(alpha?.parameters).toBe(2);
    expect(alpha?.complexity).toBe(2);
  });

  it('extracts Python functions by indentation', () => {
    const python = detectLanguage('m.py');
    const functions = extractFunctions(
      ['def outer(a, b):', '    if a:', '        return b', '    return 0', '', 'x = 1'].join('\n'),
      python
    );
    expect(functions).toHaveLength(1);
    expect(functions[0]?.name).toBe('outer');
    expect(functions[0]?.parameters).toBe(2);
  });

  // Regression: the Halstead-derived index drove every large file to zero,
  // making it useless for ranking.
  it('does not collapse to zero for large but simple files', () => {
    expect(maintainabilityIndex(1200, 60, 0.1, 2)).toBeGreaterThan(50);
    expect(maintainabilityIndex(60, 40, 0, 8)).toBeLessThan(45);
    expect(maintainabilityIndex(0, 0, 0, 0)).toBe(100);
  });
});

describe('stripping', () => {
  it('removes string contents for metrics but keeps them for imports', () => {
    const source = `import x from './foo';`;
    expect(stripNonCode(source, TS)).toBe(`import x from '';`);
    expect(stripComments(source, TS)).toBe(source);
  });

  it('preserves line structure so line numbers stay accurate', () => {
    const source = ['/*', ' * comment', ' */', 'const a = 1;'].join('\n');
    expect(stripNonCode(source, TS).split('\n')).toHaveLength(4);
  });
});

describe('imports', () => {
  // Regression: extraction ran on a version of the source with string contents
  // removed, so every specifier was empty and the graph had zero edges.
  it('extracts specifiers rather than empty strings', () => {
    const imports = extractImports(
      'a.ts',
      [
        `import a from './alpha';`,
        `import type { B } from '../beta';`,
        `export * from './gamma';`,
        `const d = await import('./delta');`,
        `const e = require('./epsilon');`,
        `// import z from './commented-out';`,
      ].join('\n')
    );

    const specifiers = imports.map((entry) => entry.specifier);
    expect(specifiers).toContain('./alpha');
    expect(specifiers).toContain('../beta');
    expect(specifiers).toContain('./gamma');
    expect(specifiers).toContain('./delta');
    expect(specifiers).toContain('./epsilon');
    expect(specifiers).not.toContain('./commented-out');
  });

  it('extracts Python imports including relative ones', () => {
    const imports = extractImports('pkg/mod.py', ['from .sibling import thing', 'import os'].join('\n'));
    expect(imports.map((entry) => entry.specifier)).toEqual(
      expect.arrayContaining(['.sibling', 'os'])
    );
  });

  it('resolves extensions, index files and TypeScript .js specifiers', () => {
    const index = new Set([
      'src/alpha.ts',
      'src/beta/index.ts',
      'src/gamma.ts',
      'pkg/__init__.py',
      'pkg/sibling.py',
    ]);

    expect(resolveSpecifier('src/main.ts', './alpha', index)).toBe('src/alpha.ts');
    expect(resolveSpecifier('src/main.ts', './beta', index)).toBe('src/beta/index.ts');
    expect(resolveSpecifier('src/main.ts', './gamma.js', index)).toBe('src/gamma.ts');
    expect(resolveSpecifier('pkg/mod.py', '.sibling', index)).toBe('pkg/sibling.py');
    expect(resolveSpecifier('src/main.ts', 'react', index)).toBeNull();
  });

  // Regression: a regex comment-stripper ate the `/*` inside the `paths` glob,
  // so tsconfig aliases never parsed and `@/x` imports looked external.
  it('parses tsconfig path aliases despite globs and comments', () => {
    const aliases = parsePathAliases(
      `{
        // the app uses a root alias
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "@/*": ["./src/*"] },
        }
      }`
    );
    expect(aliases.get('@')).toBe('src');

    const index = new Set(['src/lib/utils.ts']);
    expect(resolveSpecifier('src/app/page.tsx', '@/lib/utils', index, aliases)).toBe(
      'src/lib/utils.ts'
    );
  });
});

describe('manifests and stack detection', () => {
  it('parses npm dependencies with their scopes', () => {
    const snapshot = snapshotFromEntries({
      'package.json': JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        dependencies: { express: '4.18.2' },
        devDependencies: { vitest: '^1.0.0' },
      }),
    });

    const [manifest] = collectManifests(snapshot);
    expect(manifest?.name).toBe('demo');
    expect(manifest?.dependencies).toHaveLength(2);
    expect(manifest?.dependencies.find((d) => d.name === 'vitest')?.scope).toBe('development');
  });

  it('parses requirements and pyproject files', () => {
    const snapshot = snapshotFromEntries({
      'requirements.txt': 'requests==2.28.0\n# comment\nflask>=2.0\n',
      'pyproject.toml': '[project]\nname = "demo"\ndependencies = ["httpx>=0.27"]\n',
    });
    const manifests = collectManifests(snapshot);
    const names = manifests.flatMap((manifest) => manifest.dependencies.map((d) => d.name));
    expect(names).toEqual(expect.arrayContaining(['requests', 'flask', 'httpx']));
  });

  it('reads simple TOML sections', () => {
    const sections = parseSimpleToml('[package]\nname = "x"\n\n[dependencies]\nserde = "1.0"');
    expect(sections.get('package')?.get('name')).toBe('x');
    expect(sections.get('dependencies')?.get('serde')).toBe('1.0');
  });

  it('detects a stack and explains why', () => {
    const snapshot = snapshotFromEntries({
      'package.json': JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }),
      'next.config.ts': 'export default {};',
    });
    const stack = detectStack(snapshot, collectManifests(snapshot));
    const next = stack.find((tech) => tech.id === 'next');
    expect(next).toBeDefined();
    expect(next?.confidence).toBeGreaterThan(0.9);
    expect(next?.evidence.join(' ')).toContain('package.json');
  });
});

describe('environment variables', () => {
  it('separates variables read by code from those merely documented', () => {
    const snapshot = snapshotFromEntries({
      '.env.example': 'DATABASE_URL=\nUNUSED_SETTING=1\n',
      'src/app.ts': 'const url = process.env.DATABASE_URL;\nconst key = process.env.SECRET_KEY;',
    });

    const variables = collectEnvironmentVariables(snapshot);
    const names = variables.map((variable) => variable.name);
    expect(names).toEqual(expect.arrayContaining(['DATABASE_URL', 'SECRET_KEY', 'UNUSED_SETTING']));

    expect(undocumentedVariables(variables).map((variable) => variable.name)).toEqual(['SECRET_KEY']);
  });
});

describe('repository analysis', () => {
  const snapshot = snapshotFromEntries({
    'package.json': JSON.stringify({
      name: 'demo-service',
      description: 'A demo.',
      dependencies: { express: '4.18.2' },
    }),
    'src/index.ts': `import { serve } from './server';\nserve();`,
    'src/server.ts': `import { handler } from './handler';\nexport function serve() { handler(); }`,
    'src/handler.ts': `import { serve } from './server';\nexport function handler() { serve(); }`,
    'README.md': '# Demo\n\nA demo service.\n',
  });

  it('produces a coherent overview', () => {
    const analysis = analyseRepository(snapshot);
    expect(analysis.overview.name).toBeTruthy();
    expect(analysis.overview.description).toBe('A demo.');
    expect(analysis.overview.hasReadme).toBe(true);
    expect(analysis.overview.code).toBeGreaterThan(0);
    expect(analysis.languages[0]?.name).toBe('TypeScript');
  });

  it('builds a module graph and finds the planted cycle', () => {
    const analysis = analyseRepository(snapshot);
    expect(analysis.graph.nodes.length).toBe(3);
    expect(analysis.graph.edges.length).toBeGreaterThanOrEqual(3);
    expect(analysis.cycles).toHaveLength(1);
    expect(analysis.cycles[0]?.cycle).toEqual(
      expect.arrayContaining(['src/server.ts', 'src/handler.ts'])
    );
  });

  // Regression: markdown and configuration files were treated as modules,
  // producing findings like "README.md is possibly unreachable".
  it('keeps documentation out of the module graph', () => {
    const analysis = analyseRepository(snapshot);
    expect(analysis.graph.nodes.map((node) => node.path)).not.toContain('README.md');
    expect(analysis.debt.findings.map((finding) => finding.file)).not.toContain('README.md');
  });

  it('is deterministic for the same input', () => {
    const first = analyseRepository(snapshot, { now: () => 1_000 });
    const second = analyseRepository(snapshot, { now: () => 1_000 });
    expect(first.id).toBe(second.id);
    expect(first.debt.score).toBe(second.debt.score);
    expect(first.graph.edges).toEqual(second.graph.edges);
  });

  it('scores an empty repository as healthy rather than crashing', () => {
    const empty = analyseRepository(snapshotFromEntries({}));
    expect(empty.overview.files).toBe(0);
    expect(empty.debt.score).toBeGreaterThan(90);
  });
});
