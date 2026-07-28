/**
 * ForgeOS never analyses "a repository" directly — it analyses a *snapshot*.
 *
 * A snapshot is an immutable, in-memory view of a set of files. It can come
 * from local disk, an uploaded archive, a Git provider API or a test fixture,
 * and every downstream engine (analysis, security, docs, graph, search) is
 * written against this one shape. That is what makes the same code path work
 * for a 40-file fixture and a 200k-file enterprise monorepo.
 */
export interface SourceFile {
  /** POSIX-style path relative to the snapshot root. Never absolute, never `..`. */
  readonly path: string;
  /** Size on disk in bytes, which may exceed `text.length` for multi-byte content. */
  readonly bytes: number;
  /** UTF-8 content, or `null` when the file is binary or was skipped for size. */
  readonly text: string | null;
  readonly binary: boolean;
  /** True when the file was included in the tree but its content was not loaded. */
  readonly truncated: boolean;
}

export interface SnapshotStats {
  readonly totalFiles: number;
  readonly includedFiles: number;
  readonly skippedFiles: number;
  readonly totalBytes: number;
  readonly durationMs: number;
}

export interface RepoSnapshot {
  /** Display name, typically the directory or repository name. */
  readonly name: string;
  /** Opaque source description: an absolute path, a URL, or `memory`. */
  readonly source: string;
  readonly files: readonly SourceFile[];
  readonly collectedAt: number;
  readonly stats: SnapshotStats;
  /** True when limits caused files to be omitted; results are then a sample. */
  readonly partial: boolean;
  /** Commit SHA when the snapshot came from a Git checkout. */
  readonly revision?: string;
}

/**
 * The minimal surface a storage backend must implement to be scannable.
 * Implemented by the Node adapter, the archive adapter, and test fixtures.
 */
export interface FileSource {
  /** List entries directly under `dir` (relative to root, `''` for the root). */
  list(dir: string): Promise<readonly DirEntry[]>;
  /** Read a file's raw bytes. */
  read(path: string): Promise<Uint8Array>;
}

export interface DirEntry {
  readonly name: string;
  readonly path: string;
  readonly directory: boolean;
  readonly bytes: number;
}

export interface ScanLimits {
  /** Stop after this many files. Default 20_000. */
  readonly maxFiles: number;
  /** Skip content of files larger than this. Default 1 MiB. */
  readonly maxFileBytes: number;
  /** Stop loading content once this much has been read. Default 96 MiB. */
  readonly maxTotalBytes: number;
  /** Refuse to descend deeper than this. Default 24. */
  readonly maxDepth: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxFiles: 20_000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 96 * 1024 * 1024,
  maxDepth: 24,
};

export interface ScanOptions {
  readonly name?: string;
  readonly source?: string;
  readonly limits?: Partial<ScanLimits>;
  /** Additional gitignore-style patterns to exclude. */
  readonly exclude?: readonly string[];
  /** When set, only paths matching one of these patterns are included. */
  readonly include?: readonly string[];
  /** Include files that the default ignore list would drop (node_modules, dist…). */
  readonly includeVendored?: boolean;
  readonly revision?: string;
  readonly now?: () => number;
}
