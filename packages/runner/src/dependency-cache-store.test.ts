import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEPENDENCY_CACHE_BYTE_BUDGET, accountDependencyCacheEntryBytes, describeTargetTrees, openCacheEntryStore,
  selectDependencyCacheEvictions,
  type CacheEntryExpectation, type CacheEntryInput, type CacheEntryStore, type CacheStoreEvent,
  type DependencyCacheToolchain,
} from "./dependency-cache-store.js";

// The store's whole point is that keys, entries, bytes and usage are reachable
// from a bare temporary directory: nothing below builds an npm workspace, runs
// a command, or constructs a RunnerConfig.

const TOOLCHAIN: DependencyCacheToolchain = {
  node: "v24.0.0",
  npm: "11.0.0",
  operatingSystem: "darwin",
  architecture: "arm64",
};

const INPUTS: CacheEntryInput[] = [
  { path: "package.json", sha256: "a".repeat(64) },
  { path: "packages/db/prisma/schema.prisma", absent: true },
];

const TARGET_PATHS = ["node_modules", "packages/db/node_modules"];

const key = (index: number): string => index.toString(16).padStart(64, "0");

const expectation = (entryKey: string): CacheEntryExpectation =>
  ({ key: entryKey, toolchain: TOOLCHAIN, inputs: INPUTS, targetPaths: TARGET_PATHS });

const makeImmutable = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) for (const child of await readdir(path)) await makeImmutable(join(path, child));
  await chmod(path, info.isDirectory() ? 0o555 : 0o444 | (info.mode & 0o111));
};

const makeWritable = async (path: string): Promise<void> => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  await chmod(path, info.mode | 0o700);
  if (info.isDirectory()) for (const child of await readdir(path)) await makeWritable(join(path, child));
};

const cleanupRoot = async (root: string): Promise<void> => {
  await makeWritable(root).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
};

const openStore = (root: string): Promise<CacheEntryStore> =>
  openCacheEntryStore(join(root, "cache"), join(root, "sources"));

/** A plain directory holding the two target trees a publication snapshots. */
const sourceTree = async (root: string, name: string, content: string): Promise<string> => {
  const source = join(root, "sources", name);
  await mkdir(join(source, "node_modules/package-a"), { recursive: true });
  await mkdir(join(source, "packages/db/node_modules/package-b"), { recursive: true });
  await writeFile(join(source, "node_modules/package-a/index.js"), content);
  await writeFile(join(source, "packages/db/node_modules/package-b/index.js"), content);
  return source;
};

const publish = async (
  store: CacheEntryStore,
  root: string,
  entryKey: string,
  content = `content for ${entryKey.slice(56)}\n`,
  decorate: (source: string) => Promise<void> = async () => undefined,
): Promise<CacheEntryExpectation> => {
  const source = await sourceTree(root, entryKey.slice(56), content);
  await decorate(source);
  const targets = await describeTargetTrees(source, TARGET_PATHS);
  const expected = expectation(entryKey);
  assert.equal(await store.publishEntry(expected, targets, source), "published");
  await store.recordUse(entryKey);
  return expected;
};

const usageMarker = (store: CacheEntryStore, entryKey: string): string => join(store.root, "usage", entryKey);

/** An independent allocated-size walk, so accounting is checked against a second reading. */
const accountedBytes = async (path: string): Promise<bigint> => {
  const info = await lstat(path);
  if (info.isDirectory()) {
    let total = BigInt(info.blocks) * 512n;
    for (const child of await readdir(path)) total += await accountedBytes(join(path, child));
    return total;
  }
  return BigInt(info.blocks) * 512n;
};

const orderUsage = async (store: CacheEntryStore, keys: string[]): Promise<void> => {
  for (const [index, entryKey] of keys.entries()) {
    const when = new Date(1_000 * (index + 1));
    await utimes(usageMarker(store, entryKey), when, when);
  }
};

test("a cache root refuses a layout it cannot own", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-layout-"));
  try {
    const realRoot = await realpath(root);
    await assert.rejects(
      openCacheEntryStore(join(root, "cache"), join(realRoot, "cache/entries")),
      /overlaps/u,
      "a root that contains the trees it caches cannot be immutable",
    );
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), join(root, "linked-cache"));
    await assert.rejects(openCacheEntryStore(join(root, "linked-cache"), join(root, "sources")), /symlink/u);

    const store = await openStore(root);
    assert.deepEqual((await readdir(store.root)).sort(), ["entries", "usage"]);
    assert.equal((await lstat(join(store.root, "usage"))).mode & 0o777, 0o700);
  } finally {
    await cleanupRoot(root);
  }
});

test("a published entry is immutable, reads back, and refuses a different expectation", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-publish-"));
  try {
    const store = await openStore(root);
    assert.equal(await store.hasEntry(key(1)), false);
    const expected = await publish(store, root, key(1), "published tree\n");
    assert.equal(await store.hasEntry(key(1)), true);

    const entry = store.entryPath(key(1));
    assert.equal((await lstat(entry)).mode & 0o222, 0, "a published entry carries no writable bit");
    assert.equal(
      await readFile(join(store.targetSourcePath(key(1), "node_modules"), "package-a/index.js"), "utf8"),
      "published tree\n",
    );

    const document = await store.readEntry(expected);
    assert.equal(document.key, key(1));
    assert.deepEqual(document.targets.map(({ path }) => path), TARGET_PATHS);
    assert.equal(document.targets.every(({ present }) => present), true);

    const second = await sourceTree(root, "second", "published tree\n");
    assert.equal(
      await store.publishEntry(expected, await describeTargetTrees(second, TARGET_PATHS), second),
      "converged",
      "a second publication of the same key converges on the entry already there",
    );

    await assert.rejects(
      store.readEntry({ ...expected, toolchain: { ...TOOLCHAIN, node: "v22.0.0" } }),
      /toolchain-mismatch/u,
    );
    await assert.rejects(store.readEntry(expectation(key(2))), /entry-not-directory/u);
  } finally {
    await cleanupRoot(root);
  }
});

test("usage markers are written per key and refused when they are not plain files", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-usage-"));
  try {
    const store = await openStore(root);
    await store.validateUseMarker(key(1));

    await store.recordUse(key(1));
    const marker = usageMarker(store, key(1));
    assert.equal((await lstat(marker)).isFile(), true);
    const first = await readFile(marker, "utf8");
    assert.match(first, /^\d{4}-\d{2}-\d{2}T/u);
    await utimes(marker, new Date(1_000), new Date(1_000));
    await store.recordUse(key(1));
    assert.ok((await lstat(marker)).mtimeMs > 1_000, "recording use refreshes the marker");
    await store.validateUseMarker(key(1));

    await rm(marker);
    await mkdir(join(root, "marker-target"));
    await symlink(join(root, "marker-target"), marker);
    await assert.rejects(store.validateUseMarker(key(1)), /unsafe-usage-marker/u);
    await rm(marker);
    await mkdir(marker);
    await assert.rejects(store.validateUseMarker(key(1)), /unsafe-usage-marker/u);

    await assert.rejects(store.recordUse("not-a-cache-key"), /usage key is invalid/u);
  } finally {
    await cleanupRoot(root);
  }
});

test("byte-budget eviction takes the least recently used keys and never the protected one", () => {
  const gibibyte = 1024 ** 3;
  const belowBudget = Array.from({ length: 40 }, (_, index) => ({
    key: key(index), bytes: 256 * 1024 ** 2, usedMs: index + 1,
  }));
  assert.equal(
    belowBudget.reduce((total, entry) => total + entry.bytes, 0) < DEPENDENCY_CACHE_BYTE_BUDGET,
    true,
    "the synthetic population is below the fixed budget",
  );
  assert.deepEqual(
    selectDependencyCacheEvictions(belowBudget, key(39), DEPENDENCY_CACHE_BYTE_BUDGET),
    [],
    "entry count does not trigger retention",
  );

  const entries = [
    { key: key(100), bytes: 4 * gibibyte, usedMs: 1 },
    { key: key(101), bytes: 7 * gibibyte, usedMs: 2 },
    { key: key(102), bytes: 6 * gibibyte, usedMs: 3 },
    { key: key(103), bytes: 5 * gibibyte, usedMs: 4 },
  ];
  const victims = selectDependencyCacheEvictions(entries, key(103), DEPENDENCY_CACHE_BYTE_BUDGET);
  assert.deepEqual(victims, [key(100), key(101)], "multiple oldest entries are evicted in one pass");
  assert.ok(entries.filter(({ key: candidate }) => !victims.includes(candidate))
    .reduce((total, entry) => total + entry.bytes, 0) <= DEPENDENCY_CACHE_BYTE_BUDGET);

  const exact = [
    { key: key(110), bytes: 8 * gibibyte, usedMs: 1 },
    { key: key(111), bytes: 8 * gibibyte, usedMs: 2 },
  ];
  assert.deepEqual(
    selectDependencyCacheEvictions(exact, key(111), DEPENDENCY_CACHE_BYTE_BUDGET),
    [],
    "exactly the budget is retained",
  );

  const refreshable = [
    { key: key(120), bytes: 6 * gibibyte, usedMs: 1 },
    { key: key(121), bytes: 7 * gibibyte, usedMs: 2 },
    { key: key(122), bytes: 5 * gibibyte, usedMs: 3 },
  ];
  assert.deepEqual(selectDependencyCacheEvictions(refreshable, key(122), DEPENDENCY_CACHE_BYTE_BUDGET), [key(120)]);
  refreshable[0]!.usedMs = 10;
  assert.deepEqual(
    selectDependencyCacheEvictions(refreshable, key(122), DEPENDENCY_CACHE_BYTE_BUDGET),
    [key(121)],
    "refreshing the oldest usage marker changes the victim",
  );

  assert.throws(
    () => selectDependencyCacheEvictions(
      [{ key: key(130), bytes: DEPENDENCY_CACHE_BYTE_BUDGET + 1, usedMs: 1 }], key(130), DEPENDENCY_CACHE_BYTE_BUDGET,
    ),
    /protected-entry-exceeds-byte-budget/u,
    "a protected entry larger than the budget is a named refusal",
  );
});

test("locked byte-budget enforcement deletes multiple oldest entries and preserves exact-budget state", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-budget-"));
  try {
    const store = await openStore(root);
    const keys = [key(1), key(2), key(3)];
    for (const entryKey of keys) await publish(store, root, entryKey);
    await orderUsage(store, keys);
    const sizes = await Promise.all(keys.map((entryKey) => accountDependencyCacheEntryBytes(store.entryPath(entryKey))));
    const exactBudget = Number(sizes.reduce((total, size) => total + size, 0n));

    const exactEvents: CacheStoreEvent[] = [];
    await store.enforceByteBudget(key(3), undefined, (event) => exactEvents.push(event), exactBudget);
    assert.deepEqual(exactEvents, [], "exact budget emits no eviction");

    const events: CacheStoreEvent[] = [];
    await store.enforceByteBudget(key(3), undefined, (event) => events.push(event), Number(sizes[2]));
    assert.deepEqual(events, [key(1), key(2)].map((evicted) => ({
      event: "eviction", key: evicted.slice(0, 16), condition: "byte-budget",
    })));
    await assert.rejects(lstat(store.entryPath(key(1))), /ENOENT/u);
    await assert.rejects(lstat(store.entryPath(key(2))), /ENOENT/u);
    await assert.rejects(lstat(usageMarker(store, key(1))), /ENOENT/u);
    await assert.rejects(lstat(usageMarker(store, key(2))), /ENOENT/u);
    assert.equal((await lstat(store.entryPath(key(3)))).isDirectory(), true);
  } finally {
    await cleanupRoot(root);
  }
});

test("an oversized protected publication is rolled back and rejected with audit evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-rollback-"));
  try {
    const store = await openStore(root);
    await publish(store, root, key(1));
    const bytes = await accountDependencyCacheEntryBytes(store.entryPath(key(1)));
    const events: CacheStoreEvent[] = [];

    await assert.rejects(
      store.enforceByteBudget(key(1), key(1), (event) => events.push(event), Number(bytes - 1n)),
      (error: unknown) => error instanceof Error
        && error.name === "DependencyCacheBudgetError"
        && /protected-entry-exceeds-byte-budget/u.test(error.message),
    );

    await assert.rejects(lstat(store.entryPath(key(1))), /ENOENT/u, "the rolled-back entry is gone");
    await assert.rejects(lstat(usageMarker(store, key(1))), /ENOENT/u, "its usage marker goes with it");
    assert.deepEqual(events, [
      { event: "eviction", key: key(1).slice(0, 16), condition: "byte-budget" },
      { event: "integrity-refusal", key: key(1).slice(0, 16), condition: "protected-entry-exceeds-byte-budget" },
    ]);
  } finally {
    await cleanupRoot(root);
  }
});

test("an entry that cannot be safely evicted rejects the byte-budget invariant", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-eviction-failure-"));
  const entriesRoot = join(root, "cache/entries");
  try {
    const store = await openStore(root);
    await publish(store, root, key(1));
    await publish(store, root, key(2));
    await orderUsage(store, [key(1), key(2)]);
    const currentBytes = await accountDependencyCacheEntryBytes(store.entryPath(key(2)));
    await chmod(entriesRoot, 0o555);
    const events: CacheStoreEvent[] = [];

    await assert.rejects(
      store.enforceByteBudget(key(2), undefined, (event) => events.push(event), Number(currentBytes)),
      (error: unknown) => error instanceof Error
        && error.name === "DependencyCacheBudgetError"
        && /eviction-failed/u.test(error.message),
    );
    assert.ok(events.some(({ event, key: evicted, condition }) =>
      event === "integrity-refusal" && evicted === key(1).slice(0, 16) && condition?.startsWith("eviction-failed")));
    assert.equal(events.some(({ event }) => event === "eviction"), false);
  } finally {
    await chmod(entriesRoot, 0o711).catch(() => undefined);
    await cleanupRoot(root);
  }
});

test("an unrelated corrupt entry refuses the pass and preserves a valid new publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-unrelated-"));
  try {
    const store = await openStore(root);
    await publish(store, root, key(1));
    await publish(store, root, key(2));
    await makeWritable(store.entryPath(key(1)));
    await writeFile(join(store.entryPath(key(1)), "metadata.json"), "malformed\n");
    const events: CacheStoreEvent[] = [];

    await assert.rejects(
      store.enforceByteBudget(key(2), key(2), (event) => events.push(event)),
      /metadata-unreadable/u,
    );

    assert.equal((await lstat(store.entryPath(key(2)))).isDirectory(), true);
    assert.equal((await lstat(usageMarker(store, key(2)))).isFile(), true);
    assert.equal(events.some(({ event }) => event === "eviction"), false);
  } finally {
    await cleanupRoot(root);
  }
});

test("orphan publication stages are reaped and unrecognised usage files are left alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-orphan-"));
  try {
    const store = await openStore(root);
    await publish(store, root, key(1));
    const staging = join(store.root, "entries/.stage-0123456789abcdef-orphaned");
    await mkdir(staging);
    await writeFile(join(staging, "partial-snapshot"), "interrupted publication\n");
    const stray = join(store.root, "usage/stray-operator-file");
    await writeFile(stray, "not a cache usage marker\n");

    await store.enforceByteBudget(key(1), undefined, () => undefined);

    await assert.rejects(lstat(staging), /ENOENT/u, "an orphaned stage is reaped under the exclusive lock");
    assert.equal((await lstat(stray)).isFile(), true, "unrecognised usage files are ignored, not mutated");
    assert.equal((await lstat(store.entryPath(key(1)))).isDirectory(), true);
  } finally {
    await cleanupRoot(root);
  }
});

test("exclusive byte-budget enforcement waits for an existing shared lock owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-lock-"));
  try {
    const store = await openStore(root);
    await publish(store, root, key(1));
    let enterShared!: () => void;
    const sharedEntered = new Promise<void>((resolve) => { enterShared = resolve; });
    let releaseShared!: () => void;
    const sharedHeld = new Promise<void>((resolve) => { releaseShared = resolve; });

    const shared = store.withSharedLock(async () => {
      enterShared();
      await sharedHeld;
    });
    await sharedEntered;
    let settled = false;
    const enforcement = store.enforceByteBudget(key(1), undefined, () => undefined)
      .finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false, "blocking exclusive retention must wait instead of skipping enforcement");

    releaseShared();
    await Promise.all([shared, enforcement]);
    assert.equal((await lstat(store.entryPath(key(1)))).isDirectory(), true);
  } finally {
    await cleanupRoot(root);
  }
});

test("allocated-byte accounting includes metadata, trees, and safe symlink inodes without following links", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-accounting-"));
  try {
    const store = await openStore(root);
    await publish(store, root, key(1), "accounted tree\n", async (source) => {
      await symlink("index.js", join(source, "node_modules/package-a/safe-link.js"));
    });
    const entry = store.entryPath(key(1));

    const expected = await accountedBytes(entry);
    assert.equal(await accountDependencyCacheEntryBytes(entry), expected, "the walk counts every lstat inode");
    assert.ok(await accountedBytes(join(entry, "metadata.json")) > 0n, "metadata contributes to accounted bytes");
    assert.ok(await accountedBytes(join(entry, "trees")) > 0n, "complete trees contribute to accounted bytes");
    const link = join(store.targetSourcePath(key(1), "node_modules"), "package-a/safe-link.js");
    const linkInfo = await lstat(link);
    assert.equal(linkInfo.isSymbolicLink(), true);
    assert.equal(expected >= BigInt(linkInfo.blocks) * 512n, true, "the symlink inode is counted");
  } finally {
    await cleanupRoot(root);
  }
});

test("allocated-byte accounting rejects special files instead of treating them as cache misses", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cache-store-special-"));
  try {
    const store = await openStore(root);
    await publish(store, root, key(1));
    const entry = store.entryPath(key(1));
    await makeWritable(entry);
    execFileSync("mkfifo", [join(store.targetSourcePath(key(1), "node_modules"), "package-a/special")]);
    await makeImmutable(entry);

    await assert.rejects(accountDependencyCacheEntryBytes(entry), /special-file/u);
    await assert.rejects(
      store.enforceByteBudget(key(1), undefined, () => undefined),
      /special-file/u,
      "retention refuses rather than sizing a population it cannot walk",
    );
  } finally {
    await cleanupRoot(root);
  }
});
