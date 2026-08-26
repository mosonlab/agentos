import { createHash, randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";

import type { RunnerConfig } from "./config.js";
import type { CommandOptions } from "./exec.js";
import {
  CLONE_COMMAND_TIMEOUT_MS, CLONE_OPERATION_BUDGET_MS, runWithNetworkRetry, type RetryOptions,
} from "./network-retry.js";

/**
 * A persistent bare mirror of every remote this runner provisions from, owned
 * by the same account that runs the tasks.
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
 * Four properties are deliberate and load-bearing:
 *
 * - Every operation here — git and filesystem alike — runs through the same
 *   `RUNNER_RUN_AS_PREFIX` the clone always did, and the mirror lives in that
 *   principal's own home. The account that can reach the remote is therefore
 *   the account that fetches, no deployment has to grant a second principal
 *   credentials, and nothing outside that 0700 home can read the mirror. That
 *   is also why the filesystem work is small shell scripts rather than node's
 *   fs: the daemon's uid cannot enter a launched account's home.
 * - The remote fetch keeps the clone retry profile from network-retry.ts. The
 *   first fetch into an empty mirror transfers exactly what a clone did, so it
 *   needs the same bound; later fetches are far smaller and finish well inside
 *   it.
 * - A mirror that exists but cannot be verified is a hard failure
 *   (`RepoMirrorError`), never a quiet fall back to a full remote clone. The
 *   fallback is precisely the behaviour this module exists to eliminate, and a
 *   silent one would restore it on exactly the machines whose mirror broke —
 *   invisibly, run after run.
 * - The lock is taken by `mkdir` and stolen by `mv`, both atomic, and a live
 *   holder keeps its lock young by touching it. A contender therefore cannot
 *   remove a lock another contender has already replaced, and a holder that is
 *   merely slow is never mistaken for a dead one.
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
  event: "created" | "refreshed" | "object-top-up" | "lock-wait" | "lock-steal" | "staging-retained" | "elapsed";
  mirror?: string;
  condition?: string;
  elapsedMs?: number;
};

export type RepoMirrorOptions = {
  mirrorRoot?: string;
  /** Retry budget for the remote fetches; defaults to the clone profile. */
  fetchRetryOptions?: RetryOptions;
  lockWaitMs?: number;
  /** Minutes of silence after which a lock is treated as a dead holder's. */
  lockStaleMinutes?: number;
  lockPollMs?: number;
  lockHeartbeatMs?: number;
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
 * A lock nobody has touched for this long belonged to a process that died
 * holding it. The holder refreshes its own lock every MIRROR_LOCK_HEARTBEAT_MS,
 * so this is a liveness signal rather than a guess about how long the work
 * takes — which matters because the local clone under the lock is deliberately
 * uncapped, and a laptop can suspend in the middle of one.
 */
const MIRROR_LOCK_STALE_MINUTES = 5;
const MIRROR_LOCK_HEARTBEAT_MS = 30_000;
const MIRROR_LOCK_POLL_MS = 500;

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

const insideOrEqual = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const progressReporter = (progress: RepoMirrorProgress): void => {
  console.log(JSON.stringify({ audit: "repo-mirror", ...progress }));
};

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((done) => { setTimeout(done, ms); });

/**
 * Where this runner keeps its mirrors: inside the home of the account that runs
 * the tasks. That home already exists at 0700 in every deployment — the
 * os-isolation provisioner creates one per runner account — so the mirror needs
 * no new directory, no new owner, and no new mode to get wrong.
 */
export const repoMirrorRoot = (config: Pick<RunnerConfig, "home" | "repoMirrorRoot">): string =>
  config.repoMirrorRoot ?? join(config.home, ".agentos", "repo-mirrors");

/** One directory per remote URL. The digest, not the URL, is the name: remote
 *  URLs contain characters a path cannot hold, and a digest cannot collide with
 *  the lock or staging entries beside it. The mirror's own
 *  `remote.origin.url` is what an operator reads to identify it, and this
 *  module verifies that field on every use. */
export const repoMirrorPath = (root: string, remoteUrl: string): string =>
  join(root, `${createHash("sha256").update(remoteUrl).digest("hex")}.git`);

/**
 * Run a shell fragment as the task principal.
 *
 * `cwd` is not where the work happens — every path the fragment touches is
 * absolute — it is only somewhere node can chdir *before* the prefix runs, as
 * the daemon's own uid. The mirror's own directories are not that place.
 */
const shell = (
  config: RunnerConfig,
  execute: MirrorCommandExecutor,
  cwd: string,
  env: NodeJS.ProcessEnv,
  body: string,
  ...args: string[]
): Promise<string> => execute(config, "/bin/sh", ["-c", body, "agentos-mirror", ...args], cwd, env);

/** Git addressed by GIT_DIR rather than by cwd, for the same reason. Keeping
 *  the subcommand at argv[0] also keeps network-retry.ts's allowlist — and the
 *  timeout that rides on it — matching what it is meant to match. */
const gitEnvironment = (env: NodeJS.ProcessEnv, mirror: string): NodeJS.ProcessEnv =>
  ({ ...env, GIT_DIR: mirror });

const ENSURE_ROOT = 'mkdir -p "$1" && chmod 700 "$1" && [ ! -L "$1" ] || exit 1;'
  // Staging left behind by a process that died between mktemp and mv. Nothing
  // else may remove it: a *live* creation for a different remote holds a
  // different lock and is not covered by this one.
  + ' find "$1" -maxdepth 1 -name ".stage-*" -mmin +"$2" -exec rm -rf {} + 2>/dev/null; exit 0';

const PROBE = 'if [ -L "$1" ]; then printf unusable;'
  + ' elif [ -d "$1" ]; then printf present;'
  + ' elif [ -e "$1" ]; then printf unusable;'
  + ' else printf absent; fi';

// mkdir is the atomic acquisition. The steal is a rename, which is the other
// atomic operation: two contenders that both judge a lock dead cannot both
// succeed, so the loser retries instead of deleting the winner's fresh lock.
//
// A lock whose owner file could not be written is removed rather than left for
// the staleness path: it would otherwise block every run on this machine for
// the whole stale window over a failure that is already known here. Anything at
// the path that is not a directory was never a lock — only a heartbeat that
// raced its own release can put a file there — and is stolen on sight.
const ACQUIRE = 'if mkdir "$1" 2>/dev/null; then'
  + ' if printf %s "$2" > "$1/owner"; then printf acquired; else rm -rf "$1"; exit 1; fi;'
  + ' elif [ ! -d "$1" ] || [ -n "$(find "$1" -maxdepth 0 -mmin +"$3" 2>/dev/null)" ]; then'
  + ' if mv "$1" "$1.dead.$$" 2>/dev/null; then rm -rf "$1.dead.$$"; printf stolen; else printf held; fi;'
  + ' else printf held; fi';

/** Release removes this lock, not whatever lock happens to be at the path: a
 *  holder whose lock was stolen must not delete its successor's. */
const RELEASE = 'if [ "$(cat "$1/owner" 2>/dev/null)" = "$2" ]; then rm -rf "$1"; fi';

const acquireMirrorLock = async (
  config: RunnerConfig,
  execute: MirrorCommandExecutor,
  cwd: string,
  env: NodeJS.ProcessEnv,
  lockPath: string,
  owner: string,
  options: RepoMirrorOptions,
  report: (progress: RepoMirrorProgress) => void,
): Promise<() => Promise<void>> => {
  const now = options.now ?? ((): number => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const waitMs = options.lockWaitMs ?? MIRROR_LOCK_WAIT_MS;
  const staleMinutes = options.lockStaleMinutes ?? MIRROR_LOCK_STALE_MINUTES;
  const heartbeatMs = options.lockHeartbeatMs ?? MIRROR_LOCK_HEARTBEAT_MS;
  const pollMs = options.lockPollMs ?? MIRROR_LOCK_POLL_MS;
  const deadline = now() + waitMs;
  const held = `${owner}:${process.pid}:${randomUUID()}`;
  let waited = false;
  for (;;) {
    const outcome = await shell(config, execute, cwd, env, ACQUIRE, lockPath, held, String(staleMinutes));
    if (outcome === "acquired") {
      // A holder that stops touching its lock is a holder that died. Without
      // this, the staleness threshold would have to bound the uncapped local
      // clone under the lock — and a suspended machine bounds nothing.
      const heartbeat = setInterval(() => {
        // Guarded: an unguarded touch that lost a race with its own release
        // would create a *file* where the lock directory was, and no later
        // mkdir could acquire it.
        void shell(config, execute, cwd, env, 'if [ -d "$1" ]; then touch "$1"; fi', lockPath).catch(() => undefined);
      }, heartbeatMs);
      heartbeat.unref?.();
      return async (): Promise<void> => {
        clearInterval(heartbeat);
        await shell(config, execute, cwd, env, RELEASE, lockPath, held);
      };
    }
    if (outcome === "stolen") {
      report({ event: "lock-steal", mirror: lockPath });
      continue;
    }
    // Anything else means the acquisition script did not run: treating an
    // unrecognised answer as "someone else holds it" would spend the whole wait
    // budget and then blame a lock that was never there.
    if (outcome !== "held") throw new Error(`Runner repository mirror lock ${lockPath} answered "${outcome}"`);
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
  cwd: string,
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
  retryOptions: RetryOptions,
): Promise<void> => {
  // The clone profile, not delivery's. The first fetch into an empty mirror
  // moves the same bytes a clone did; every later one is incremental. Both run
  // while the runner heartbeat holds the lease, so the bound only has to
  // separate "hung" from "slow".
  await runWithNetworkRetry("git", args,
    ({ timeoutMs }) => execute(config, "git", args, cwd, gitEnvironment(env, mirror), { timeoutMs }),
    { commandTimeoutMs: CLONE_COMMAND_TIMEOUT_MS, budgetMs: CLONE_OPERATION_BUDGET_MS, ...retryOptions },
  );
};

const REFRESH_ARGS = ["fetch", "--prune", "--prune-tags", "--tags", "--quiet", "origin"] as const;

const configureMirror = async (
  config: RunnerConfig,
  mirror: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
): Promise<void> => {
  const gitEnv = gitEnvironment(env, mirror);
  // Heads only: GitHub advertises refs/pull/*, which no run has ever needed and
  // which would make every fetch pay for the repository's whole review history.
  await execute(config, "git", ["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], cwd, gitEnv);
  // Blind-review provisioning fetches an exact object id out of this mirror.
  // upload-pack refuses unadvertised objects by default, and the refusal would
  // read as a mirror fault rather than as the policy it is.
  await execute(config, "git", ["config", "uploadpack.allowAnySHA1InWant", "true"], cwd, gitEnv);
};

const createMirror = async (
  config: RunnerConfig,
  root: string,
  mirror: string,
  remoteUrl: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
  retryOptions: RetryOptions,
  report: (progress: RepoMirrorProgress) => void,
): Promise<void> => {
  // Staged beside the destination and renamed only after the first fetch
  // succeeds, so an interrupted creation can never leave a directory that later
  // runs would mistake for a populated mirror.
  const staging = await shell(config, execute, cwd, env, 'd=$(mktemp -d "$1/.stage-XXXXXXXX") && printf %s "$d"', root);
  if (!insideOrEqual(root, staging)) throw new Error(`Runner repository mirror staging escaped its root: ${staging}`);
  try {
    await execute(config, "git", ["init", "--bare", "--quiet", staging], cwd, env);
    await execute(config, "git", ["remote", "add", "origin", remoteUrl], cwd, gitEnvironment(env, staging));
    await configureMirror(config, staging, cwd, env, execute);
    await fetchFromRemote(config, staging, [...REFRESH_ARGS], cwd, env, execute, retryOptions);
    await shell(config, execute, cwd, env, 'mv "$1" "$2"', staging, mirror);
  } finally {
    // The sweep in ENSURE_ROOT is what covers a process that dies before this
    // runs; a failure here is reported rather than swallowed, because a staging
    // directory is close to a whole repository in size.
    await shell(config, execute, cwd, env, 'rm -rf "$1"', staging)
      .catch(() => { report({ event: "staging-retained", mirror: staging }); });
  }
};

const validateMirror = async (
  config: RunnerConfig,
  mirror: string,
  remoteUrl: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
): Promise<void> => {
  const gitEnv = gitEnvironment(env, mirror);
  let bare: string;
  let configured: string;
  try {
    bare = await execute(config, "git", ["rev-parse", "--is-bare-repository"], cwd, gitEnv);
    configured = await execute(config, "git", ["config", "--get", "remote.origin.url"], cwd, gitEnv);
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
  cwd: string,
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
): Promise<Map<string, boolean>> => {
  if (revisions.length === 0) return new Map();
  const output = await execute(
    config, "git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], cwd, gitEnvironment(env, mirror),
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
 */
export const ensureMirrorRevisions = async (
  config: RunnerConfig,
  mirror: string,
  revisions: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
  retryOptions: RetryOptions = {},
  report: (progress: RepoMirrorProgress) => void = progressReporter,
): Promise<void> => {
  const present = await mirrorRevisionsPresent(config, mirror, revisions, cwd, env, execute);
  const missing = revisions.filter((revision) => present.get(revision) !== true);
  if (missing.length === 0) return;
  report({ event: "object-top-up", mirror, condition: missing.join(",") });
  await fetchFromRemote(config, mirror, ["fetch", "--no-tags", "--quiet", "origin", ...missing], cwd, env, execute, retryOptions);
  const settled = await mirrorRevisionsPresent(config, mirror, missing, cwd, env, execute);
  const absent = missing.filter((revision) => settled.get(revision) !== true);
  // Not a RepoMirrorError: the mirror did what it was asked and the remote came
  // back without the object. Rebuilding the mirror would not change that answer.
  if (absent.length > 0) throw new Error(`Recorded commits are absent from the remote: ${absent.join(", ")}`);
};

/** Whether the mirror carries this branch. Read after a refresh, this is the
 *  same truth an `ls-remote` would have returned, without the round trip. */
export const mirrorHasBranch = async (
  config: RunnerConfig,
  mirror: string,
  branch: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
): Promise<boolean> => {
  const reference = `refs/heads/${branch}`;
  const listed = await execute(
    config, "git", ["for-each-ref", "--format=%(refname)", reference], cwd, gitEnvironment(env, mirror),
  );
  return listed.split("\n").includes(reference);
};

/**
 * Refresh (or create) the mirror for `remoteUrl` and run `use` against it while
 * the machine-wide lock is still held, so nothing repacks the object database
 * while a workspace is being cloned out of it.
 *
 * `cwd` must be a directory the runner daemon's own uid can enter: node chdirs
 * into it before the run-as prefix executes. The workspace root is one.
 */
export const withRepoMirror = async <T>(
  config: RunnerConfig,
  remoteUrl: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  execute: MirrorCommandExecutor,
  options: RepoMirrorOptions,
  use: (mirror: string) => Promise<T>,
): Promise<T> => {
  const started = Date.now();
  const report = options.report ?? progressReporter;
  const retryOptions = options.fetchRetryOptions ?? {};
  const staleMinutes = options.lockStaleMinutes ?? MIRROR_LOCK_STALE_MINUTES;
  const root = resolve(options.mirrorRoot ?? repoMirrorRoot(config));
  const workspaceRoot = resolve(config.workspaceRoot);
  if (insideOrEqual(root, workspaceRoot) || insideOrEqual(workspaceRoot, root)) {
    throw new Error(`Runner repository mirror root ${root} overlaps the workspace root ${workspaceRoot}`);
  }
  await shell(config, execute, cwd, env, ENSURE_ROOT, root, String(staleMinutes));
  const mirror = repoMirrorPath(root, remoteUrl);
  const release = await acquireMirrorLock(
    config, execute, cwd, env, `${mirror}.lock`, config.runnerId, options, report,
  );
  try {
    const state = await shell(config, execute, cwd, env, PROBE, mirror);
    if (state === "unusable") throw new RepoMirrorError(mirror, "not-a-directory");
    if (state === "present") {
      await validateMirror(config, mirror, remoteUrl, cwd, env, execute);
      await configureMirror(config, mirror, cwd, env, execute);
      await fetchFromRemote(config, mirror, [...REFRESH_ARGS], cwd, env, execute, retryOptions);
      report({ event: "refreshed", mirror });
    } else {
      await createMirror(config, root, mirror, remoteUrl, cwd, env, execute, retryOptions, report);
      report({ event: "created", mirror });
    }
    return await use(mirror);
  } finally {
    await release();
    report({ event: "elapsed", mirror, elapsedMs: Date.now() - started });
  }
};
