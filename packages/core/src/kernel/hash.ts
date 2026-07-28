/**
 * Deterministic, dependency-free hashing.
 *
 * ForgeOS deliberately avoids `node:crypto` in the kernel so the same code runs
 * unchanged in the browser, in edge runtimes and in Node. These are *not*
 * cryptographic primitives — they are used for content addressing, stable ids,
 * feature hashing and cache keys, never for authentication or signing.
 */

const FNV_OFFSET_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

/** 32-bit FNV-1a. Fast, good avalanche for short strings. */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_32;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME_32);
  }
  return hash >>> 0;
}

/**
 * 64-bit FNV-1a expressed as two 32-bit halves, returned as 16 hex characters.
 * Collision probability across a million documents is ~2.7e-8 — comfortably
 * adequate for content addressing without pulling in a SHA implementation.
 */
export function fnv1a64(input: string): string {
  let h1 = FNV_OFFSET_32;
  let h2 = 0x23d4a8f1;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, FNV_PRIME_32);
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b);
    h2 ^= h2 >>> 13;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** Stable content hash with a short, human-scannable prefix. */
export function contentHash(input: string): string {
  return `fh1_${fnv1a64(input)}`;
}

/**
 * A deterministic PRNG (mulberry32). Every stochastic-looking behaviour in
 * ForgeOS — sampling, jitter, offline model responses — is seeded, so runs are
 * reproducible and tests are not flaky.
 */
export function seededRandom(seed: number | string): () => number {
  let a = typeof seed === 'string' ? fnv1a32(seed) : seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shannon entropy in bits per character. Used by the secret detector. */
export function shannonEntropy(input: string): number {
  if (input.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of input) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / input.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
