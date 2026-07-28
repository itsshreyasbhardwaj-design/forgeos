import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MemoryStore, emptySnapshot, type Snapshot } from './memory.js';
import type { Store } from '../types.js';

/**
 * File-backed storage — the zero-configuration default.
 *
 * Inherits every behaviour from {@link MemoryStore} and adds durability, so a
 * developer gets persistence across restarts without provisioning a database.
 *
 * Two properties make it safe rather than merely convenient:
 *
 *  - **Atomic writes.** Data is written to a temporary file and renamed over
 *    the target. A crash mid-write leaves the previous good file intact rather
 *    than a truncated one.
 *  - **Coalesced writes.** Mutations schedule a flush on the next tick instead
 *    of writing synchronously, so a burst of writes costs one disk write.
 */
export class FileStore extends MemoryStore {
  override readonly kind: Store['kind'] = 'file';

  private readonly path: string;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private dirty = false;

  constructor(directory: string, filename = 'forgeos.json') {
    super(emptySnapshot());
    this.path = resolve(join(directory, filename));
  }

  override async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const contents = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(contents) as Partial<Snapshot>;
      // Merge onto a fresh snapshot so a file written by an older version,
      // missing newer collections, still loads.
      this.data = { ...emptySnapshot(), ...parsed };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        await this.flush();
        return;
      }
      // A corrupt file must not take the application down. Preserve it for
      // inspection and start clean, which is recoverable; crashing is not.
      if (error instanceof SyntaxError) {
        await rename(this.path, `${this.path}.corrupt-${Date.now()}`).catch(() => undefined);
        this.data = emptySnapshot();
        await this.flush();
        return;
      }
      throw error;
    }
  }

  override async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  override async healthy(): Promise<boolean> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  protected override async persist(): Promise<void> {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 50);
  }

  /** Force an immediate write. Awaited by `close()` and by tests. */
  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      if (!this.dirty) return;
    }

    this.dirty = false;
    const temporary = `${this.path}.${process.pid}.tmp`;
    const payload = JSON.stringify(this.data);

    this.flushing = (async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporary, payload, 'utf8');
      await rename(temporary, this.path);
    })();

    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }
}
