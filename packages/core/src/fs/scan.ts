import {
  DEFAULT_SCAN_LIMITS,
  type DirEntry,
  type FileSource,
  type RepoSnapshot,
  type ScanLimits,
  type ScanOptions,
  type SourceFile,
} from './types.js';
import { createMatcher, DEFAULT_IGNORE } from './ignore.js';

/** Byte-order marks and control-byte density are enough to classify binaries. */
export function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8000);
  if (sample.length === 0) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    // Control characters other than tab, newline, carriage return and form feed.
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.3;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

export function decodeText(bytes: Uint8Array): string {
  const text = decoder.decode(bytes);
  // Strip a UTF-8 BOM so downstream parsers see clean content.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function resolveLimits(partial: Partial<ScanLimits> | undefined): ScanLimits {
  return { ...DEFAULT_SCAN_LIMITS, ...partial };
}

/**
 * Walk a {@link FileSource} breadth-first and build a snapshot.
 *
 * Breadth-first matters: when limits truncate a huge repository, a breadth-first
 * walk yields a *representative* sample spread across the tree, whereas a
 * depth-first walk would exhaust the budget inside the first subdirectory it
 * happened to enter.
 */
export async function scan(source: FileSource, options: ScanOptions = {}): Promise<RepoSnapshot> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const limits = resolveLimits(options.limits);

  const ignorePatterns = [
    ...(options.includeVendored ? [] : DEFAULT_IGNORE),
    ...(options.exclude ?? []),
  ];
  const ignore = createMatcher(ignorePatterns);
  const include = options.include?.length ? createMatcher(options.include) : null;

  const files: SourceFile[] = [];
  let totalFiles = 0;
  let skippedFiles = 0;
  let totalBytes = 0;
  let contentBytes = 0;
  let partial = false;

  const queue: { dir: string; depth: number }[] = [{ dir: '', depth: 0 }];
  const pending: DirEntry[] = [];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    if (next.depth > limits.maxDepth) {
      partial = true;
      continue;
    }

    let entries: readonly DirEntry[];
    try {
      entries = await source.list(next.dir);
    } catch {
      // An unreadable directory (permissions, a broken symlink) must not abort
      // the scan — record nothing and keep walking.
      continue;
    }

    for (const entry of entries) {
      if (ignore.ignores(entry.path, entry.directory)) continue;
      if (entry.directory) {
        queue.push({ dir: entry.path, depth: next.depth + 1 });
        continue;
      }
      if (include && !include.ignores(entry.path, false)) continue;
      totalFiles++;
      if (pending.length >= limits.maxFiles) {
        partial = true;
        continue;
      }
      pending.push(entry);
    }
  }

  // Deterministic ordering makes every downstream artefact reproducible.
  pending.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const entry of pending) {
    totalBytes += entry.bytes;

    if (entry.bytes > limits.maxFileBytes || contentBytes >= limits.maxTotalBytes) {
      skippedFiles++;
      partial = true;
      files.push({ path: entry.path, bytes: entry.bytes, text: null, binary: false, truncated: true });
      continue;
    }

    let bytes: Uint8Array;
    try {
      bytes = await source.read(entry.path);
    } catch {
      skippedFiles++;
      files.push({ path: entry.path, bytes: entry.bytes, text: null, binary: false, truncated: true });
      continue;
    }

    if (looksBinary(bytes)) {
      files.push({ path: entry.path, bytes: entry.bytes, text: null, binary: true, truncated: false });
      continue;
    }

    contentBytes += bytes.byteLength;
    files.push({
      path: entry.path,
      bytes: entry.bytes,
      text: decodeText(bytes),
      binary: false,
      truncated: false,
    });
  }

  return {
    name: options.name ?? 'repository',
    source: options.source ?? 'memory',
    files,
    collectedAt: startedAt,
    partial,
    ...(options.revision ? { revision: options.revision } : {}),
    stats: {
      totalFiles,
      includedFiles: files.length,
      skippedFiles,
      totalBytes,
      durationMs: Math.max(0, now() - startedAt),
    },
  };
}

/**
 * Build a snapshot from an in-memory map of `path -> content`.
 * This is the entry point used by tests, by archive uploads and by the
 * "paste a file" flows in the UI.
 */
export function snapshotFromEntries(
  entries: Readonly<Record<string, string>> | Iterable<readonly [string, string]>,
  options: ScanOptions = {}
): RepoSnapshot {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const list = Symbol.iterator in Object(entries)
    ? Array.from(entries as Iterable<readonly [string, string]>)
    : Object.entries(entries as Record<string, string>);

  const ignore = createMatcher([
    ...(options.includeVendored ? [] : DEFAULT_IGNORE),
    ...(options.exclude ?? []),
  ]);

  const files: SourceFile[] = [];
  let totalBytes = 0;

  for (const [rawPath, text] of list) {
    const path = rawPath.replace(/^\.?\//, '');
    if (ignore.ignores(path, false)) continue;
    const bytes = new TextEncoder().encode(text).byteLength;
    totalBytes += bytes;
    files.push({ path, bytes, text, binary: false, truncated: false });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    name: options.name ?? 'repository',
    source: options.source ?? 'memory',
    files,
    collectedAt: startedAt,
    partial: false,
    ...(options.revision ? { revision: options.revision } : {}),
    stats: {
      totalFiles: files.length,
      includedFiles: files.length,
      skippedFiles: 0,
      totalBytes,
      durationMs: Math.max(0, now() - startedAt),
    },
  };
}

/** Look up a file by exact path. */
export function findFile(snapshot: RepoSnapshot, path: string): SourceFile | undefined {
  return snapshot.files.find((file) => file.path === path);
}

/** All files whose basename matches one of `names` (case-insensitive). */
export function findByName(snapshot: RepoSnapshot, ...names: string[]): SourceFile[] {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  return snapshot.files.filter((file) => {
    const base = file.path.slice(file.path.lastIndexOf('/') + 1);
    return wanted.has(base.toLowerCase());
  });
}

/** Files with readable text content, which is what most engines want. */
export function textFiles(snapshot: RepoSnapshot): SourceFile[] {
  return snapshot.files.filter((file): file is SourceFile & { text: string } => file.text !== null);
}
