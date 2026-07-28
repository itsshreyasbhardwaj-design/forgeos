import type { RepoSnapshot } from '../fs/types.js';
import { stripComments } from '../analysis/complexity.js';
import { detectLanguage } from '../analysis/languages.js';

/**
 * HTTP API surface discovery.
 *
 * Finds the routes a repository actually exposes, across the frameworks that
 * dominate real codebases. Two discovery strategies are used because frameworks
 * split into two families:
 *
 *  - **Convention-based** (Next.js App Router, Nuxt): the *path on disk* is the
 *    route, and the exported HTTP verbs are the methods.
 *  - **Registration-based** (Express, Fastify, FastAPI, Flask, Gin, Spring):
 *    routes are declared in code and must be read from call expressions.
 */
export interface ApiRoute {
  readonly method: string;
  readonly path: string;
  readonly handler: string;
  readonly file: string;
  readonly line: number;
  readonly framework: string;
}

export interface ApiSurface {
  readonly routes: readonly ApiRoute[];
  readonly frameworks: readonly string[];
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

const TEST_OR_FIXTURE =
  /(\.|\/)(test|spec)\.[\w]+$|(^|\/)(tests?|__tests__|__fixtures__|__mocks__|e2e|cypress|fixtures)(\/|$)|fixtures?\.[\w]+$/i;

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Convert a Next.js App Router file path into its URL path.
 * `src/app/(marketing)/blog/[slug]/route.ts` -> `/blog/:slug`
 */
export function nextAppRoutePath(filePath: string): string | null {
  const match = /(?:^|\/)app\/(.*)\/route\.(ts|tsx|js|mjs)$/.exec(filePath);
  if (!match) return null;
  const segments = (match[1] ?? '')
    .split('/')
    .filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment) && !segment.startsWith('@'))
    .map((segment) => {
      const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
      if (catchAll) return `*${catchAll[1]}`;
      const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
      if (optionalCatchAll) return `*${optionalCatchAll[1]}`;
      const dynamic = /^\[(.+)\]$/.exec(segment);
      return dynamic ? `:${dynamic[1]}` : segment;
    });
  return `/${segments.join('/')}`;
}

/** Legacy Next.js Pages Router API routes. */
export function nextPagesRoutePath(filePath: string): string | null {
  const match = /(?:^|\/)pages\/api\/(.*)\.(ts|tsx|js|mjs)$/.exec(filePath);
  if (!match) return null;
  const segments = (match[1] ?? '')
    .replace(/\/index$/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const dynamic = /^\[(?:\.\.\.)?(.+?)\]$/.exec(segment);
      return dynamic ? `:${dynamic[1]}` : segment;
    });
  return `/api/${segments.join('/')}`.replace(/\/+$/, '') || '/api';
}

interface RegistrationRule {
  readonly framework: string;
  readonly pattern: RegExp;
  /** Capture groups: 1 = method (or a literal), 2 = path. */
  readonly literalMethod?: string;
}

const REGISTRATION_RULES: readonly RegistrationRule[] = [
  // app.get('/users', handler) — Express, Fastify, Hono, Koa router, Elysia.
  {
    framework: 'express',
    pattern: /\b(?:app|router|server|api|fastify|hono)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/g,
  },
  // @app.get("/users") — FastAPI.
  {
    framework: 'fastapi',
    pattern: /@\w+\.(get|post|put|patch|delete|head|options)\s*\(\s*['"]([^'"]+)['"]/g,
  },
  // @app.route("/users", methods=["POST"]) — Flask.
  {
    framework: 'flask',
    pattern: /@\w+\.route\s*\(\s*['"]([^'"]+)['"](?:[^)]*methods\s*=\s*\[([^\]]*)\])?/g,
  },
  // r.GET("/users", handler) — Gin, Echo, Chi.
  {
    framework: 'go-http',
    pattern: /\b\w+\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*"([^"]+)"/g,
  },
  // @GetMapping("/users") — Spring.
  {
    framework: 'spring',
    pattern: /@(Get|Post|Put|Patch|Delete)Mapping\s*\(\s*(?:value\s*=\s*)?"([^"]+)"/g,
  },
  // Rails-style routes.
  {
    framework: 'rails',
    pattern: /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gm,
  },
];

/**
 * Decide whether a registration rule may run against this file.
 *
 * Without this gate the rules are badly over-eager: a client-side `api.get('/repos')`
 * wrapper in a Next.js app matches the Express pattern, and a repository ends up
 * reporting Flask routes it does not have. A rule therefore only runs when the
 * framework is either declared as a dependency or imported by the file itself,
 * and language-specific rules only run against that language.
 */
function ruleApplies(
  rule: RegistrationRule,
  file: string,
  text: string,
  declared: ReadonlySet<string>
): boolean {
  const language = detectLanguage(file)?.id ?? '';

  switch (rule.framework) {
    case 'express':
      return (
        ['express', 'fastify', 'hono', 'koa', '@nestjs/core', '@hono/node-server'].some((name) =>
          declared.has(name)
        ) || /(?:from|require\()\s*['"](express|fastify|hono|koa)['"]/.test(text)
      );
    case 'fastapi':
      return declared.has('fastapi') || /\bfrom\s+fastapi\b/.test(text);
    case 'flask':
      return declared.has('flask') || /\bfrom\s+flask\b/.test(text);
    case 'go-http':
      return language === 'go';
    case 'spring':
      return language === 'java' || language === 'kotlin';
    case 'rails':
      return language === 'ruby' && /routes\.rb$/.test(file);
    default:
      return false;
  }
}

function extractRegistrations(
  file: string,
  text: string,
  declared: ReadonlySet<string>
): ApiRoute[] {
  const routes: ApiRoute[] = [];
  const source = stripComments(text, detectLanguage(file));

  for (const rule of REGISTRATION_RULES) {
    if (!ruleApplies(rule, file, text, declared)) continue;
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(source)) !== null) {
      const line = lineAt(source, match.index);

      if (rule.framework === 'flask') {
        const path = match[1] ?? '';
        const methods = (match[2] ?? '')
          .split(',')
          .map((method) => method.replace(/['"\s]/g, '').toUpperCase())
          .filter((method) => (HTTP_METHODS as readonly string[]).includes(method));
        for (const method of methods.length > 0 ? methods : ['GET']) {
          routes.push({ method, path: normalizePath(path), handler: '', file, line, framework: rule.framework });
        }
        continue;
      }

      const rawMethod = (match[1] ?? 'GET').toUpperCase();
      const method = rawMethod === 'ALL' ? 'ANY' : rawMethod;
      const path = match[2] ?? '';
      if (path === '') continue;
      routes.push({ method, path: normalizePath(path), handler: '', file, line, framework: rule.framework });

      if (pattern.lastIndex <= match.index) pattern.lastIndex = match.index + 1;
    }
  }

  return routes;
}

/** Normalise `{id}` and `<int:id>` parameter syntaxes to `:id`. */
function normalizePath(path: string): string {
  const normalized = path
    .replace(/\{(\w+)(?::[^}]+)?\}/g, ':$1')
    .replace(/<(?:\w+:)?(\w+)>/g, ':$1')
    .replace(/\/{2,}/g, '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/** Exported HTTP verb handlers in a Next.js route module. */
function nextExportedMethods(text: string): string[] {
  const methods: string[] = [];
  for (const method of HTTP_METHODS) {
    const pattern = new RegExp(
      `export\\s+(?:async\\s+)?(?:function\\s+${method}\\b|const\\s+${method}\\s*[:=])`
    );
    if (pattern.test(text)) methods.push(method);
  }
  return methods;
}

export function discoverApiSurface(
  snapshot: RepoSnapshot,
  declaredDependencies: readonly string[] = []
): ApiSurface {
  const declared = new Set(declaredDependencies.map((name) => name.toLowerCase()));
  const routes: ApiRoute[] = [];
  const frameworks = new Set<string>();

  for (const file of snapshot.files) {
    if (file.text === null) continue;
    // Test files and fixtures routinely embed framework snippets as sample
    // input. Those are not routes this repository serves.
    if (TEST_OR_FIXTURE.test(file.path)) continue;

    const appRoute = nextAppRoutePath(file.path);
    if (appRoute !== null) {
      const methods = nextExportedMethods(file.text);
      for (const method of methods.length > 0 ? methods : ['GET']) {
        routes.push({
          method,
          path: appRoute,
          handler: method,
          file: file.path,
          line: 1,
          framework: 'next-app',
        });
      }
      frameworks.add('next-app');
      continue;
    }

    const pagesRoute = nextPagesRoutePath(file.path);
    if (pagesRoute !== null) {
      routes.push({
        method: 'ANY',
        path: pagesRoute,
        handler: 'default',
        file: file.path,
        line: 1,
        framework: 'next-pages',
      });
      frameworks.add('next-pages');
      continue;
    }

    const registered = extractRegistrations(file.path, file.text, declared);
    for (const route of registered) {
      routes.push(route);
      frameworks.add(route.framework);
    }
  }

  const seen = new Set<string>();
  const deduped = routes.filter((route) => {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  return { routes: deduped, frameworks: [...frameworks].sort() };
}
