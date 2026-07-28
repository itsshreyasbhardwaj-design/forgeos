import { MemoryStore, emptySnapshot } from './adapters/memory.js';
import { FileStore } from './adapters/file.js';
import { PostgresStore, type PostgresOptions } from './adapters/postgres.js';
import type { Store } from './types.js';

export * from './types.js';
export { MemoryStore, emptySnapshot, type Snapshot } from './adapters/memory.js';
export { FileStore } from './adapters/file.js';
export { PostgresStore, type PostgresOptions } from './adapters/postgres.js';

export interface StoreEnvironment {
  readonly DATABASE_URL?: string | undefined;
  readonly FORGEOS_DATA_DIR?: string | undefined;
  /** Force the in-memory adapter regardless of the environment. */
  readonly FORGEOS_EPHEMERAL?: string | undefined;
}

/**
 * Choose a storage backend from the environment.
 *
 * The precedence is deliberate — `DATABASE_URL` wins when set, otherwise the
 * file adapter provides durability with no setup. Nothing here ever *fails*
 * because a database is missing; that is the whole point of the local mode.
 */
export function createStore(env: StoreEnvironment = {}): Store {
  if (env.FORGEOS_EPHEMERAL === '1' || env.FORGEOS_EPHEMERAL === 'true') {
    return new MemoryStore(emptySnapshot());
  }
  if (env.DATABASE_URL) {
    const options: PostgresOptions = {
      connectionString: env.DATABASE_URL,
      ssl: /\bsslmode=require\b/.test(env.DATABASE_URL),
    };
    return new PostgresStore(options);
  }
  return new FileStore(env.FORGEOS_DATA_DIR ?? '.forgeos');
}

/** Human-readable description of the active backend, for the health endpoint. */
export function describeStore(store: Store): string {
  switch (store.kind) {
    case 'postgres':
      return 'PostgreSQL' + ((store as PostgresStore).supportsVectorSearch ? ' with pgvector' : ' (pgvector unavailable — lexical memory retrieval)');
    case 'file':
      return 'Local file storage';
    default:
      return 'In-memory storage (data is lost on restart)';
  }
}
