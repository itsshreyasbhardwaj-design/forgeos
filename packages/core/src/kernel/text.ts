/** Text utilities shared by search, documentation and the AI layer. */

/**
 * English stop words plus the tokens that dominate source code and would
 * otherwise swamp every relevance score.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have', 'if', 'in',
  'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'then', 'this', 'to', 'was', 'were',
  'will', 'with', 'you', 'your', 'we', 'our', 'not', 'can', 'const', 'let', 'var', 'function',
  'return', 'import', 'export', 'default', 'class', 'new', 'null', 'true', 'false', 'undefined',
  'type', 'interface', 'public', 'private', 'static', 'void', 'string', 'number', 'boolean',
]);

/**
 * Split text into search tokens.
 *
 * Identifiers are split on camelCase and snake_case boundaries *and* the intact
 * identifier is kept, so a search for `parse` finds `parseRepository` while a
 * search for the full name still ranks the exact match highest.
 */
export function tokenize(input: string, options: { stopWords?: boolean } = {}): string[] {
  const useStopWords = options.stopWords ?? true;
  const tokens: string[] = [];
  const raw = input.match(/[A-Za-z0-9_$]+/g) ?? [];

  for (const word of raw) {
    const lower = word.toLowerCase();
    if (lower.length > 1 && !(useStopWords && STOP_WORDS.has(lower))) tokens.push(lower);

    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_$]+/)
      .filter(Boolean);

    if (parts.length > 1) {
      for (const part of parts) {
        const p = part.toLowerCase();
        if (p.length > 1 && p !== lower && !(useStopWords && STOP_WORDS.has(p))) tokens.push(p);
      }
    }
  }
  return tokens;
}

/** Character n-grams, used for fuzzy matching in the command palette. */
export function nGrams(input: string, n = 3): string[] {
  const padded = ` ${input.toLowerCase().trim()} `;
  if (padded.length <= n) return [padded];
  const grams: string[] = [];
  for (let i = 0; i <= padded.length - n; i++) grams.push(padded.slice(i, i + n));
  return grams;
}

/**
 * Subsequence fuzzy match, scored the way editors score command palettes:
 * consecutive matches and matches at word boundaries score much higher than
 * scattered ones. Returns `null` when the query is not a subsequence at all.
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let ti = 0;
  let previousIndex = -2;

  for (const char of q) {
    const found = t.indexOf(char, ti);
    if (found === -1) return null;
    let charScore = 1;
    if (found === previousIndex + 1) charScore += 4;
    const before = found > 0 ? t[found - 1] : undefined;
    if (found === 0 || before === ' ' || before === '/' || before === '-' || before === '_') {
      charScore += 3;
    }
    score += charScore;
    previousIndex = found;
    ti = found + 1;
  }
  // Prefer shorter targets when scores are otherwise equal.
  return score - Math.min(t.length - q.length, 20) * 0.1;
}

/** Levenshtein distance with an early-exit bound. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost
      );
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length] ?? 0;
}

export function truncate(input: string, max: number, suffix = '…'): string {
  if (input.length <= max) return input;
  return input.slice(0, Math.max(0, max - suffix.length)).trimEnd() + suffix;
}

export function titleCase(input: string): string {
  return input
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/** Extract a short natural-language summary from a block of prose or markdown. */
export function firstSentence(input: string, max = 220): string {
  const cleaned = input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return '';
  const match = /^(.+?[.!?])(\s|$)/.exec(cleaned);
  return truncate(match ? (match[1] ?? cleaned) : cleaned, max);
}

/** Deterministic, order-preserving de-duplication. */
export function unique<T>(items: Iterable<T>, key: (item: T) => string = String): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/** Group items by a derived key, preserving insertion order within groups. */
export function groupBy<T, K extends string>(
  items: Iterable<T>,
  key: (item: T) => K
): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

/** Clamp a number into a range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Round to a fixed number of decimals without floating-point noise. */
export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
