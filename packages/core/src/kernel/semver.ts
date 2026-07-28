/**
 * Just enough semantic versioning to power dependency vulnerability matching.
 *
 * Supports the range syntax that actually appears in real manifests: exact
 * versions, `^`, `~`, comparison operators, hyphen ranges, `||` alternatives,
 * `*`/`x` wildcards and `latest`. Anything unrecognised is treated as
 * non-matching rather than throwing — an unparseable range must never crash a
 * security scan of an otherwise healthy repository.
 */
export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}

const VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(input: string): SemVer | null {
  const match = VERSION_PATTERN.exec(input.trim());
  if (!match) return null;
  const prerelease = (match[4] ?? '')
    .split('.')
    .filter((part) => part.length > 0)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease,
  };
}

function comparePrerelease(a: SemVer, b: SemVer): number {
  // A version without a prerelease outranks one with a prerelease.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1;
    if (typeof left === 'number') return -1;
    if (typeof right === 'number') return 1;
    return String(left) < String(right) ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a, b);
}

/** Sort helper for version strings. Unparseable versions sort last. */
export function compareVersionStrings(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left && !right) return a.localeCompare(b);
  if (!left) return 1;
  if (!right) return -1;
  return compareVersions(left, right);
}

interface Comparator {
  readonly operator: '<' | '<=' | '>' | '>=' | '=';
  readonly version: SemVer;
}

function comparator(operator: Comparator['operator'], version: SemVer): Comparator {
  return { operator, version };
}

function nextMajor(v: SemVer): SemVer {
  return { major: v.major + 1, minor: 0, patch: 0, prerelease: [] };
}

function nextMinor(v: SemVer): SemVer {
  return { major: v.major, minor: v.minor + 1, patch: 0, prerelease: [] };
}

/** Expand a single range token into a conjunction of comparators. */
function expand(token: string): Comparator[] | null {
  const trimmed = token.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'latest') return [];

  const caret = /^\^\s*(.+)$/.exec(trimmed);
  if (caret) {
    const base = parseVersion(caret[1] ?? '');
    if (!base) return null;
    // ^0.2.3 allows >=0.2.3 <0.3.0; ^0.0.3 allows only patch-level 0.0.x.
    const upper =
      base.major > 0 ? nextMajor(base) : base.minor > 0 ? nextMinor(base) : nextMinor(base);
    return [comparator('>=', base), comparator('<', upper)];
  }

  const tilde = /^~\s*(.+)$/.exec(trimmed);
  if (tilde) {
    const base = parseVersion(tilde[1] ?? '');
    if (!base) return null;
    return [comparator('>=', base), comparator('<', nextMinor(base))];
  }

  const operatorMatch = /^(>=|<=|>|<|=)\s*(.+)$/.exec(trimmed);
  if (operatorMatch) {
    const base = parseVersion(operatorMatch[2] ?? '');
    if (!base) return null;
    return [comparator(operatorMatch[1] as Comparator['operator'], base)];
  }

  // Partial versions behave as wildcards: `1.2` means >=1.2.0 <1.3.0.
  const partial = /^v?(\d+)(?:\.(\d+))?(?:\.([x*]))?$/.exec(trimmed);
  if (partial && (partial[2] === undefined || partial[3] !== undefined)) {
    const base = parseVersion(trimmed.replace(/\.[x*]$/, ''));
    if (!base) return null;
    const upper = partial[2] === undefined ? nextMajor(base) : nextMinor(base);
    return [comparator('>=', base), comparator('<', upper)];
  }

  const exact = parseVersion(trimmed);
  return exact ? [comparator('=', exact)] : null;
}

function satisfiesComparator(version: SemVer, c: Comparator): boolean {
  const cmp = compareVersions(version, c.version);
  switch (c.operator) {
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '=':
      return cmp === 0;
  }
}

/**
 * Does `version` satisfy `range`?
 *
 * Returns `false` for input it cannot understand. Callers that need to
 * distinguish "not affected" from "could not determine" should pre-parse the
 * range with {@link isParseableRange}.
 */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;

  for (const alternative of range.split('||')) {
    const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alternative);
    if (hyphen) {
      const low = parseVersion(hyphen[1] ?? '');
      const high = parseVersion(hyphen[2] ?? '');
      if (low && high && compareVersions(parsed, low) >= 0 && compareVersions(parsed, high) <= 0) {
        return true;
      }
      continue;
    }

    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    const comparators: Comparator[] = [];
    let usable = true;
    for (const token of tokens) {
      const expanded = expand(token);
      if (expanded === null) {
        usable = false;
        break;
      }
      comparators.push(...expanded);
    }
    if (!usable) continue;
    if (comparators.every((c) => satisfiesComparator(parsed, c))) return true;
  }
  return false;
}

export function isParseableRange(range: string): boolean {
  return range
    .split('||')
    .some((alt) =>
      alt
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .every((token) => expand(token) !== null)
    );
}

/** Strip range syntax down to the version it is anchored on, for display. */
export function coerceVersion(range: string): string | null {
  const match = /(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)/.exec(range);
  if (!match) return null;
  const parsed = parseVersion(match[1] ?? '');
  return parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : null;
}
