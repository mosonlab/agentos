/**
 * Threat model
 *
 * This store rejects every hostile path string an API caller can express and every
 * symlink at rest: intermediate components are walked with lstat, list/stat never
 * follow links, and final file opens use O_NOFOLLOW atomically. Logical and canonical
 * roots remain separate so legitimate symlinked roots (including /tmp and iCloud-
 * relocated Documents) work.
 *
 * This does not close a post-walk swap of an already-checked intermediate directory
 * by an adversary with concurrent write access inside the Files Root. Pure Node has
 * no openat/fd-relative primitive with which to close that TOCTOU. Deployment must
 * therefore isolate the model CLI under a principal that cannot traverse or write
 * FILES_ROOT. The algorithm alone does not claim absolute containment; OS isolation
 * is the backstop for the concurrent-attacker case.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { normalizeRelPath } from "./paths.js";
import {
  InvalidPathError,
  NotADirectoryError,
  NotFoundError,
  SymlinkError,
  type FileStat,
  type FileStore,
} from "./store.js";

export type ResolveMode = "existing" | "create-parents";
export type ContainedPath = { target: string; parent: string; name: string; normalized: string };

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const mapPathError = (error: unknown, path: string): never => {
  if (codeOf(error) === "ELOOP") throw new SymlinkError(`Symlink refused: ${path}`);
  if (codeOf(error) === "ENOENT") throw new NotFoundError(`Path not found: ${path}`);
  if (codeOf(error) === "ENOTDIR") throw new NotADirectoryError(`Not a directory: ${path}`);
  if (codeOf(error) === "ENOTEMPTY") throw new InvalidPathError(`Directory is not empty: ${path}`);
  throw error;
};

const inspectDirectory = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new SymlinkError(`Symlink refused: ${path}`);
  if (!info.isDirectory()) throw new NotADirectoryError(`Not a directory: ${path}`);
};

export const resolveContained = async (
  canonicalRoot: string,
  rel: string,
  mode: ResolveMode,
): Promise<ContainedPath> => {
  const normalized = normalizeRelPath(rel);
  const target = normalized === "" ? canonicalRoot : resolve(canonicalRoot, normalized);
  if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${sep}`)) {
    throw new InvalidPathError(`Path escapes the Files Root: ${rel}`);
  }

  const segments = normalized === "" ? [] : normalized.split("/");
  let parent = canonicalRoot;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    try {
      await inspectDirectory(parent);
    } catch (error: unknown) {
      if (codeOf(error) !== "ENOENT" || mode === "existing") mapPathError(error, rel);
      try {
        await mkdir(parent, { mode: 0o750 });
      } catch (mkdirError: unknown) {
        if (codeOf(mkdirError) !== "EEXIST") mapPathError(mkdirError, rel);
      }
      try {
        await inspectDirectory(parent);
      } catch (inspectError: unknown) {
        mapPathError(inspectError, rel);
      }
    }
  }
  return { target, parent, name: segments.at(-1) ?? "", normalized };
};

const fileStat = (path: string, kind: "file" | "dir", size: number, modifiedAt: Date): FileStat => ({
  path,
  kind,
  size,
  modifiedAt,
});

const requireNonRoot = (resolved: ContainedPath): void => {
  if (resolved.name === "") throw new InvalidPathError("This operation cannot target the Files Root");
};

export const createLocalFileStore = async (logicalRoot: string): Promise<FileStore> => {
  await mkdir(logicalRoot, { recursive: true, mode: 0o750 });
  const canonicalRoot = await realpath(logicalRoot);
  const resolvePath = (rel: string, mode: ResolveMode): Promise<ContainedPath> =>
    resolveContained(canonicalRoot, rel, mode);

  return {
    async read(path) {
      const resolved = await resolvePath(path, "existing");
      requireNonRoot(resolved);
      let handle;
      try {
        handle = await open(resolved.target, constants.O_RDONLY | constants.O_NOFOLLOW);
        return await handle.readFile();
      } catch (error: unknown) {
        return mapPathError(error, `${logicalRoot}/${resolved.normalized}`);
      } finally {
        await handle?.close();
      }
    },

    async write(path, data) {
      const resolved = await resolvePath(path, "create-parents");
      requireNonRoot(resolved);
      let handle;
      try {
        handle = await open(
          resolved.target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
          0o640,
        );
        await handle.writeFile(data);
        const info = await handle.stat();
        return fileStat(resolved.normalized, "file", info.size, info.mtime);
      } catch (error: unknown) {
        return mapPathError(error, `${logicalRoot}/${resolved.normalized}`);
      } finally {
        await handle?.close();
      }
    },

    async stat(path) {
      const resolved = await resolvePath(path, "existing");
      try {
        const info = await lstat(resolved.target);
        if (info.isSymbolicLink()) throw new SymlinkError(`Symlink refused: ${path}`);
        return fileStat(resolved.normalized, info.isDirectory() ? "dir" : "file", info.size, info.mtime);
      } catch (error: unknown) {
        if (codeOf(error) === "ENOENT") return null;
        return mapPathError(error, path);
      }
    },

    async list(dir) {
      const resolved = await resolvePath(dir, "existing");
      try {
        await inspectDirectory(resolved.target);
        const entries = await readdir(resolved.target, { withFileTypes: true });
        const stats = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()).map(async (entry) => {
          const childPath = join(resolved.target, entry.name);
          const info = await lstat(childPath);
          if (info.isSymbolicLink()) return null;
          const rel = resolved.normalized === "" ? entry.name : `${resolved.normalized}/${entry.name}`;
          return fileStat(rel, info.isDirectory() ? "dir" : "file", info.size, info.mtime);
        }));
        return stats.filter((stat): stat is FileStat => stat !== null);
      } catch (error: unknown) {
        return mapPathError(error, dir);
      }
    },

    async delete(path) {
      const resolved = await resolvePath(path, "existing");
      requireNonRoot(resolved);
      try {
        const info = await lstat(resolved.target);
        if (info.isSymbolicLink() || !info.isDirectory()) await unlink(resolved.target);
        else await rmdir(resolved.target);
      } catch (error: unknown) {
        mapPathError(error, path);
      }
    },

    async mkdir(path) {
      const resolved = await resolvePath(path, "create-parents");
      requireNonRoot(resolved);
      try {
        await mkdir(resolved.target, { mode: 0o750 });
      } catch (error: unknown) {
        if (codeOf(error) !== "EEXIST") mapPathError(error, path);
        try {
          await inspectDirectory(resolved.target);
        } catch (inspectError: unknown) {
          mapPathError(inspectError, path);
        }
      }
    },

    async move(from, to) {
      const source = await resolvePath(from, "existing");
      const destination = await resolvePath(to, "create-parents");
      requireNonRoot(source);
      requireNonRoot(destination);
      try {
        const sourceInfo = await lstat(source.target);
        if (sourceInfo.isSymbolicLink()) throw new SymlinkError(`Symlink refused: ${from}`);
        try {
          const destinationInfo = await lstat(destination.target);
          if (destinationInfo.isSymbolicLink()) throw new SymlinkError(`Symlink refused: ${to}`);
        } catch (error: unknown) {
          if (codeOf(error) !== "ENOENT") throw error;
        }
        await rename(source.target, destination.target);
      } catch (error: unknown) {
        mapPathError(error, `${from} -> ${to}`);
      }
    },
  };
};
