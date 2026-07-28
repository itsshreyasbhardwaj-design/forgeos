import { describe, expect, it } from 'vitest';
import { snapshotFromEntries } from '../fs/scan.js';
import { analyseRepository } from '../analysis/repository.js';
import {
  assessDocumentation,
  generateAll,
  generateApiDocs,
  generateArchitecture,
  generateDeploymentGuide,
  generateReadme,
  generateSetupGuide,
  inferCommands,
} from './generate.js';

const snapshot = snapshotFromEntries({
  'package.json': JSON.stringify({
    name: 'orders-service',
    version: '1.0.0',
    description: 'Order capture for the storefront.',
    license: 'MIT',
    scripts: { dev: 'next dev', build: 'next build', test: 'vitest run', lint: 'eslint .' },
    dependencies: { next: '15.0.0', react: '19.0.0', pg: '8.11.3' },
  }),
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
  'src/server.ts': `import { registerRoutes } from './api/routes';\nregisterRoutes();`,
  'src/api/routes.ts': [
    `import express from 'express';`,
    `const app = express();`,
    `app.get('/orders', handler);`,
    `app.post('/orders', handler);`,
    `function handler() { return null; }`,
  ].join('\n'),
  'migrations/001.sql': [
    'CREATE TABLE customers (id UUID PRIMARY KEY, email TEXT NOT NULL);',
    'CREATE TABLE orders (id UUID PRIMARY KEY, customer_id UUID REFERENCES customers, total NUMERIC);',
  ].join('\n'),
  '.env.example': 'DATABASE_URL=\nPORT=3000\n',
  'src/config.ts': 'export const url = process.env.DATABASE_URL;\nexport const key = process.env.API_KEY;',
  'README.md': '# orders-service\n\nOrder capture for the storefront.\n',
});

const analysis = analyseRepository(snapshot);

describe('command inference', () => {
  it('reads the scripts a project actually declares', () => {
    const commands = inferCommands(analysis);
    expect(commands.packageManager).toBe('pnpm');
    expect(commands.install).toBe('pnpm install');
    expect(commands.dev).toBe('pnpm dev');
    expect(commands.test).toBe('pnpm test');
  });

  it('falls back sensibly for an unrecognised project', () => {
    const bare = analyseRepository(snapshotFromEntries({ 'main.c': 'int main(){return 0;}' }));
    expect(inferCommands(bare).packageManager).toBe('unknown');
  });
});

describe('README generation', () => {
  const readme = generateReadme(analysis, 1_000);

  it('uses the real description and stack rather than a placeholder', () => {
    expect(readme.markdown).toContain('Order capture for the storefront.');
    expect(readme.markdown).toContain('Next.js');
    expect(readme.markdown).toContain('pnpm install');
  });

  it('reports measured size', () => {
    expect(readme.markdown).toMatch(/\d+ files and \d+ lines of code/);
  });

  it('documents the routes it discovered', () => {
    expect(readme.markdown).toContain('/orders');
  });

  it('is deterministic and content-addressed', () => {
    const again = generateReadme(analysis, 1_000);
    expect(again.hash).toBe(readme.hash);
    expect(again.id).toBe(readme.id);
  });

  it('flags an undocumented environment variable rather than inventing a description', () => {
    // API_KEY is read by code but absent from .env.example.
    expect(readme.gaps.join(' ')).toContain('API_KEY');
  });
});

describe('the other generators', () => {
  it('describes architecture from the graph, not from assumption', () => {
    const document = generateArchitecture(analysis, 1_000);
    expect(document.markdown).toContain('```mermaid');
    expect(document.markdown).toContain('Data model');
    expect(document.markdown).toContain('customers');
  });

  it('documents each endpoint with a runnable example', () => {
    const document = generateApiDocs(analysis, 1_000);
    expect(document.markdown).toContain('GET /orders');
    expect(document.markdown).toContain('curl -X GET');
    expect(document.gaps.join(' ')).toMatch(/schema/i);
  });

  it('says plainly when there is no API to document', () => {
    const bare = analyseRepository(snapshotFromEntries({ 'a.ts': 'export const a = 1;' }));
    expect(generateApiDocs(bare, 1_000).markdown).toContain('No HTTP endpoints');
  });

  it('writes a setup guide with the real install and run commands', () => {
    const document = generateSetupGuide(analysis, 1_000);
    expect(document.markdown).toContain('pnpm install');
    expect(document.markdown).toContain('DATABASE_URL');
    expect(document.markdown).toContain('PostgreSQL');
  });

  it('writes a deployment guide with a rollback prompt', () => {
    const document = generateDeploymentGuide(analysis, 1_000);
    expect(document.markdown).toContain('Pre-deployment checklist');
    expect(document.gaps.join(' ')).toMatch(/rollback/i);
  });

  it('generates the whole set in one pass', () => {
    const documents = generateAll(analysis, 1_000);
    expect(documents.map((document) => document.kind)).toEqual([
      'readme',
      'architecture',
      'api',
      'setup',
      'deployment',
    ]);
    expect(documents.every((document) => document.wordCount > 20)).toBe(true);
  });
});

describe('documentation coverage', () => {
  it('scores what the repository already has', () => {
    const coverage = assessDocumentation(analysis);
    expect(coverage.present).toContain('README');
    expect(coverage.present).toContain('Project description');
    // A `license` field in package.json is not a LICENSE file, and the checker
    // is right not to conflate them.
    expect(coverage.missing).toContain('License');
    expect(coverage.missing).toContain('Tests');
    expect(coverage.score).toBeGreaterThan(0);
    expect(coverage.score).toBeLessThan(100);
  });

  it('reports zero for a repository with nothing', () => {
    const bare = analyseRepository(snapshotFromEntries({ 'a.ts': 'export const a = 1;' }));
    expect(assessDocumentation(bare).score).toBe(0);
  });
});
