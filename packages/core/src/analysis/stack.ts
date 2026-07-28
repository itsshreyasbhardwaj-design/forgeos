import type { RepoSnapshot } from '../fs/types.js';
import type { PackageManifest } from './manifests.js';
import { basename } from './languages.js';

/**
 * Technology stack detection.
 *
 * Detection is evidence-based: every result names *why* it was detected, so a
 * wrong answer is debuggable rather than mysterious. Signals are weighted —
 * a declared dependency is stronger evidence than a matching filename.
 */
export type StackCategory =
  | 'language'
  | 'framework'
  | 'ui'
  | 'database'
  | 'testing'
  | 'build'
  | 'infrastructure'
  | 'ci'
  | 'auth'
  | 'observability';

export interface DetectedTechnology {
  readonly id: string;
  readonly name: string;
  readonly category: StackCategory;
  /** 0–1. Above 0.8 means a declared dependency was found. */
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly version?: string;
}

interface Signature {
  readonly id: string;
  readonly name: string;
  readonly category: StackCategory;
  readonly packages?: readonly string[];
  readonly files?: readonly string[];
  /** Regex matched against file paths. */
  readonly paths?: readonly RegExp[];
}

const SIGNATURES: readonly Signature[] = [
  // Frameworks
  { id: 'next', name: 'Next.js', category: 'framework', packages: ['next'], files: ['next.config.js', 'next.config.ts', 'next.config.mjs'] },
  { id: 'react', name: 'React', category: 'ui', packages: ['react'] },
  { id: 'vue', name: 'Vue', category: 'ui', packages: ['vue'], paths: [/\.vue$/] },
  { id: 'svelte', name: 'Svelte', category: 'ui', packages: ['svelte'], paths: [/\.svelte$/] },
  { id: 'angular', name: 'Angular', category: 'ui', packages: ['@angular/core'] },
  { id: 'solid', name: 'SolidJS', category: 'ui', packages: ['solid-js'] },
  { id: 'astro', name: 'Astro', category: 'framework', packages: ['astro'], files: ['astro.config.mjs'] },
  { id: 'remix', name: 'Remix', category: 'framework', packages: ['@remix-run/react'] },
  { id: 'nuxt', name: 'Nuxt', category: 'framework', packages: ['nuxt'] },
  { id: 'express', name: 'Express', category: 'framework', packages: ['express'] },
  { id: 'fastify', name: 'Fastify', category: 'framework', packages: ['fastify'] },
  { id: 'nest', name: 'NestJS', category: 'framework', packages: ['@nestjs/core'] },
  { id: 'hono', name: 'Hono', category: 'framework', packages: ['hono'] },
  { id: 'django', name: 'Django', category: 'framework', packages: ['django'], files: ['manage.py'] },
  { id: 'flask', name: 'Flask', category: 'framework', packages: ['flask'] },
  { id: 'fastapi', name: 'FastAPI', category: 'framework', packages: ['fastapi'] },
  { id: 'rails', name: 'Ruby on Rails', category: 'framework', packages: ['rails'], files: ['config/routes.rb'] },
  { id: 'spring', name: 'Spring Boot', category: 'framework', packages: ['org.springframework.boot:spring-boot-starter'] },
  { id: 'gin', name: 'Gin', category: 'framework', packages: ['github.com/gin-gonic/gin'] },
  { id: 'axum', name: 'Axum', category: 'framework', packages: ['axum'] },
  { id: 'laravel', name: 'Laravel', category: 'framework', packages: ['laravel/framework'] },

  // UI / styling
  { id: 'tailwind', name: 'Tailwind CSS', category: 'ui', packages: ['tailwindcss'], files: ['tailwind.config.js', 'tailwind.config.ts'] },
  { id: 'shadcn', name: 'shadcn/ui', category: 'ui', files: ['components.json'] },
  { id: 'mui', name: 'MUI', category: 'ui', packages: ['@mui/material'] },
  { id: 'chakra', name: 'Chakra UI', category: 'ui', packages: ['@chakra-ui/react'] },

  // Data
  { id: 'postgres', name: 'PostgreSQL', category: 'database', packages: ['pg', 'postgres', 'psycopg2', 'psycopg2-binary', 'asyncpg'] },
  { id: 'mysql', name: 'MySQL', category: 'database', packages: ['mysql', 'mysql2', 'pymysql'] },
  { id: 'sqlite', name: 'SQLite', category: 'database', packages: ['better-sqlite3', 'sqlite3'] },
  { id: 'mongodb', name: 'MongoDB', category: 'database', packages: ['mongodb', 'mongoose', 'pymongo'] },
  { id: 'redis', name: 'Redis', category: 'database', packages: ['redis', 'ioredis'] },
  { id: 'prisma', name: 'Prisma', category: 'database', packages: ['prisma', '@prisma/client'], paths: [/schema\.prisma$/] },
  { id: 'drizzle', name: 'Drizzle ORM', category: 'database', packages: ['drizzle-orm'] },
  { id: 'typeorm', name: 'TypeORM', category: 'database', packages: ['typeorm'] },
  { id: 'sqlalchemy', name: 'SQLAlchemy', category: 'database', packages: ['sqlalchemy'] },
  { id: 'supabase', name: 'Supabase', category: 'database', packages: ['@supabase/supabase-js'] },

  // Testing
  { id: 'vitest', name: 'Vitest', category: 'testing', packages: ['vitest'] },
  { id: 'jest', name: 'Jest', category: 'testing', packages: ['jest'] },
  { id: 'playwright', name: 'Playwright', category: 'testing', packages: ['@playwright/test', 'playwright'] },
  { id: 'cypress', name: 'Cypress', category: 'testing', packages: ['cypress'] },
  { id: 'pytest', name: 'pytest', category: 'testing', packages: ['pytest'] },
  { id: 'testing-library', name: 'Testing Library', category: 'testing', packages: ['@testing-library/react'] },

  // Build
  { id: 'vite', name: 'Vite', category: 'build', packages: ['vite'], files: ['vite.config.ts', 'vite.config.js'] },
  { id: 'webpack', name: 'Webpack', category: 'build', packages: ['webpack'] },
  { id: 'esbuild', name: 'esbuild', category: 'build', packages: ['esbuild'] },
  { id: 'turborepo', name: 'Turborepo', category: 'build', packages: ['turbo'], files: ['turbo.json'] },
  { id: 'nx', name: 'Nx', category: 'build', packages: ['nx'], files: ['nx.json'] },
  { id: 'pnpm', name: 'pnpm', category: 'build', files: ['pnpm-workspace.yaml', 'pnpm-lock.yaml'] },

  // Infrastructure
  { id: 'docker', name: 'Docker', category: 'infrastructure', files: ['Dockerfile', 'docker-compose.yml', 'compose.yaml'] },
  { id: 'kubernetes', name: 'Kubernetes', category: 'infrastructure', paths: [/(^|\/)k8s\//, /(^|\/)helm\//] },
  { id: 'terraform', name: 'Terraform', category: 'infrastructure', paths: [/\.tf$/] },
  { id: 'vercel', name: 'Vercel', category: 'infrastructure', files: ['vercel.json'] },
  { id: 'serverless', name: 'Serverless Framework', category: 'infrastructure', files: ['serverless.yml'] },

  // CI
  { id: 'github-actions', name: 'GitHub Actions', category: 'ci', paths: [/^\.github\/workflows\//] },
  { id: 'gitlab-ci', name: 'GitLab CI', category: 'ci', files: ['.gitlab-ci.yml'] },
  { id: 'circleci', name: 'CircleCI', category: 'ci', paths: [/^\.circleci\//] },

  // Auth / observability
  { id: 'clerk', name: 'Clerk', category: 'auth', packages: ['@clerk/nextjs', '@clerk/clerk-react'] },
  { id: 'auth0', name: 'Auth0', category: 'auth', packages: ['@auth0/nextjs-auth0'] },
  { id: 'nextauth', name: 'Auth.js', category: 'auth', packages: ['next-auth', '@auth/core'] },
  { id: 'sentry', name: 'Sentry', category: 'observability', packages: ['@sentry/node', '@sentry/nextjs'] },
  { id: 'opentelemetry', name: 'OpenTelemetry', category: 'observability', packages: ['@opentelemetry/api'] },
];

export function detectStack(
  snapshot: RepoSnapshot,
  manifests: readonly PackageManifest[]
): DetectedTechnology[] {
  const declared = new Map<string, { range: string; manifest: string }>();
  for (const manifest of manifests) {
    for (const dependency of manifest.dependencies) {
      const key = dependency.name.toLowerCase();
      if (!declared.has(key)) {
        declared.set(key, { range: dependency.range, manifest: manifest.path });
      }
    }
  }

  const fileNames = new Set(snapshot.files.map((file) => basename(file.path).toLowerCase()));
  const paths = snapshot.files.map((file) => file.path);
  const detected: DetectedTechnology[] = [];

  for (const signature of SIGNATURES) {
    const evidence: string[] = [];
    let confidence = 0;
    let version: string | undefined;

    for (const packageName of signature.packages ?? []) {
      const hit = declared.get(packageName.toLowerCase());
      if (!hit) continue;
      evidence.push(`declared as \`${packageName}\` in ${hit.manifest}`);
      confidence = Math.max(confidence, 0.95);
      version ??= hit.range;
    }

    for (const fileName of signature.files ?? []) {
      const base = basename(fileName).toLowerCase();
      if (!fileNames.has(base)) continue;
      // A path-qualified signature must actually match that path.
      if (fileName.includes('/') && !paths.some((path) => path.endsWith(fileName))) continue;
      evidence.push(`\`${fileName}\` present`);
      confidence = Math.max(confidence, 0.75);
    }

    for (const pattern of signature.paths ?? []) {
      const matches = paths.filter((path) => pattern.test(path));
      if (matches.length === 0) continue;
      evidence.push(`${matches.length} file(s) matching ${String(pattern)}`);
      confidence = Math.max(confidence, 0.7);
    }

    if (evidence.length === 0) continue;
    detected.push({
      id: signature.id,
      name: signature.name,
      category: signature.category,
      confidence: Math.min(1, confidence + (evidence.length - 1) * 0.02),
      evidence,
      ...(version ? { version } : {}),
    });
  }

  return detected.sort(
    (a, b) => b.confidence - a.confidence || a.category.localeCompare(b.category)
  );
}

/** The one-line "this is a X project" summary shown at the top of the UI. */
export function describeStack(technologies: readonly DetectedTechnology[]): string {
  const framework = technologies.find((tech) => tech.category === 'framework');
  const ui = technologies.find((tech) => tech.category === 'ui');
  const database = technologies.find((tech) => tech.category === 'database');
  const parts = [framework?.name, ui?.name, database?.name].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'No framework detected';
}
