/**
 * Gitignore-compatible path matching, implemented without a dependency.
 *
 * Supports the subset of the spec that matters for repository scanning:
 * anchored patterns (`/dist`), directory-only patterns (`build/`), globs (`*`,
 * `?`), globstars (`**`), character classes and negation (`!keep.me`).
 */
export interface IgnoreRule {
  readonly source: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly regex: RegExp;
}

/**
 * Directories and files that are never source code. Excluding these up front
 * is the single largest performance win in the scanner: on a typical Node
 * project it removes 95%+ of files before any content is read.
 */
export const DEFAULT_IGNORE: readonly string[] = [
  // Dependencies
  'node_modules/',
  'bower_components/',
  'vendor/',
  '.pnpm-store/',
  '.yarn/',
  'Pods/',
  // Build output
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  'target/',
  'bin/',
  'obj/',
  '*.min.js',
  '*.min.css',
  '*.map',
  // Environments and caches
  '.git/',
  '.hg/',
  '.svn/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.ruff_cache/',
  '.gradle/',
  '.idea/',
  '.vscode/',
  '.DS_Store',
  // Coverage and reports
  'coverage/',
  '.nyc_output/',
  'playwright-report/',
  'test-results/',
  // Lockfiles: enormous, and their information is read from the manifest instead
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'poetry.lock',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
];

const SPECIAL = /[.+^${}()|[\]\\]/g;

function patternToRegex(pattern: string): RegExp {
  let body = pattern;
  const anchored = body.startsWith('/');
  if (anchored) body = body.slice(1);

  let out = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i] as string;
    if (char === '*') {
      if (body[i + 1] === '*') {
        // `**/` matches zero or more path segments; a bare `**` matches anything.
        if (body[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '[') {
      const close = body.indexOf(']', i);
      if (close === -1) {
        out += '\\[';
      } else {
        const cls = body.slice(i + 1, close).replace(/^!/, '^');
        out += `[${cls}]`;
        i = close;
      }
    } else {
      out += char.replace(SPECIAL, '\\$&');
    }
  }

  // An unanchored pattern with no slash matches at any depth.
  const prefix = anchored || body.includes('/') ? '^' : '^(?:.*/)?';
  return new RegExp(`${prefix}${out}(?:/.*)?$`);
}

export function compileRule(line: string): IgnoreRule | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  const negated = trimmed.startsWith('!');
  let body = negated ? trimmed.slice(1) : trimmed;
  const directoryOnly = body.endsWith('/');
  if (directoryOnly) body = body.slice(0, -1);
  if (body === '') return null;

  return { source: trimmed, negated, directoryOnly, regex: patternToRegex(body) };
}

export interface Matcher {
  /** True when the path should be excluded. */
  ignores(path: string, isDirectory?: boolean): boolean;
  readonly rules: readonly IgnoreRule[];
}

export function createMatcher(patterns: Iterable<string>): Matcher {
  const rules: IgnoreRule[] = [];
  for (const pattern of patterns) {
    const rule = compileRule(pattern);
    if (rule) rules.push(rule);
  }

  return {
    rules,
    ignores(path: string, isDirectory = false): boolean {
      const normalized = path.replace(/^\.\//, '').replace(/^\/+/, '');
      let ignored = false;
      // Later rules win, which is how gitignore negation works.
      for (const rule of rules) {
        if (rule.directoryOnly && !isDirectory && !rule.regex.test(normalized)) continue;
        if (!rule.regex.test(normalized)) continue;
        if (rule.directoryOnly && !isDirectory) {
          // A directory-only rule still excludes files *inside* that directory,
          // which the trailing `(?:/.*)?` in the regex already handled.
          if (!new RegExp(rule.regex.source.replace('(?:/.*)?$', '/.*$')).test(normalized)) {
            continue;
          }
        }
        ignored = !rule.negated;
      }
      return ignored;
    },
  };
}

/** Parse the contents of a `.gitignore` file into patterns. */
export function parseGitignore(contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}
