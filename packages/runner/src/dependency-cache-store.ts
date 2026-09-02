/**
 * The on-disk store of published dependency trees.
 *
 * Its vocabulary is keys, entries, bytes and usage. It knows nothing about npm,
 * run workspaces, RunnerConfig or command execution: an entry is an immutable
 * directory of target trees named by a 64-hex key, an entry records when it was
 * last used, and the population of entries is held under a byte budget.
 *
 * Everything here is reachable from a bare temporary directory, which is what
 * makes lock, usage, accounting, eviction and rollback testable on their own.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import { flock } from "fs-ext";

export const CACHE_ENTRY_FORMAT = "agentos-runner-dependency-cache-v2";
const METADATA_FILE = "metadata.json";
const TREE_DIRECTORY = "trees";
const ENTRIES_DIRECTORY = "entries";
const USAGE_DIRECTORY = "usage";
const LOCK_FILE = "lock";
const MAX_METADATA_BYTES = 128 * 1024 * 1024;
const CACHE_KEY = /^[a-f0-9]{64}$/u;

export const DEPENDENCY_CACHE_BYTE_BUDGET = 16 * 1024 ** 3;

// Target confinement is lexical: a target path is relative and free of "..",
// so whether a recorded symlink escapes depends on the target's depth and the
// link's own "..", never on where the tree will actually be restored. Entry
// validation therefore applies the rule against this nominal root and does not
// need a run workspace at all.
const NOMINAL_RESTORE_ROOT = "/dependency-cache-restore-root";

export class DependencyCacheIntegrityError extends Error {
  constructor(readonly condition: string) {
    super(`Dependency cache integrity refusal: ${condition}`);
    this.name = "DependencyCacheIntegrityError";
  }
}

export class DependencyCacheBudgetError extends Error {
  constructor(readonly condition: string) {
    super(`Dependency cache byte budget refusal: ${condition}`);
    this.name = "DependencyCacheBudgetError";
  }
}

export type DependencyCacheToolchain = {
  node: string;
  npm: string;
  operatingSystem: string;
  architecture: string;
};

export type CacheEntryInput = { path: string; sha256: string } | { path: string; absent: true };

export type CacheEntryTreeNode =
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "file"; mode: number; sha256: string }
  | { path: string; kind: "symlink"; target: string };

export type CacheEntryTarget = { path: string; present: boolean; tree: CacheEntryTreeNode[] };

export type CacheEntryDocument = {
  format: typeof CACHE_ENTRY_FORMAT;
  key: string;
  toolchain: DependencyCacheToolchain;
  inputs: CacheEntryInput[];
  targets: CacheEntryTarget[];
};

/** Everything an entry must match to be usable, minus the trees themselves. */
export type CacheEntryExpectation = {
  key: string;
  toolchain: DependencyCacheToolchain;
  inputs: CacheEntryInput[];
  targetPaths: string[];
};

export type CacheEntryPublication = "published" | "converged" | "refused";

export type CacheStoreEvent = {
  event: "integrity-refusal" | "eviction";
  key?: string;
  condition?: string;
};

export type CacheStoreReport = (event: CacheStoreEvent) => void;

export type DependencyCacheRetentionSize = { key: string; bytes: number; usedMs: number };

/**
 * The least-recently-used keys whose removal brings the population inside the
 * budget. `currentKey` is never a victim; if it alone exceeds the budget the
 * population cannot be made to fit and this refuses.
 */
export const selectDependencyCacheEvictions = (
  entries: readonly DependencyCacheRetentionSize[],
  currentKey?: string,
  budget = DEPENDENCY_CACHE_BYTE_BUDGET,
): string[] => {
  if (!Number.isFinite(budget) || budget < 0) throw new Error("Dependency cache byte budget is invalid");
  for (const entry of entries) {
    if (!Number.isFinite(entry.bytes) || entry.bytes < 0) throw new Error("Dependency cache entry size is invalid");
    if (!Number.isFinite(entry.usedMs)) throw new Error("Dependency cache usage time is invalid");
  }
  const protectedEntry = currentKey === undefined ? undefined : entries.find(({ key }) => key === currentKey);
  if (protectedEntry !== undefined && protectedEntry.bytes > budget) {
    throw new DependencyCacheBudgetError("protected-entry-exceeds-byte-budget");
  }
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const victims: string[] = [];
  const ordered = [...entries].sort((left, right) => left.usedMs - right.usedMs || left.key.localeCompare(right.key));
  for (const entry of ordered) {
    if (total <= budget) break;
    if (entry.key === currentKey) continue;
    total -= entry.bytes;
    victims.push(entry.key);
  }
  return victims;
};

const insideOrEqual = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const sha256 = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const pathKind = async (path: string): Promise<"missing" | "directory" | "file" | "symlink" | "other"> => {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return "other";
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
};

/**
 * The store holds npm dependency trees, so a target is a `node_modules`
 * directory somewhere at or below `root`. This is the one place that rule and
 * the confinement rule are written.
 */
export const assertCacheTargetPath = (root: string, target: string): string => {
  if (target !== "node_modules" && !target.endsWith("/node_modules")) {
    throw new Error(`Invalid dependency target: ${target}`);
  }
  const absolute = resolve(root, target);
  if (!insideOrEqual(root, absolute)) throw new Error(`Dependency target escaped the run workspace: ${target}`);
  return absolute;
};

const treeManifest = async (
  treeRoot: string,
  root: string,
  mappedRoot: string,
  requireImmutable: boolean,
): Promise<CacheEntryTreeNode[]> => {
  const manifest: CacheEntryTreeNode[] = [];
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    const mapped = resolve(mappedRoot, relative(treeRoot, path));
    if (!insideOrEqual(root, mapped)) throw new DependencyCacheIntegrityError("tree-path-escape");
    const manifestPath = relative(treeRoot, path).split(sep).join("/") || ".";
    if (info.isSymbolicLink()) {
      const link = await readlink(path);
      if (isAbsolute(link) || !insideOrEqual(root, resolve(dirname(mapped), link))) {
        throw new DependencyCacheIntegrityError("symlink-escape");
      }
      manifest.push({ path: manifestPath, kind: "symlink", target: link });
      return;
    }
    if (requireImmutable && (info.mode & 0o222) !== 0) {
      throw new DependencyCacheIntegrityError("writable-entry");
    }
    if (info.isDirectory()) {
      if (requireImmutable && (info.mode & 0o005) !== 0o005) {
        throw new DependencyCacheIntegrityError("entry-not-readable");
      }
      manifest.push({ path: manifestPath, kind: "directory", mode: info.mode & 0o111 });
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
      return;
    }
    if (!info.isFile()) throw new DependencyCacheIntegrityError("special-file");
    if (requireImmutable && (info.mode & 0o004) === 0) throw new DependencyCacheIntegrityError("entry-not-readable");
    manifest.push({ path: manifestPath, kind: "file", mode: info.mode & 0o111, sha256: sha256(await readFile(path)) });
  };
  await visit(treeRoot);
  return manifest;
};

/**
 * Describe the target trees living under `root` right now. This is what a
 * caller publishes, and what it compares a restored workspace against.
 */
export const describeTargetTrees = async (root: string, targets: string[]): Promise<CacheEntryTarget[]> => {
  const manifest: CacheEntryTarget[] = [];
  for (const target of targets) {
    const absolute = assertCacheTargetPath(root, target);
    const kind = await pathKind(absolute);
    if (kind === "symlink") throw new Error(`Dependency target is a symlink: ${target}`);
    if (kind !== "missing" && kind !== "directory") throw new Error(`Dependency target is not a directory: ${target}`);
    const tree = kind === "directory" ? await treeManifest(absolute, root, absolute, false) : [];
    manifest.push({ path: target, present: kind === "directory", tree });
  }
  return manifest;
};

const documentShape = (value: unknown): value is CacheEntryDocument => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Partial<CacheEntryDocument>;
  if (metadata.format !== CACHE_ENTRY_FORMAT || typeof metadata.key !== "string") return false;
  if (metadata.toolchain === null || typeof metadata.toolchain !== "object" || Array.isArray(metadata.toolchain)) return false;
  const toolchain = metadata.toolchain as Partial<DependencyCacheToolchain>;
  if (!sameJson(Object.keys(toolchain).sort(), ["architecture", "node", "npm", "operatingSystem"])) return false;
  if (![toolchain.node, toolchain.npm, toolchain.operatingSystem, toolchain.architecture]
    .every((coordinate) => typeof coordinate === "string" && coordinate.length > 0)) return false;
  if (!Array.isArray(metadata.inputs) || !Array.isArray(metadata.targets) || metadata.targets.length === 0) return false;
  return metadata.inputs.every((input) => {
    if (input === null || typeof input !== "object" || typeof (input as CacheEntryInput).path !== "string") return false;
    const fields = Object.keys(input).sort();
    return (sameJson(fields, ["path", "sha256"]) && /^[a-f0-9]{64}$/u.test(String((input as { sha256?: unknown }).sha256)))
      || (sameJson(fields, ["absent", "path"]) && (input as { absent?: unknown }).absent === true);
  })
    && metadata.targets.every((target) => target !== null && typeof target === "object"
      && typeof (target as CacheEntryTarget).path === "string"
      && typeof (target as CacheEntryTarget).present === "boolean"
      && Array.isArray((target as CacheEntryTarget).tree)
      && sameJson(Object.keys(target).sort(), ["path", "present", "tree"])
      && (target as CacheEntryTarget).tree.every((entry) => {
        if (entry === null || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.kind !== "string") return false;
        if (entry.kind === "directory") {
          return Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o111
            && sameJson(Object.keys(entry).sort(), ["kind", "mode", "path"]);
        }
        if (entry.kind === "file") {
          return Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o111
            && /^[a-f0-9]{64}$/u.test(entry.sha256)
            && sameJson(Object.keys(entry).sort(), ["kind", "mode", "path", "sha256"]);
        }
        return entry.kind === "symlink" && typeof entry.target === "string"
          && sameJson(Object.keys(entry).sort(), ["kind", "path", "target"]);
      }));
};

const readDocument = async (entry: string): Promise<CacheEntryDocument> => {
  const path = join(entry, METADATA_FILE);
  const info = await lstat(path).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") throw new DependencyCacheIntegrityError("metadata-missing");
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_METADATA_BYTES) {
    throw new DependencyCacheIntegrityError("metadata-malformed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    throw new DependencyCacheIntegrityError(`metadata-unreadable:${errorCode(error) ?? "invalid-json"}`);
  }
  if (!documentShape(parsed)) throw new DependencyCacheIntegrityError("metadata-malformed");
  return parsed;
};

const validateTreeLayout = async (trees: string, targets: CacheEntryTarget[]): Promise<void> => {
  const present = new Set(targets.filter(({ present }) => present).map(({ path }) => path));
  const prefixes = new Set<string>();
  for (const target of present) {
    let parent = posix.dirname(target);
    while (parent !== ".") {
      prefixes.add(parent);
      parent = posix.dirname(parent);
    }
  }
  const walk = async (directory: string, relativeDirectory = ""): Promise<void> => {
    if (((await lstat(directory)).mode & 0o222) !== 0) throw new DependencyCacheIntegrityError("writable-entry");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (present.has(path)) continue;
      if (!prefixes.has(path) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new DependencyCacheIntegrityError("unexpected-tree-content");
      }
      await walk(join(directory, entry.name), path);
    }
  };
  await walk(trees);
};

const validateImmutableEntryContents = async (entry: string, document: CacheEntryDocument): Promise<void> => {
  const trees = join(entry, TREE_DIRECTORY);
  if (await pathKind(trees) !== "directory") throw new DependencyCacheIntegrityError("tree-root-missing");
  const entryNames = (await readdir(entry)).sort();
  if (!sameJson(entryNames, [METADATA_FILE, TREE_DIRECTORY].sort())) {
    throw new DependencyCacheIntegrityError("unexpected-entry-content");
  }
  await validateTreeLayout(trees, document.targets);
  for (const target of document.targets) {
    const cached = resolve(trees, target.path);
    if (!insideOrEqual(trees, cached)) throw new DependencyCacheIntegrityError("target-path-escape");
    const kind = await pathKind(cached);
    if (target.present && kind !== "directory") throw new DependencyCacheIntegrityError("target-tree-missing");
    if (!target.present && kind !== "missing") throw new DependencyCacheIntegrityError("unexpected-target-tree");
    if (target.present) {
      const actualTree = await treeManifest(
        cached, NOMINAL_RESTORE_ROOT, assertCacheTargetPath(NOMINAL_RESTORE_ROOT, target.path), true,
      );
      if (!sameJson(actualTree, target.tree)) throw new DependencyCacheIntegrityError("tree-manifest-mismatch");
    } else if (target.tree.length !== 0) {
      throw new DependencyCacheIntegrityError("target-manifest-mismatch");
    }
  }
  await treeManifest(join(entry, METADATA_FILE), NOMINAL_RESTORE_ROOT, NOMINAL_RESTORE_ROOT, true);
  const entryInfo = await lstat(entry);
  const treesInfo = await lstat(trees);
  if ((entryInfo.mode & 0o222) !== 0 || (treesInfo.mode & 0o222) !== 0) {
    throw new DependencyCacheIntegrityError("writable-entry");
  }
};

const validateEntry = async (entry: string, expected: CacheEntryExpectation): Promise<CacheEntryDocument> => {
  if (await pathKind(entry) !== "directory") throw new DependencyCacheIntegrityError("entry-not-directory");
  const document = await readDocument(entry);
  if (document.key !== expected.key) throw new DependencyCacheIntegrityError("key-mismatch");
  if (!sameJson(document.toolchain, expected.toolchain)) throw new DependencyCacheIntegrityError("toolchain-mismatch");
  if (!sameJson(document.inputs, expected.inputs)) throw new DependencyCacheIntegrityError("input-manifest-mismatch");
  if (!sameJson(document.targets.map(({ path }) => path), expected.targetPaths)) {
    throw new DependencyCacheIntegrityError("target-manifest-mismatch");
  }
  await validateImmutableEntryContents(entry, document);
  return document;
};

const makeImmutable = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) for (const child of await readdir(path)) await makeImmutable(join(path, child));
  await chmod(path, info.isDirectory() ? 0o555 : 0o444 | (info.mode & 0o111));
};

const makeWritable = async (path: string): Promise<void> => {
  const kind = await pathKind(path);
  if (kind === "missing" || kind === "symlink") return;
  const info = await lstat(path);
  await chmod(path, info.mode | 0o700);
  if (kind === "directory") for (const child of await readdir(path)) await makeWritable(join(path, child));
};

const allocatedBytes = (info: { blocks: number }): bigint => {
  if (!Number.isSafeInteger(info.blocks) || info.blocks < 0) {
    throw new DependencyCacheIntegrityError("invalid-allocated-size");
  }
  return BigInt(info.blocks) * 512n;
};

// Cache entries are immutable after publication. Walk them without following
// symlinks so accounting cannot escape the entry root. A symlink is itself an
// inode and therefore contributes its own allocated blocks. Its lexical target
// must remain below the entry root; validateEntry additionally checks the
// target against the tree layout before a selected entry is restored.
const accountCacheEntry = async (entry: string): Promise<bigint> => {
  const root = resolve(entry);
  const rootInfo = await lstat(root).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") throw new DependencyCacheIntegrityError("entry-not-directory");
    throw error;
  });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new DependencyCacheIntegrityError(rootInfo.isSymbolicLink() ? "unsafe-retention-entry" : "entry-not-directory");
  }
  const visitedInodes = new Set<string>();
  const visit = async (path: string): Promise<bigint> => {
    let info;
    try {
      info = await lstat(path);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") throw new DependencyCacheIntegrityError("entry-disappeared");
      throw error;
    }
    const inode = `${String(info.dev)}:${String(info.ino)}`;
    if (info.ino !== 0 && visitedInodes.has(inode)) return 0n;
    if (info.ino !== 0) visitedInodes.add(inode);
    const ownBytes = allocatedBytes(info);
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target) || !insideOrEqual(root, resolve(dirname(path), target))) {
        throw new DependencyCacheIntegrityError("symlink-escape");
      }
      return ownBytes;
    }
    if (info.isFile()) return ownBytes;
    if (!info.isDirectory()) throw new DependencyCacheIntegrityError("special-file");
    let total = ownBytes;
    for (const child of await readdir(path)) {
      const childPath = join(path, child);
      if (!insideOrEqual(root, childPath)) throw new DependencyCacheIntegrityError("entry-path-escape");
      total += await visit(childPath);
    }
    return total;
  };
  return visit(root);
};

/** Allocated bytes an entry directory occupies, symlink inodes included. */
export const accountDependencyCacheEntryBytes = async (entry: string): Promise<bigint> => {
  let bytes: bigint;
  try {
    bytes = await accountCacheEntry(entry);
  } catch (error: unknown) {
    if (error instanceof DependencyCacheIntegrityError) throw error;
    throw new DependencyCacheIntegrityError(`size-walk-failed:${errorCode(error) ?? "unknown"}`);
  }
  return bytes;
};

const flockAsync = (fd: number, operation: "sh" | "ex" | "un"): Promise<void> => new Promise((accept, reject) => {
  flock(fd, operation, (error) => error ? reject(error) : accept());
});

type RetentionEntry = { key: string; path: string; usedMs: number; bytes: bigint };

const totalRetentionBytes = (entries: RetentionEntry[]): bigint =>
  entries.reduce((total, entry) => total + entry.bytes, 0n);

const asRetentionIntegrityError = (error: unknown): DependencyCacheIntegrityError =>
  error instanceof DependencyCacheIntegrityError
    ? error
    : new DependencyCacheIntegrityError(`retention-walk-failed:${errorCode(error) ?? "unknown"}`);

const snapshotTarget = async (source: string, destination: string): Promise<void> => {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
};

/**
 * A cache root, opened.
 *
 * Every operation is named by a key. Publication and restore run under the
 * shared lock; byte-budget enforcement takes the exclusive one, so it always
 * sees a settled population.
 */
export type CacheEntryStore = {
  /** The resolved root. Entries, usage markers and the lock live under it. */
  readonly root: string;
  entryPath: (key: string) => string;
  /** Where a published target tree lives inside its entry. */
  targetSourcePath: (key: string, targetPath: string) => string;
  hasEntry: (key: string) => Promise<boolean>;
  /** Run `work` while no exclusive owner (byte-budget enforcement) can run. */
  withSharedLock: <T>(work: () => Promise<T>) => Promise<T>;
  /** Refuse a usage marker that is not a plain file before it is trusted. */
  validateUseMarker: (key: string) => Promise<void>;
  recordUse: (key: string) => Promise<void>;
  /** Validate the entry under `expected.key` against `expected` and return it. */
  readEntry: (expected: CacheEntryExpectation) => Promise<CacheEntryDocument>;
  /** Snapshot `targets` out of `source` into a new immutable entry. */
  publishEntry: (
    expected: CacheEntryExpectation, targets: CacheEntryTarget[], source: string,
  ) => Promise<CacheEntryPublication>;
  /**
   * Hold the population at or below `budget` bytes, evicting least-recently-used
   * entries. `currentKey` is never evicted; `newlyPublishedKey`, if the budget
   * cannot be met, is rolled back so a refused pass leaves nothing behind.
   */
  enforceByteBudget: (
    currentKey: string | undefined,
    newlyPublishedKey: string | undefined,
    report: CacheStoreReport,
    budget?: number,
  ) => Promise<void>;
};

/**
 * Create the cache root layout and return the store bound to it.
 *
 * `disjointFrom` is a resolved real path the root may neither contain nor live
 * inside: a cache that overlaps the trees it caches cannot be immutable. The
 * comparison is lexical, so an unresolved path would not be recognised.
 */
export const openCacheEntryStore = async (configuredRoot: string, disjointFrom: string): Promise<CacheEntryStore> => {
  const requestedRoot = resolve(configuredRoot);
  await mkdir(requestedRoot, { recursive: true, mode: 0o711 });
  if ((await lstat(requestedRoot)).isSymbolicLink()) throw new Error("Dependency cache root is a symlink");
  const root = await realpath(requestedRoot);
  if (insideOrEqual(root, disjointFrom) || insideOrEqual(disjointFrom, root)) {
    throw new Error("Dependency cache root overlaps the run workspace");
  }
  await chmod(root, 0o711);
  const entriesRoot = join(root, ENTRIES_DIRECTORY);
  await mkdir(entriesRoot, { recursive: true, mode: 0o711 });
  if ((await lstat(entriesRoot)).isSymbolicLink()) throw new Error("Dependency cache entries root is a symlink");
  await chmod(entriesRoot, 0o711);
  const usageRoot = join(root, USAGE_DIRECTORY);
  await mkdir(usageRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(usageRoot)).isSymbolicLink()) throw new Error("Dependency cache usage root is a symlink");
  await chmod(usageRoot, 0o700);

  const entryPath = (key: string): string => {
    const entry = resolve(entriesRoot, key);
    if (!insideOrEqual(root, entry)) throw new Error("Dependency cache entry escaped its root");
    return entry;
  };

  const openLock = async () => {
    const path = join(root, LOCK_FILE);
    const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      throw new Error("Dependency cache lock is not a file");
    }
    return handle;
  };

  const withSharedLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const handle = await openLock();
    try {
      await flockAsync(handle.fd, "sh");
      try {
        return await work();
      } finally {
        await flockAsync(handle.fd, "un");
      }
    } finally {
      await handle.close();
    }
  };

  const recordUse = async (key: string): Promise<void> => {
    if (!CACHE_KEY.test(key)) throw new Error("Dependency cache usage key is invalid");
    const marker = join(usageRoot, key);
    const handle = await open(
      marker,
      constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    ).catch((error: unknown) => {
      throw new DependencyCacheIntegrityError(`usage-marker-unwritable:${errorCode(error) ?? "unknown"}`);
    });
    try {
      await handle.writeFile(`${new Date().toISOString()}\n`);
    } finally {
      await handle.close();
    }
  };

  const validateUseMarker = async (key: string): Promise<void> => {
    const marker = join(usageRoot, key);
    const info = await lstat(marker).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw new DependencyCacheIntegrityError(`usage-marker-unreadable:${errorCode(error) ?? "unknown"}`);
    });
    if (info?.isSymbolicLink() || (info !== null && !info.isFile())) {
      throw new DependencyCacheIntegrityError("unsafe-usage-marker");
    }
  };

  const publishEntry = async (
    expected: CacheEntryExpectation, targets: CacheEntryTarget[], source: string,
  ): Promise<CacheEntryPublication> => {
    if (!sameJson(targets.map(({ path }) => path), expected.targetPaths)) {
      throw new Error("Published dependency targets do not match the expected target paths");
    }
    const entry = entryPath(expected.key);
    if (await pathKind(entry) !== "missing") {
      try {
        await validateEntry(entry, expected);
        return "converged";
      } catch (error: unknown) {
        if (error instanceof DependencyCacheIntegrityError) return "refused";
        throw error;
      }
    }
    const document: CacheEntryDocument = {
      format: CACHE_ENTRY_FORMAT,
      key: expected.key,
      toolchain: expected.toolchain,
      inputs: expected.inputs,
      targets,
    };
    const staging = await mkdtemp(join(entriesRoot, `.stage-${expected.key.slice(0, 16)}-`));
    if (!insideOrEqual(root, await realpath(staging))) throw new Error("Dependency cache staging escaped its root");
    try {
      await mkdir(join(staging, TREE_DIRECTORY));
      for (const target of document.targets) {
        if (target.present) {
          await snapshotTarget(
            assertCacheTargetPath(source, target.path), resolve(staging, TREE_DIRECTORY, target.path),
          );
        }
      }
      await writeFile(join(staging, METADATA_FILE), `${JSON.stringify(document)}\n`, { mode: 0o400 });
      await makeImmutable(staging);
      await validateEntry(staging, expected);
      try {
        await rename(staging, entry);
        return "published";
      } catch (error: unknown) {
        // Darwin reports EACCES rather than EEXIST when the winning directory is
        // already immutable. The destination's independently verified state,
        // not the platform-specific errno, decides whether this was a safe race.
        if (await pathKind(entry) === "missing") throw error;
        try {
          await validateEntry(entry, expected);
          return "converged";
        } catch (validationError: unknown) {
          if (validationError instanceof DependencyCacheIntegrityError) return "refused";
          throw validationError;
        }
      }
    } finally {
      if (await pathKind(staging) !== "missing") {
        await makeWritable(staging).catch(() => undefined);
        await rm(staging, { recursive: true, force: true });
      }
    }
  };

  const reportIntegrityRefusal = (
    report: CacheStoreReport,
    key: string | undefined,
    condition: string,
  ): DependencyCacheIntegrityError => {
    report({ event: "integrity-refusal", ...(key ? { key: key.slice(0, 16) } : {}), condition });
    return new DependencyCacheIntegrityError(condition);
  };

  const inspectRetentionEntry = async (key: string, path: string): Promise<void> => {
    const document = await readDocument(path);
    if (document.key !== key) throw new DependencyCacheIntegrityError("key-mismatch");
    await validateImmutableEntryContents(path, document);
  };

  const retentionEntries = async (report: CacheStoreReport): Promise<RetentionEntry[]> => {
    if (await pathKind(entriesRoot) !== "directory") {
      throw reportIntegrityRefusal(report, undefined, "entries-root-missing");
    }
    if (await pathKind(usageRoot) !== "directory") {
      throw reportIntegrityRefusal(report, undefined, "usage-root-missing");
    }
    const markerKinds = new Map<string, Awaited<ReturnType<typeof lstat>> | null>();
    for (const name of await readdir(usageRoot)) {
      // Only key-shaped names are cache usage markers. Ignore unrelated files
      // rather than letting them deny all materializations on the shared host.
      if (!CACHE_KEY.test(name)) continue;
      const marker = join(usageRoot, name);
      const markerInfo = await lstat(marker).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      });
      if (markerInfo?.isSymbolicLink() || (markerInfo !== null && !markerInfo.isFile())) {
        throw reportIntegrityRefusal(report, name, "unsafe-usage-marker");
      }
      markerKinds.set(name, markerInfo);
    }
    const entries: RetentionEntry[] = [];
    for (const name of await readdir(entriesRoot)) {
      if (!CACHE_KEY.test(name)) {
        // publishEntry creates stages under this directory while holding a
        // shared lock. Once the exclusive retention lock is held, a remaining
        // stage is necessarily orphaned and may be reaped safely. Other non-key
        // names are not immutable cache entries and are ignored.
        if (name.startsWith(".stage-")) {
          const staging = join(entriesRoot, name);
          await makeWritable(staging).catch(() => undefined);
          await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        }
        continue;
      }
      const path = join(entriesRoot, name);
      const info = await lstat(path).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      });
      if (info === null) throw reportIntegrityRefusal(report, name, "retention-entry-disappeared");
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw reportIntegrityRefusal(report, name, "unsafe-retention-entry");
      }
      let bytes: bigint;
      try {
        await inspectRetentionEntry(name, path);
        bytes = await accountCacheEntry(path);
      } catch (error: unknown) {
        throw reportIntegrityRefusal(report, name, asRetentionIntegrityError(error).condition);
      }
      const markerInfo = markerKinds.get(name) ?? null;
      const usedMs = Number(markerInfo?.mtimeMs ?? info.mtimeMs);
      if (!Number.isFinite(usedMs)) throw reportIntegrityRefusal(report, name, "invalid-usage-marker-time");
      entries.push({ key: name, path, usedMs, bytes });
    }
    return entries;
  };

  const removeRetentionEntry = async (entry: RetentionEntry): Promise<void> => {
    try {
      await makeWritable(entry.path);
      await rm(entry.path, { recursive: true, force: true });
      if (await pathKind(entry.path) !== "missing") throw new Error("cache entry remained after deletion");
      await rm(join(usageRoot, entry.key), { force: true });
      if (await pathKind(join(usageRoot, entry.key)) !== "missing") {
        throw new Error("cache usage marker remained after deletion");
      }
    } catch (error: unknown) {
      throw new DependencyCacheBudgetError(`eviction-failed:${errorCode(error) ?? "unknown"}`);
    }
  };

  const rollbackPublishedEntry = async (key: string, report: CacheStoreReport): Promise<void> => {
    const entry: RetentionEntry = { key, path: entryPath(key), usedMs: 0, bytes: 0n };
    const existed = await pathKind(entry.path) !== "missing";
    try {
      await removeRetentionEntry(entry);
    } catch (error: unknown) {
      const condition = error instanceof DependencyCacheBudgetError
        ? `publication-rollback-failed:${error.condition}`
        : "publication-rollback-failed";
      report({ event: "integrity-refusal", key: key.slice(0, 16), condition });
      throw new DependencyCacheBudgetError(condition);
    }
    if (existed) report({ event: "eviction", key: key.slice(0, 16), condition: "byte-budget" });
  };

  const enforceByteBudget = async (
    currentKey: string | undefined,
    newlyPublishedKey: string | undefined,
    report: CacheStoreReport,
    budget = DEPENDENCY_CACHE_BYTE_BUDGET,
  ): Promise<void> => {
    if (!Number.isSafeInteger(budget) || budget < 0) {
      throw new DependencyCacheBudgetError("invalid-byte-budget");
    }
    const budgetBytes = BigInt(budget);
    const handle = await openLock();
    let locked = false;
    try {
      // This is deliberately blocking. Shared restore and publication owners
      // must finish before this snapshot can be sized or entries removed.
      await flockAsync(handle.fd, "ex");
      locked = true;
      try {
        let entries: RetentionEntry[];
        try {
          entries = await retentionEntries(report);
        } catch (error: unknown) {
          const integrityError = asRetentionIntegrityError(error);
          if (!(error instanceof DependencyCacheIntegrityError)) {
            report({ event: "integrity-refusal", condition: integrityError.condition });
          }
          throw integrityError;
        }
        const protectedKey = currentKey && CACHE_KEY.test(currentKey) ? currentKey : undefined;
        let total = totalRetentionBytes(entries);
        if (total > budgetBytes) {
          let victimKeys: string[];
          try {
            victimKeys = selectDependencyCacheEvictions(
              entries.map(({ key, bytes, usedMs }) => {
                const numericBytes = Number(bytes);
                if (!Number.isSafeInteger(numericBytes)) throw new DependencyCacheIntegrityError("allocated-size-overflow");
                return { key, bytes: numericBytes, usedMs };
              }),
              protectedKey,
              budget,
            );
          } catch (error: unknown) {
            if (error instanceof DependencyCacheBudgetError
              && newlyPublishedKey
              && CACHE_KEY.test(newlyPublishedKey)) {
              await rollbackPublishedEntry(newlyPublishedKey, report);
            }
            const condition = error instanceof DependencyCacheBudgetError
              ? error.condition
              : asRetentionIntegrityError(error).condition;
            report({
              event: "integrity-refusal",
              ...(protectedKey ? { key: protectedKey.slice(0, 16) } : {}),
              condition,
            });
            throw error instanceof DependencyCacheBudgetError ? error : new DependencyCacheIntegrityError(condition);
          }
          const entriesByKey = new Map(entries.map((entry) => [entry.key, entry] as const));
          for (const victimKey of victimKeys) {
            const victim = entriesByKey.get(victimKey);
            if (victim === undefined) throw new DependencyCacheBudgetError("byte-budget-invariant-unmet");
            try {
              await removeRetentionEntry(victim);
            } catch (error: unknown) {
              const condition = error instanceof DependencyCacheBudgetError ? error.condition : "eviction-failed";
              report({ event: "integrity-refusal", key: victim.key.slice(0, 16), condition });
              if (newlyPublishedKey && newlyPublishedKey !== victim.key && CACHE_KEY.test(newlyPublishedKey)) {
                await rollbackPublishedEntry(newlyPublishedKey, report);
              }
              throw error instanceof DependencyCacheBudgetError ? error : new DependencyCacheBudgetError(condition);
            }
            total -= victim.bytes;
            report({ event: "eviction", key: victim.key.slice(0, 16), condition: "byte-budget" });
          }
        }

        // The exclusive lock has covered the initial walk and every deletion,
        // so this tracked total is the authoritative final invariant without a
        // second full manifest parse and inode walk.
        if (total <= budgetBytes) return;

        const protectedEntry = protectedKey === undefined
          ? undefined
          : entries.find((entry) => entry.key === protectedKey);
        const condition = protectedEntry !== undefined && protectedEntry.bytes > budgetBytes
          ? "protected-entry-exceeds-byte-budget"
          : "byte-budget-invariant-unmet";
        if (newlyPublishedKey && CACHE_KEY.test(newlyPublishedKey)) {
          await rollbackPublishedEntry(newlyPublishedKey, report);
        }
        report({
          event: "integrity-refusal",
          ...(protectedKey ? { key: protectedKey.slice(0, 16) } : {}),
          condition,
        });
        throw new DependencyCacheBudgetError(condition);
      } finally {
        await flockAsync(handle.fd, "un");
        locked = false;
      }
    } finally {
      if (locked) await flockAsync(handle.fd, "un").catch(() => undefined);
      await handle.close();
    }
  };

  return {
    root,
    entryPath,
    targetSourcePath: (key: string, targetPath: string) =>
      assertCacheTargetPath(join(entryPath(key), TREE_DIRECTORY), targetPath),
    hasEntry: async (key: string): Promise<boolean> => await pathKind(entryPath(key)) !== "missing",
    withSharedLock,
    validateUseMarker,
    recordUse,
    readEntry: (expected: CacheEntryExpectation) => validateEntry(entryPath(expected.key), expected),
    publishEntry,
    enforceByteBudget,
  };
};
