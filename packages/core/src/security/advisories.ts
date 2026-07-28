import type { Dependency, Ecosystem } from '../analysis/manifests.js';
import { coerceVersion, isParseableRange, satisfies } from '../kernel/semver.js';

/**
 * Dependency vulnerability matching.
 *
 * ForgeOS ships a small **curated** advisory set covering high-impact,
 * widely-encountered vulnerabilities, so that a security scan produces real
 * results with no network access, no API key and no cost. It is deliberately
 * not a substitute for a full feed: {@link AdvisorySource} lets an operator
 * plug in OSV, GitHub Advisories or an internal mirror, and
 * {@link mergeAdvisorySets} combines them.
 *
 * Honesty about coverage is a feature. Every scan result reports which sources
 * were consulted, so nobody mistakes "no findings" for "audited".
 */
export type Severity = 'critical' | 'high' | 'moderate' | 'low';

export interface Advisory {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly ecosystem: Ecosystem;
  readonly package: string;
  /** Semver range of *affected* versions. */
  readonly vulnerableRange: string;
  /** First version containing the fix, when one exists. */
  readonly patchedVersion?: string;
  readonly severity: Severity;
  readonly summary: string;
  readonly cwe?: string;
  readonly references?: readonly string[];
}

export interface AdvisorySource {
  readonly name: string;
  /** Advisories for the given packages. May return a superset. */
  lookup(dependencies: readonly Dependency[]): Promise<readonly Advisory[]>;
}

/**
 * Curated advisories. Each entry describes a genuine, well-documented
 * vulnerability; ranges are expressed conservatively so a borderline version is
 * reported rather than silently cleared.
 */
export const BUNDLED_ADVISORIES: readonly Advisory[] = [
  // --- npm ---
  {
    id: 'FORGE-NPM-0001',
    aliases: ['CVE-2021-23337'],
    ecosystem: 'npm',
    package: 'lodash',
    vulnerableRange: '<4.17.21',
    patchedVersion: '4.17.21',
    severity: 'high',
    summary: 'Command injection via the template function.',
    cwe: 'CWE-94',
  },
  {
    id: 'FORGE-NPM-0002',
    aliases: ['CVE-2020-7598'],
    ecosystem: 'npm',
    package: 'minimist',
    vulnerableRange: '<1.2.6',
    patchedVersion: '1.2.6',
    severity: 'moderate',
    summary: 'Prototype pollution through crafted argument names.',
    cwe: 'CWE-1321',
  },
  {
    id: 'FORGE-NPM-0003',
    aliases: ['CVE-2022-25883'],
    ecosystem: 'npm',
    package: 'semver',
    vulnerableRange: '<7.5.2',
    patchedVersion: '7.5.2',
    severity: 'moderate',
    summary: 'Regular expression denial of service in range parsing.',
    cwe: 'CWE-1333',
  },
  {
    id: 'FORGE-NPM-0004',
    aliases: ['CVE-2021-3807'],
    ecosystem: 'npm',
    package: 'ansi-regex',
    vulnerableRange: '>=4.0.0 <5.0.1',
    patchedVersion: '5.0.1',
    severity: 'high',
    summary: 'Regular expression denial of service.',
    cwe: 'CWE-1333',
  },
  {
    id: 'FORGE-NPM-0005',
    aliases: ['CVE-2023-45857'],
    ecosystem: 'npm',
    package: 'axios',
    vulnerableRange: '<1.6.0',
    patchedVersion: '1.6.0',
    severity: 'moderate',
    summary: 'Cross-site request forgery token leaked to third-party hosts.',
    cwe: 'CWE-359',
  },
  {
    id: 'FORGE-NPM-0006',
    aliases: ['CVE-2025-29927'],
    ecosystem: 'npm',
    package: 'next',
    vulnerableRange: '>=11.1.4 <14.2.25 || >=15.0.0 <15.2.3',
    patchedVersion: '15.2.3',
    severity: 'critical',
    summary: 'Middleware authorization bypass via a crafted internal header.',
    cwe: 'CWE-285',
  },
  {
    id: 'FORGE-NPM-0007',
    aliases: ['CVE-2024-28863'],
    ecosystem: 'npm',
    package: 'tar',
    vulnerableRange: '<6.2.1',
    patchedVersion: '6.2.1',
    severity: 'moderate',
    summary: 'Denial of service when extracting deeply nested archives.',
    cwe: 'CWE-400',
  },
  {
    id: 'FORGE-NPM-0008',
    aliases: ['CVE-2022-23529'],
    ecosystem: 'npm',
    package: 'jsonwebtoken',
    vulnerableRange: '<9.0.0',
    patchedVersion: '9.0.0',
    severity: 'high',
    summary: 'Insecure default key handling permits signature bypass.',
    cwe: 'CWE-327',
  },
  {
    id: 'FORGE-NPM-0009',
    aliases: ['CVE-2022-0235'],
    ecosystem: 'npm',
    package: 'node-fetch',
    vulnerableRange: '<2.6.7',
    patchedVersion: '2.6.7',
    severity: 'high',
    summary: 'Authorization header forwarded across cross-origin redirects.',
    cwe: 'CWE-200',
  },
  {
    id: 'FORGE-NPM-0010',
    aliases: ['CVE-2024-29041'],
    ecosystem: 'npm',
    package: 'express',
    vulnerableRange: '<4.19.2',
    patchedVersion: '4.19.2',
    severity: 'moderate',
    summary: 'Open redirect through malformed URLs passed to res.location.',
    cwe: 'CWE-601',
  },
  {
    id: 'FORGE-NPM-0011',
    aliases: ['CVE-2022-24999'],
    ecosystem: 'npm',
    package: 'qs',
    vulnerableRange: '<6.10.3',
    patchedVersion: '6.10.3',
    severity: 'high',
    summary: 'Prototype pollution via crafted query strings.',
    cwe: 'CWE-1321',
  },
  {
    id: 'FORGE-NPM-0012',
    aliases: ['CVE-2020-28469'],
    ecosystem: 'npm',
    package: 'glob-parent',
    vulnerableRange: '<5.1.2',
    patchedVersion: '5.1.2',
    severity: 'high',
    summary: 'Regular expression denial of service.',
    cwe: 'CWE-1333',
  },
  {
    id: 'FORGE-NPM-0013',
    aliases: ['CVE-2021-23434'],
    ecosystem: 'npm',
    package: 'object-path',
    vulnerableRange: '<0.11.6',
    patchedVersion: '0.11.6',
    severity: 'high',
    summary: 'Prototype pollution in the set operation.',
    cwe: 'CWE-1321',
  },
  {
    id: 'FORGE-NPM-0014',
    aliases: ['CVE-2021-3749'],
    ecosystem: 'npm',
    package: 'ua-parser-js',
    vulnerableRange: '<0.7.24',
    patchedVersion: '0.7.24',
    severity: 'high',
    summary: 'Regular expression denial of service in user-agent parsing.',
    cwe: 'CWE-1333',
  },
  {
    id: 'FORGE-NPM-0015',
    aliases: ['CVE-2024-4068'],
    ecosystem: 'npm',
    package: 'braces',
    vulnerableRange: '<3.0.3',
    patchedVersion: '3.0.3',
    severity: 'high',
    summary: 'Uncontrolled resource consumption on crafted input.',
    cwe: 'CWE-400',
  },

  // --- PyPI ---
  {
    id: 'FORGE-PY-0001',
    aliases: ['CVE-2020-14343'],
    ecosystem: 'pypi',
    package: 'pyyaml',
    vulnerableRange: '<5.4',
    patchedVersion: '5.4',
    severity: 'critical',
    summary: 'Arbitrary code execution when loading untrusted YAML with the full loader.',
    cwe: 'CWE-20',
  },
  {
    id: 'FORGE-PY-0002',
    aliases: ['CVE-2023-32681'],
    ecosystem: 'pypi',
    package: 'requests',
    vulnerableRange: '>=2.3.0 <2.31.0',
    patchedVersion: '2.31.0',
    severity: 'moderate',
    summary: 'Proxy-Authorization header leaked on cross-origin redirect.',
    cwe: 'CWE-200',
  },
  {
    id: 'FORGE-PY-0003',
    aliases: ['CVE-2023-43804'],
    ecosystem: 'pypi',
    package: 'urllib3',
    vulnerableRange: '<1.26.17',
    patchedVersion: '1.26.17',
    severity: 'moderate',
    summary: 'Cookie header leaked on cross-origin redirect.',
    cwe: 'CWE-200',
  },
  {
    id: 'FORGE-PY-0004',
    aliases: ['CVE-2024-22195'],
    ecosystem: 'pypi',
    package: 'jinja2',
    vulnerableRange: '<3.1.3',
    patchedVersion: '3.1.3',
    severity: 'moderate',
    summary: 'Cross-site scripting through the xmlattr filter.',
    cwe: 'CWE-79',
  },
  {
    id: 'FORGE-PY-0005',
    aliases: ['CVE-2023-50447'],
    ecosystem: 'pypi',
    package: 'pillow',
    vulnerableRange: '<10.2.0',
    patchedVersion: '10.2.0',
    severity: 'high',
    summary: 'Arbitrary code execution through ImageMath.eval.',
    cwe: 'CWE-94',
  },
  {
    id: 'FORGE-PY-0006',
    aliases: ['CVE-2024-24680'],
    ecosystem: 'pypi',
    package: 'django',
    vulnerableRange: '>=3.2 <3.2.24 || >=4.2 <4.2.10 || >=5.0 <5.0.2',
    patchedVersion: '5.0.2',
    severity: 'high',
    summary: 'Denial of service in the intcomma template filter.',
    cwe: 'CWE-400',
  },
  {
    id: 'FORGE-PY-0007',
    aliases: ['CVE-2023-30861'],
    ecosystem: 'pypi',
    package: 'flask',
    vulnerableRange: '<2.2.5',
    patchedVersion: '2.2.5',
    severity: 'high',
    summary: 'Session cookie may be cached and disclosed by a proxy.',
    cwe: 'CWE-539',
  },
  {
    id: 'FORGE-PY-0008',
    aliases: ['CVE-2024-3772'],
    ecosystem: 'pypi',
    package: 'pydantic',
    vulnerableRange: '>=1.10.0 <1.10.13 || >=2.0.0 <2.4.0',
    patchedVersion: '2.4.0',
    severity: 'moderate',
    summary: 'Regular expression denial of service in email validation.',
    cwe: 'CWE-1333',
  },

  // --- Maven ---
  {
    id: 'FORGE-MVN-0001',
    aliases: ['CVE-2021-44228'],
    ecosystem: 'maven',
    package: 'org.apache.logging.log4j:log4j-core',
    vulnerableRange: '>=2.0.0 <2.17.1',
    patchedVersion: '2.17.1',
    severity: 'critical',
    summary: 'Remote code execution through JNDI lookup in log messages (Log4Shell).',
    cwe: 'CWE-502',
  },
  {
    id: 'FORGE-MVN-0002',
    aliases: ['CVE-2022-22965'],
    ecosystem: 'maven',
    package: 'org.springframework:spring-beans',
    vulnerableRange: '<5.3.18',
    patchedVersion: '5.3.18',
    severity: 'critical',
    summary: 'Remote code execution via data binding (Spring4Shell).',
    cwe: 'CWE-94',
  },
  {
    id: 'FORGE-MVN-0003',
    aliases: ['CVE-2020-36518'],
    ecosystem: 'maven',
    package: 'com.fasterxml.jackson.core:jackson-databind',
    vulnerableRange: '<2.13.2',
    patchedVersion: '2.13.2',
    severity: 'high',
    summary: 'Denial of service through deeply nested JSON.',
    cwe: 'CWE-787',
  },

  // --- Go ---
  {
    id: 'FORGE-GO-0001',
    aliases: ['CVE-2023-44487'],
    ecosystem: 'go',
    package: 'golang.org/x/net',
    vulnerableRange: '<0.17.0',
    patchedVersion: '0.17.0',
    severity: 'high',
    summary: 'HTTP/2 rapid reset denial of service.',
    cwe: 'CWE-400',
  },

  // --- Cargo ---
  {
    id: 'FORGE-CRT-0001',
    aliases: ['RUSTSEC-2020-0071'],
    ecosystem: 'cargo',
    package: 'time',
    vulnerableRange: '>=0.2.7 <0.2.23',
    patchedVersion: '0.2.23',
    severity: 'high',
    summary: 'Segmentation fault through unsound use of localtime_r.',
    cwe: 'CWE-125',
  },

  // --- Gem ---
  {
    id: 'FORGE-GEM-0001',
    aliases: ['CVE-2024-27285'],
    ecosystem: 'gem',
    package: 'rack',
    vulnerableRange: '<2.2.8',
    patchedVersion: '2.2.8',
    severity: 'high',
    summary: 'Denial of service parsing crafted multipart bodies.',
    cwe: 'CWE-400',
  },
];

/** The bundled set, exposed through the {@link AdvisorySource} interface. */
export const bundledAdvisorySource: AdvisorySource = {
  name: 'forgeos-bundled',
  async lookup(): Promise<readonly Advisory[]> {
    return BUNDLED_ADVISORIES;
  },
};

export interface VulnerabilityMatch {
  readonly advisory: Advisory;
  readonly dependency: Dependency;
  /** The concrete version tested, derived from the declared range. */
  readonly resolvedVersion: string;
  /**
   * `exact` when the manifest pins a version; `range` when the declared range
   * merely *permits* a vulnerable version. A range match is a real finding —
   * a fresh install can resolve to the vulnerable version — but it is weaker.
   */
  readonly matchKind: 'exact' | 'range';
  readonly fixAvailable: boolean;
}

const RANGE_PREFIX = /^[\^~>=<]/;

/**
 * Match dependencies against advisories.
 *
 * The subtlety is that manifests declare *ranges*, not versions. ForgeOS
 * resolves the range to the lowest version it permits — which is what a fresh
 * install with a cold lockfile would most likely produce — and reports the
 * match kind so the UI can distinguish "you are running this" from "you could
 * install this".
 */
export function matchVulnerabilities(
  dependencies: readonly Dependency[],
  advisories: readonly Advisory[]
): VulnerabilityMatch[] {
  const byKey = new Map<string, Advisory[]>();
  for (const advisory of advisories) {
    const key = `${advisory.ecosystem}:${advisory.package.toLowerCase()}`;
    const bucket = byKey.get(key) ?? [];
    bucket.push(advisory);
    byKey.set(key, bucket);
  }

  const matches: VulnerabilityMatch[] = [];

  for (const dependency of dependencies) {
    const candidates = byKey.get(`${dependency.ecosystem}:${dependency.name.toLowerCase()}`);
    if (!candidates) continue;

    const resolved = coerceVersion(dependency.range);
    if (!resolved) continue;

    const matchKind: VulnerabilityMatch['matchKind'] = RANGE_PREFIX.test(dependency.range.trim())
      ? 'range'
      : 'exact';

    for (const advisory of candidates) {
      if (!isParseableRange(advisory.vulnerableRange)) continue;
      if (!satisfies(resolved, advisory.vulnerableRange)) continue;
      matches.push({
        advisory,
        dependency,
        resolvedVersion: resolved,
        matchKind,
        fixAvailable: advisory.patchedVersion !== undefined,
      });
    }
  }

  const order: Record<Severity, number> = { critical: 0, high: 1, moderate: 2, low: 3 };
  return matches.sort(
    (a, b) =>
      order[a.advisory.severity] - order[b.advisory.severity] ||
      a.dependency.name.localeCompare(b.dependency.name)
  );
}

/** Combine advisory sets, preferring the first occurrence of each id/alias. */
export function mergeAdvisorySets(...sets: readonly (readonly Advisory[])[]): Advisory[] {
  const seen = new Set<string>();
  const merged: Advisory[] = [];
  for (const set of sets) {
    for (const advisory of set) {
      const keys = [advisory.id, ...(advisory.aliases ?? [])];
      if (keys.some((key) => seen.has(key))) continue;
      for (const key of keys) seen.add(key);
      merged.push(advisory);
    }
  }
  return merged;
}

/**
 * An {@link AdvisorySource} backed by the public OSV API.
 *
 * Not used unless an operator opts in: ForgeOS must work with no network
 * access, and a security scan that silently phones out with the caller's
 * dependency list is a privacy problem in its own right.
 */
export function createOsvSource(
  fetchImpl: typeof fetch = fetch,
  endpoint = 'https://api.osv.dev/v1/querybatch'
): AdvisorySource {
  const ECOSYSTEM_NAMES: Record<Ecosystem, string> = {
    npm: 'npm',
    pypi: 'PyPI',
    go: 'Go',
    cargo: 'crates.io',
    maven: 'Maven',
    gem: 'RubyGems',
    composer: 'Packagist',
    nuget: 'NuGet',
  };

  return {
    name: 'osv.dev',
    async lookup(dependencies) {
      const queries = dependencies
        .map((dependency) => ({
          version: coerceVersion(dependency.range),
          package: {
            name: dependency.name,
            ecosystem: ECOSYSTEM_NAMES[dependency.ecosystem],
          },
          dependency,
        }))
        .filter((query) => query.version !== null);

      if (queries.length === 0) return [];

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          queries: queries.map(({ version, package: pkg }) => ({ version, package: pkg })),
        }),
      });
      if (!response.ok) return [];

      const body = (await response.json()) as {
        results?: { vulns?: { id: string; summary?: string; severity?: { score?: string }[] }[] }[];
      };

      const advisories: Advisory[] = [];
      body.results?.forEach((result, index) => {
        const query = queries[index];
        if (!query) return;
        for (const vulnerability of result.vulns ?? []) {
          advisories.push({
            id: vulnerability.id,
            ecosystem: query.dependency.ecosystem,
            package: query.dependency.name,
            // OSV already decided the version is affected, so pin the range.
            vulnerableRange: `=${query.version}`,
            severity: normaliseOsvSeverity(vulnerability.severity?.[0]?.score),
            summary: vulnerability.summary ?? 'See the referenced advisory for details.',
            references: [`https://osv.dev/vulnerability/${vulnerability.id}`],
          });
        }
      });
      return advisories;
    },
  };
}

function normaliseOsvSeverity(score: string | undefined): Severity {
  if (!score) return 'moderate';
  const numeric = Number.parseFloat(score);
  if (Number.isFinite(numeric)) {
    if (numeric >= 9) return 'critical';
    if (numeric >= 7) return 'high';
    if (numeric >= 4) return 'moderate';
    return 'low';
  }
  const upper = score.toUpperCase();
  if (upper.includes('CRITICAL')) return 'critical';
  if (upper.includes('HIGH')) return 'high';
  if (upper.includes('LOW')) return 'low';
  return 'moderate';
}
