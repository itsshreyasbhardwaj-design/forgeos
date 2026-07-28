import type { RepoSnapshot } from '../fs/types.js';
import { detectLanguage } from './languages.js';

/**
 * Environment variable discovery.
 *
 * Reads from three places, because each answers a different question:
 *
 *  - **Source code** — which variables the program actually reads.
 *  - **Example env files** — which the author intended to be configurable.
 *  - **Compose and CI files** — which the deployment supplies.
 *
 * A variable that appears only in code is an undocumented requirement, and a
 * variable that appears only in an example file is probably dead configuration.
 * Reporting where each was seen makes both cases visible.
 */
export interface EnvironmentVariable {
  readonly name: string;
  readonly files: readonly string[];
  readonly inCode: boolean;
  readonly documented: boolean;
  /** Default value declared in an example file, when present. */
  readonly example?: string;
}

const ACCESS_PATTERNS: readonly RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /os\.environ(?:\.get)?\(?\[?\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /System\.getenv\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /ENV\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g,
  /\bgetenv\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /\$\{\s*([A-Z][A-Z0-9_]{2,})\s*(?::-[^}]*)?\}/g,
];

const EXAMPLE_ENV_FILE = /(^|\/)\.env(\.(example|sample|template|local\.example))?$/i;
const DEPLOY_FILE = /(^|\/)(docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|\.github\/workflows\/[\w.-]+\.ya?ml|Dockerfile[\w.-]*|vercel\.json|fly\.toml|render\.yaml)$/i;

export function collectEnvironmentVariables(snapshot: RepoSnapshot): EnvironmentVariable[] {
  const inCode = new Map<string, Set<string>>();
  const documented = new Map<string, { files: Set<string>; example?: string }>();

  const noteCode = (name: string, file: string): void => {
    const bucket = inCode.get(name) ?? new Set<string>();
    bucket.add(file);
    inCode.set(name, bucket);
  };

  for (const file of snapshot.files) {
    if (file.text === null) continue;

    if (EXAMPLE_ENV_FILE.test(file.path)) {
      for (const rawLine of file.text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) continue;
        const match = /^(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*(.*)$/.exec(line);
        if (!match?.[1]) continue;
        const entry = documented.get(match[1]) ?? { files: new Set<string>() };
        entry.files.add(file.path);
        const value = (match[2] ?? '').trim().replace(/^["']|["']$/g, '');
        if (value !== '' && entry.example === undefined) entry.example = value;
        documented.set(match[1], entry);
      }
      continue;
    }

    const isSource = detectLanguage(file.path) !== undefined;
    const isDeploy = DEPLOY_FILE.test(file.path);
    if (!isSource && !isDeploy) continue;

    for (const pattern of ACCESS_PATTERNS) {
      const scanner = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = scanner.exec(file.text)) !== null) {
        const name = match[1];
        if (!name) continue;
        // Skip the handful of names that are ambient rather than configuration.
        if (name === 'NODE_ENV' && isDeploy) continue;
        noteCode(name, file.path);
      }
    }
  }

  const names = new Set([...inCode.keys(), ...documented.keys()]);

  return [...names]
    .map((name) => {
      const codeFiles = inCode.get(name);
      const docEntry = documented.get(name);
      return {
        name,
        files: [...new Set([...(codeFiles ?? []), ...(docEntry?.files ?? [])])].sort(),
        inCode: codeFiles !== undefined,
        documented: docEntry !== undefined,
        ...(docEntry?.example ? { example: docEntry.example } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Variables read by code but absent from any example file. */
export function undocumentedVariables(
  variables: readonly EnvironmentVariable[]
): EnvironmentVariable[] {
  return variables.filter((variable) => variable.inCode && !variable.documented);
}
