import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DirEntry, FileSource, RepoSnapshot, ScanOptions } from './types.js';
import { scan } from './scan.js';
import { parseGitignore } from './ignore.js';
import { invalidInput } from '../kernel/errors.js';

/**
 * A {@link FileSource} backed by the local filesystem.
 *
 * Two safety properties matter here and are enforced, not assumed:
 *
 *  1. **No escape.** Every resolved path is checked to still live under the
 *     root, so a symlink pointing at `/etc` cannot exfiltrate files.
 *  2. **No cycles.** Directory symlinks are not followed, so a self-referential
 *     link cannot hang the scanner.
 *
 * This module is the only part of `@forgeos/core` that imports Node built-ins;
 * everything else runs unchanged in a browser or edge runtime.
 */
export function createNodeFileSource(root: string): FileSource {
  const absoluteRoot = resolve(root);

  const within = async (candidate: string): Promise<boolean> => {
    try {
      const real = await realpath(candidate);
      const rel = relative(absoluteRoot, real);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    } catch {
      return false;
    }
  };

  return {
    async list(dir: string): Promise<readonly DirEntry[]> {
      const absolute = dir === '' ? absoluteRoot : join(absoluteRoot, dir);
      if (!(await within(absolute))) return [];

      const dirents = await readdir(absolute, { withFileTypes: true });
      const out: DirEntry[] = [];

      for (const dirent of dirents) {
        const childPath = dir === '' ? dirent.name : `${dir}/${dirent.name}`;
        const absoluteChild = join(absolute, dirent.name);

        if (dirent.isSymbolicLink()) {
          // Follow file symlinks that stay inside the root; never follow
          // directory symlinks, which is where cycles come from.
          if (!(await within(absoluteChild))) continue;
          try {
            const stats = await stat(absoluteChild);
            if (stats.isDirectory()) continue;
            out.push({ name: dirent.name, path: childPath, directory: false, bytes: stats.size });
          } catch {
            continue;
          }
          continue;
        }

        if (dirent.isDirectory()) {
          out.push({ name: dirent.name, path: childPath, directory: true, bytes: 0 });
          continue;
        }

        if (!dirent.isFile()) continue;

        try {
          const stats = await stat(absoluteChild);
          out.push({ name: dirent.name, path: childPath, directory: false, bytes: stats.size });
        } catch {
          continue;
        }
      }

      return out;
    },

    async read(path: string): Promise<Uint8Array> {
      const absolute = join(absoluteRoot, path);
      if (!(await within(absolute))) {
        throw invalidInput('Refusing to read a path outside the snapshot root', { path });
      }
      const buffer = await readFile(absolute);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    },
  };
}

/**
 * Scan a directory on local disk, honouring its `.gitignore` in addition to the
 * built-in ignore list.
 */
export async function scanDirectory(
  root: string,
  options: ScanOptions = {}
): Promise<RepoSnapshot> {
  const absoluteRoot = resolve(root);

  const stats = await stat(absoluteRoot).catch(() => null);
  if (!stats?.isDirectory()) {
    throw invalidInput(`'${root}' is not a readable directory`, { root });
  }

  const gitignore = await readFile(join(absoluteRoot, '.gitignore'), 'utf8').catch(() => '');
  const revision = options.revision ?? (await readGitRevision(absoluteRoot));

  return scan(createNodeFileSource(absoluteRoot), {
    name: options.name ?? absoluteRoot.split(sep).filter(Boolean).pop() ?? 'repository',
    source: absoluteRoot,
    ...options,
    ...(revision ? { revision } : {}),
    exclude: [...parseGitignore(gitignore), ...(options.exclude ?? [])],
  });
}

/**
 * Read the checked-out commit without shelling out to git. Handles both a
 * direct SHA in `HEAD` and the usual `ref: refs/heads/...` indirection,
 * including packed refs.
 */
export async function readGitRevision(root: string): Promise<string | undefined> {
  const head = await readFile(join(root, '.git', 'HEAD'), 'utf8').catch(() => null);
  if (!head) return undefined;

  const trimmed = head.trim();
  if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed;

  const ref = /^ref:\s*(.+)$/.exec(trimmed)?.[1];
  if (!ref) return undefined;

  const direct = await readFile(join(root, '.git', ref), 'utf8').catch(() => null);
  if (direct && /^[0-9a-f]{40}/i.test(direct.trim())) return direct.trim().slice(0, 40);

  const packed = await readFile(join(root, '.git', 'packed-refs'), 'utf8').catch(() => null);
  if (!packed) return undefined;
  for (const line of packed.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40})\s+(.+)$/i.exec(line.trim());
    if (match && match[2] === ref) return match[1];
  }
  return undefined;
}
