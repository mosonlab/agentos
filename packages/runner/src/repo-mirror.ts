import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { RunnerConfig } from "./config.js";
import type { CommandOptions } from "./exec.js";
import {
  CLONE_COMMAND_TIMEOUT_MS, CLONE_OPERATION_BUDGET_MS, runWithNetworkRetry, type RetryOptions,
} from "./network-retry.js";

/**
 * A persistent, machine-local bare mirror of every remote this runner
 * provisions from.
 *
 * Provisioning used to clone the whole repository from GitHub for every single
 * run. On 2026-08-25 that clone measured 125.9s against a 120s command ceiling,
 * so a structurally flaky exit turned every provision into a timeout, a retry,
 * and eventually a failed run: one chain spent 3h04m with a 47% infrastructure
 * failure rate. Raising the ceiling was rejected — it moves the wall without
 * removing it.
 *
 * What removes it is transferring the history once. The mirror is created on
 * the first run that needs it and afterwards only ever receives an *incremental*
 * fetch, which is proportional to what changed rather than to the repository.
 * Run workspaces then clone from local disk, where there is no exit to shake.
 *
 * Two properties are deliberate and load-bearing:
 *
 * - The remote fetch keeps the clone retry profile from network-retry.ts. The
 *   first fetch into an empty mirror transfers exactly what a clone did, so it
 *   needs the same bound; later fetches are far smaller and finish well inside
 *   it.
 * - A mirror that exists but cannot be verified is a hard failure
 *   (`RepoMirrorError`), never a quiet fall back to a full remote clone. The
 *   fallback is precisely the behaviour this module exists to eliminate, and a
 *   silent one would restore it on exactly the machines whose mirror broke —
 *   invisibly, run after run.
 */

export type MirrorCommandExecutor = (
  config: RunnerConfig,
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options?: CommandOptions,
) => Promise<string>;

export type RepoMirrorProgress = {
  event: "created" | "refreshed" | "object-top-up" | "lock-wait" | "lock-takeover" | "elapsed";
  mirror?: string;
  condition?: string;
  elapsedMs?: number;
};

export type RepoMirrorOptions = {
  mirrorRoot?: string;
  /** Retry budget for the remote fetches; defaults to the clone profile. */
  fetchRetryOptions?: RetryOptions;
  lockWaitMs?: number;
  lockStaleMs?: number;
  lockPollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  report?: (progress: RepoMirrorProgress) => void;
};

/**
 * The lock is held across the mirror fetch *and* the workspace clone that reads
 * it, so a concurrent runner on the same machine cannot repack the object
 * database out from under a clone. Waiting is the correct behaviour rather than
 * a failure: the holder is bounded by the clone budget, and the wait replaces a
 * remote clone that cost longer than this on a bad day.
 */
const MIRROR_LOCK_WAIT_MS = 600_000;

/**
 * A lock older than this belonged to a process that died holding it. It is
 * comfortably above the longest legitimate hold — one clone-profile fetch
 * (300s) plus a local clone — so a takeover cannot race a live holder.
 */
const MIRROR_LOCK_STALE_MS = 900_000;
const MIRROR_LOCK_POLL_MS = 500;

/** Bare mirrors hold no secret: every account that can run a task can clone the
 *  repository anyway. They must be world-traversable *and* listable, because a
 *  clone under RUNNER_RUN_AS_PREFIX runs as another account and git enumerates
 *  the pack directory. */
const MIRROR_DIRECTORY_MODE = 0o755;

export class RepoMirrorError extends Error {
  readonly mirrorPath: string;
  readonly condition: string;

  constructor(mirrorPath: string, condition: string, options: { cause?: unknown } = {}) {
    super(
      `Runner repository mirror ${mirrorPath} is unusable (${condition}). `
      + "Provisioning refuses to fall back to a full remote clone; remove that directory "
      + "to have the next run rebuild the mirror from scratch.",
      options,
    );
    this.name = "RepoMirrorError";
    this.mirrorPath = mirrorPath;
    this.condition = condition;
  }
}

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const insideOrEqual = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const progressReporter = (progress: RepoMirrorProgress): void => {
  console.log(JSON.stringify({ audit: "repo-mirror", ...progress }));
};

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((done) => { setTimeout(done, ms); });

/** Where this runner keeps its mirrors. Beside the workspace root by default,
 *  exactly like the dependency cache, so one operator decision about disk
 *  placement covers every runner-owned durable directory. */
export const repoMirrorRoot = (config: Pick<RunnerConfig, "workspaceRoot" | "repoMirrorRoot">): string =>
  config.repoMirrorRoot ?? join(dirname(resolve(config.workspaceRoot)), "repo-mirrors");

/** One directory per remote URL. The digest, not the URL, is the name: remote
 *  URLs contain characters a path cannot hold, and a digest cannot collide with
 *  the lock or staging entries beside it. The mirror's own
 *  `remote.origin.url` is what an operator reads to identify it, and this
 *  module verifies that field on every use. */
export const repoMirrorPath = (root: string, remoteUrl: string): string =>
  join(root, `${createHash("sha256").update(remoteUrl).digest("hex")}.git`);

const ensureMirrorRoot = async (config: RunnerConfig, options: RepoMirrorOptions): Promise<string> => {
  const requested = resolve(options.mirrorRoot ?? repoMirrorRoot(config));
  await mkdir(requested, { recursive: true, mode: MIRROR_DIRECTORY_MODE });
  if ((await lstat(requested)).isSymbolicLink()) throw new Error(`Runner repository mirror root is a symlink: ${requested}`);
  const root = await realpath(requested);
  const workspaceRoot = resolve(config.workspaceRoot);
  if (insideOrEqual(root, workspaceRoot) || insideOrEqual(workspaceRoot, root)) {
    throw new Error(`Runner repository mirror root ${root} overlaps the workspace root ${workspaceRoot}`);
  }
  await chmod(root, MIRROR_DIRECTORY_MODE);
  return root;
};

const acquireMirrorLock = async (
  lockPath: string,
  owner: string,
  options: RepoMirrorOptions,
  report: (progress: RepoMirrorProgress) => void,
): Promise<() => Promise<void>> => {
  const now = options.now ?? ((): number => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const waitMs = options.lockWaitMs ?? MIRROR_LOCK_WAIT_MS;
  const staleMs = options.lockStaleMs ?? MIRROR_LOCK_STALE_MS;
  const pollMs = options.lockPollMs ?? MIRROR_LOCK_POLL_MS;
  const deadline = now() + waitMs;
  let waited = false;
  for (;;) {
    try {
      // mkdir is the atomic operation: exactly one caller creates it, everyone
      // else gets EEXIST. No lock file content participates in the decision.
      await mkdir(lockPath, { mode: MIRROR_DIRECTORY_MODE });
      const held = `${owner}:${process.pid}:${randomUUID()}\n`;
      const ownerFile = join(lockPath, "owner");
      const discard = async (): Promise<void> => { await rm(lockPath, { recursive: true, force: true }); };
      try {
        await writeFile(ownerFile, held, { mode: 0o644 });
      } catch (error: unknown) {
        await discard();
        throw error;
      }
      // Release removes this lock, not whatever lock happens to be at the path.
      // Without the check, a holder that was declared stale and taken over would
      // delete its successor's lock on the way out, and the mirror would end up
      // with two writers and no lock at all.
      return async (): Promise<void> => {
        const current = await readFile(ownerFile, "utf8").catch(() => "");
        if (current === held) await discard();
      };
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const held = await lstat(lockPath).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (held === null) continue;
    if (now() - held.mtimeMs > staleMs) {
      // The holder cannot still be alive: every operation under this lock is
      // bounded well below the staleness threshold.
      report({ event: "lock-takeover", mirror: lockPath, elapsedMs: Math.round(now() - held.mtimeMs) });
      await rm(lockPath, { recursive: true, force: true });
      continue;
    }
    if (now() >= deadline) {
      throw new Error(
        `Timed out after ${waitMs}ms waiting for the runner repository mirror lock ${lockPath}; `
        + "another run on this machine is still refreshing or reading the mirror.",
      );
    }
    if (!waited) {
      waited = true;
      report({ event: "lock-wait", mirror: lockPath });
    }
    await sleep(pollMs);
  }
};

const fetchFromRemote = async (
  config: RunnerConfig,
  mirror: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
  retryOptions: RetryOptions,
): Promise<void> => {
  // The clone profile, not delivery's. The first fetch into an empty mirror
  // moves the same bytes a clone did; every later one is incremental. Both run
  // while the runner heartbeat holds the lease, so the bound only has to
  // separate "hung" from "slow".
  await runWithNetworkRetry("git", args,
    ({ timeoutMs }) => execute(config, "git", args, mirror, env, { timeoutMs }),
    { commandTimeoutMs: CLONE_COMMAND_TIMEOUT_MS, budgetMs: CLONE_OPERATION_BUDGET_MS, ...retryOptions },
  );
};

const REFRESH_ARGS = ["fetch", "--prune", "--prune-tags", "--tags", "--quiet", "origin"] as const;

const configureMirror = async (
  config: RunnerConfig,
  mirror: string,
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
): Promise<void> => {
  // Heads only: GitHub advertises refs/pull/*, which no run has ever needed and
  // which would make every fetch pay for the repository's whole review history.
  await execute(config, "git", ["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], mirror, env);
  // Every object git writes here gets 0644 (directories 0755) whatever the
  // daemon's umask is. Without it, a restrictive umask would make the mirror
  // unreadable to the account a RUNNER_RUN_AS_PREFIX deployment clones as —
  // and only on the machines that set one. `git init --shared` covers the
  // directories init creates; this covers every write after it, and re-asserts
  // the setting on a mirror whose configuration was edited by hand.
  await execute(config, "git", ["config", "core.sharedRepository", "0644"], mirror, env);
  // Blind-review provisioning fetches an exact object id out of this mirror.
  // upload-pack refuses unadvertised objects by default, and the refusal would
  // read as a mirror fault rather than as the policy it is.
  await execute(config, "git", ["config", "uploadpack.allowAnySHA1InWant", "true"], mirror, env);
};

const createMirror = async (
  config: RunnerConfig,
  root: string,
  mirror: string,
  remoteUrl: string,
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
  retryOptions: RetryOptions,
): Promise<void> => {
  // Staged beside the destination and renamed only after the first fetch
  // succeeds, so an interrupted creation can never leave a directory that later
  // runs would mistake for a populated mirror.
  const staging = await mkdtemp(join(root, ".stage-"));
  try {
    await execute(config, "git", ["init", "--bare", "--shared=0644", "--quiet", staging], root, env);
    await execute(config, "git", ["remote", "add", "origin", remoteUrl], staging, env);
    await configureMirror(config, staging, env, execute);
    await fetchFromRemote(config, staging, [...REFRESH_ARGS], env, execute, retryOptions);
    await chmod(staging, MIRROR_DIRECTORY_MODE);
    await rename(staging, mirror);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
};

const validateMirror = async (
  config: RunnerConfig,
  mirror: string,
  remoteUrl: string,
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
): Promise<void> => {
  const info = await lstat(mirror);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new RepoMirrorError(mirror, "not-a-directory");
  if (await realpath(mirror) !== mirror) throw new RepoMirrorError(mirror, "symlinked-path");
  let bare: string;
  let configured: string;
  try {
    bare = await execute(config, "git", ["rev-parse", "--is-bare-repository"], mirror, env);
    configured = await execute(config, "git", ["config", "--get", "remote.origin.url"], mirror, env);
  } catch (error: unknown) {
    throw new RepoMirrorError(mirror, "not-a-readable-git-repository", { cause: error });
  }
  if (bare !== "true") throw new RepoMirrorError(mirror, "not-a-bare-repository");
  if (configured !== remoteUrl) throw new RepoMirrorError(mirror, "remote-url-mismatch");
};

/**
 * Which of `revisions` the mirror already has, resolved in one batch.
 *
 * `--batch-check` answers "missing" on its stdout instead of failing, so
 * absence never has to be inferred from a non-zero exit — which is what keeps a
 * genuinely broken object database from being read as "not fetched yet".
 */
export const mirrorRevisionsPresent = async (
  config: RunnerConfig,
  mirror: string,
  revisions: readonly string[],
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
): Promise<Map<string, boolean>> => {
  if (revisions.length === 0) return new Map();
  const output = await execute(
    config, "git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], mirror, env,
    { input: `${revisions.join("\n")}\n` },
  );
  const lines = output.split("\n");
  if (lines.length !== revisions.length) {
    throw new RepoMirrorError(mirror, `object-probe-unreadable:${lines.length}-of-${revisions.length}`);
  }
  return new Map(revisions.map((revision, index) => [revision, !(lines[index] ?? "").endsWith(" missing")]));
};

/**
 * Make the mirror hold every listed object id, topping up from the remote when
 * one is absent. A run's pinned base is pushed by an earlier run, so a mirror
 * refreshed moments ago normally has it already; a top-up covers the ref that
 * was deleted upstream after the object was recorded.
 *
 * A top-up that does not produce the object is a hard failure. It is the one
 * place where "just clone it from GitHub instead" would be tempting, and the
 * one place where doing so would hide a real inconsistency between the control
 * plane's recorded history and the remote's.
 */
export const ensureMirrorRevisions = async (
  config: RunnerConfig,
  mirror: string,
  revisions: readonly string[],
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
  retryOptions: RetryOptions = {},
  report: (progress: RepoMirrorProgress) => void = progressReporter,
): Promise<void> => {
  const present = await mirrorRevisionsPresent(config, mirror, revisions, env, execute);
  const missing = revisions.filter((revision) => present.get(revision) !== true);
  if (missing.length === 0) return;
  report({ event: "object-top-up", mirror, condition: missing.join(",") });
  await fetchFromRemote(config, mirror, ["fetch", "--no-tags", "--quiet", "origin", ...missing], env, execute, retryOptions);
  const settled = await mirrorRevisionsPresent(config, mirror, missing, env, execute);
  const absent = missing.filter((revision) => settled.get(revision) !== true);
  // Not a RepoMirrorError: the mirror did what it was asked and the remote came
  // back without the object. Rebuilding the mirror would not change that answer.
  if (absent.length > 0) {
    throw new Error(`Recorded commits are absent from the remote: ${absent.join(", ")}`);
  }
};

/** Whether the mirror carries this branch. Read after a refresh, this is the
 *  same truth an `ls-remote` would have returned, without the round trip. */
export const mirrorHasBranch = async (
  config: RunnerConfig,
  mirror: string,
  branch: string,
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
): Promise<boolean> => {
  const reference = `refs/heads/${branch}`;
  const listed = await execute(config, "git", ["for-each-ref", "--format=%(refname)", reference], mirror, env);
  return listed.split("\n").includes(reference);
};

/**
 * Refresh (or create) the mirror for `remoteUrl` and run `use` against it while
 * the machine-wide lock is still held, so nothing repacks the object database
 * while a workspace is being cloned out of it.
 */
export const withRepoMirror = async <T>(
  config: RunnerConfig,
  remoteUrl: string,
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
  options: RepoMirrorOptions,
  use: (mirror: string) => Promise<T>,
): Promise<T> => {
  const started = Date.now();
  const report = options.report ?? progressReporter;
  const retryOptions = options.fetchRetryOptions ?? {};
  const root = await ensureMirrorRoot(config, options);
  const mirror = repoMirrorPath(root, remoteUrl);
  const release = await acquireMirrorLock(`${mirror}.lock`, config.runnerId ?? "runner", options, report);
  try {
    let exists = true;
    try {
      await lstat(mirror);
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
      exists = false;
    }
    if (exists) {
      await validateMirror(config, mirror, remoteUrl, env, execute);
      await configureMirror(config, mirror, env, execute);
      await fetchFromRemote(config, mirror, [...REFRESH_ARGS], env, execute, retryOptions);
      report({ event: "refreshed", mirror });
    } else {
      await createMirror(config, root, mirror, remoteUrl, env, execute, retryOptions);
      report({ event: "created", mirror });
    }
    return await use(mirror);
  } finally {
    await release();
    report({ event: "elapsed", mirror, elapsedMs: Date.now() - started });
  }
};
