import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RunnerConfig } from "./config.js";
import type { DependencyProvisioningDecision } from "./dependency-provisioning.js";
import { runCommand } from "./exec.js";
import {
  mirrorRevisionsPresent, repoMirrorPath, RepoMirrorError, withRepoMirror,
  type MirrorCommandExecutor, type RepoMirrorProgress,
} from "./repo-mirror.js";
import {
  provisionWorkspace, workspaceEnvironment,
  type WorkspaceCommandExecutor, type WorkspaceProvisionClaim,
} from "./workspace.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

type Fixture = { root: string; remote: string; seed: string; config: RunnerConfig; mirrorRoot: string; mirror: string };

const fixture = async (label: string): Promise<Fixture> => {
  // realpath: macOS resolves the temp root through /var -> /private/var, and the
  // mirror root is resolved before anything is created under it.
  const root = await realpath(await mkdtemp(join(tmpdir(), `agentos-repo-mirror-${label}-`)));
  const remote = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "init", "--initial-branch=main", seed);
  git(seed, "config", "user.name", "Anneal Test");
  git(seed, "config", "user.email", "runner@example.invalid");
  await writeFile(join(seed, "tree.txt"), "base\n");
  git(seed, "add", "tree.txt");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  const mirrorRoot = join(root, "mirrors");
  const config = {
    workspaceRoot: join(root, "workspaces"),
    repoMirrorRoot: mirrorRoot,
    // The mirror lives in the task account's home; here the fixture is it.
    home: root,
    runnerId: "runner-under-test",
    runAsPrefix: [],
    path: process.env.PATH ?? "/usr/bin:/bin",
    gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
  } as unknown as RunnerConfig;
  return { root, remote, seed, config, mirrorRoot, mirror: repoMirrorPath(mirrorRoot, remote) };
};

/** Mirror behaviour is what these tests provision for; no Run installs here. */
const NO_DEPENDENCIES = {
  provision: false,
  evidence: "Dependency provisioning skipped: Repo.dependencyProvisioning=NONE",
} as const satisfies DependencyProvisioningDecision;

const claimFor = (remote: string, id: string): WorkspaceProvisionClaim => ({
  executionMode: "agent",
  runner: "CODEX",
  specificationMaterialization: null,
  task: { id: `task-${id}`, chainId: null, chainIndex: null, templateStep: null },
  repo: { remoteUrl: remote, defaultBranch: "main" },
  run: {
    id: `run-${id}`,
    runNumber: 1,
    targetBranch: "main",
    targetBranchPublished: false,
    pinnedBaseSha: null,
    implementationBaseSha: null,
    implementationHeadSha: null,
    branch: "main",
  },
});

/** The production executor, with every argv it is handed recorded. */
const recorded = (calls: { args: string[]; cwd: string }[]): WorkspaceCommandExecutor =>
  async (config, executable, args, cwd, env, options = {}) => {
    calls.push({ args, cwd });
    return runCommand(config.runAsPrefix, executable, args, cwd, env, options);
  };

const passthrough: MirrorCommandExecutor = (config, executable, args, cwd, env, options = {}) =>
  runCommand(config.runAsPrefix, executable, args, cwd, env, options);


const silent = (): ((progress: RepoMirrorProgress) => void) => (): void => undefined;

test("the second run reuses the machine's mirror and fetches only what changed", async () => {
  const { root, remote, seed, config, mirror } = await fixture("reuse");
  try {
    await provisionWorkspace(config, claimFor(remote, "one"), NO_DEPENDENCIES, { mirrorOptions: { report: silent() } });
    const created = (await stat(mirror)).birthtimeMs;

    await writeFile(join(seed, "tree.txt"), "second\n");
    git(seed, "commit", "-am", "second");
    git(seed, "push", "origin", "main");
    const head = git(seed, "rev-parse", "HEAD");

    const calls: { args: string[]; cwd: string }[] = [];
    const workspace = await provisionWorkspace(
      config,
      claimFor(remote, "two"),
      NO_DEPENDENCIES,
      { execute: recorded(calls), mirrorOptions: { report: silent() } },
    );

    // Same mirror directory, not a rebuilt one, and the run sees the commit
    // pushed after it was created — so the refresh really did reach the remote.
    assert.equal((await stat(mirror)).birthtimeMs, created);
    assert.equal(workspace.baseSha, head);
    assert.equal(await readFile(join(workspace.path, "tree.txt"), "utf8"), "second\n");

    // Nothing in the run touched the remote except the mirror's own fetch.
    const remoteReaders = calls.filter(({ args }) => args.includes(remote));
    assert.deepEqual(remoteReaders.map(({ args }) => args[0]), ["remote"]);
    const clone = calls.find(({ args }) => args[0] === "clone");
    assert.equal(clone?.args.at(-2), mirror);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the mirror carries branches and tags but not the remote's other refs", async () => {
  const { root, remote, seed, config, mirror } = await fixture("refspec");
  try {
    git(seed, "tag", "v1");
    git(seed, "push", "origin", "v1");
    // GitHub advertises refs/pull/*; no run has ever needed it and mirroring it
    // would make every fetch pay for the repository's whole review history.
    git(seed, "push", "origin", "HEAD:refs/pull/7/head");

    await provisionWorkspace(config, claimFor(remote, "refspec"), NO_DEPENDENCIES, { mirrorOptions: { report: silent() } });

    const refs = git(mirror, "for-each-ref", "--format=%(refname)").split("\n");
    assert.equal(refs.includes("refs/heads/main"), true);
    assert.equal(refs.includes("refs/tags/v1"), true);
    assert.equal(refs.includes("refs/pull/7/head"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a mirror pointing at a different remote is refused instead of quietly re-cloning", async () => {
  const { root, remote, config, mirror } = await fixture("mismatch");
  try {
    await provisionWorkspace(config, claimFor(remote, "first"), NO_DEPENDENCIES, { mirrorOptions: { report: silent() } });
    git(mirror, "remote", "set-url", "origin", "https://github.com/acme/somewhere-else.git");

    const failure = await provisionWorkspace(
      config,
      claimFor(remote, "second"),
      NO_DEPENDENCIES,
      { mirrorOptions: { report: silent() } },
    ).then(() => null, (error: unknown) => error);
    assert.equal(failure instanceof RepoMirrorError, true);
    assert.equal((failure as RepoMirrorError).condition, "remote-url-mismatch");
    assert.match((failure as RepoMirrorError).message, /refuses to fall back to a full remote clone/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a mirror that is not a readable git repository is refused, not rebuilt", async () => {
  const { root, remote, config, mirror } = await fixture("corrupt");
  try {
    await mkdir(mirror, { recursive: true });
    await writeFile(join(mirror, "not-a-repository"), "\n");

    const failure = await provisionWorkspace(
      config,
      claimFor(remote, "corrupt"),
      NO_DEPENDENCIES,
      { mirrorOptions: { report: silent() } },
    ).then(() => null, (error: unknown) => error);
    assert.equal(failure instanceof RepoMirrorError, true);
    assert.equal((failure as RepoMirrorError).condition, "not-a-readable-git-repository");
    // The refusal leaves the evidence in place for whoever has to look at it.
    assert.equal((await stat(join(mirror, "not-a-repository"))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a held lock is waited for, and one left behind by a dead holder is stolen", async () => {
  const { root, remote, config, mirror } = await fixture("lock");
  const env = workspaceEnvironment(config);
  try {
    const lock = `${mirror}.lock`;
    await mkdir(join(root, "mirrors"), { recursive: true });
    await mkdir(lock);

    const refused = await withRepoMirror(
      config, remote, root, env, passthrough,
      { lockWaitMs: 10, lockPollMs: 1, report: silent() },
      async () => "unreachable",
    ).then(() => null, (error: unknown) => error);
    assert.match((refused as Error).message, /waiting for the runner repository mirror lock/u);

    // Backdated past the staleness threshold. A live holder touches its own
    // lock every heartbeat, so only a dead one can get this old.
    const stale = new Date(Date.now() - 3_600_000);
    await utimes(lock, stale, stale);
    let steals = 0;
    const taken = await withRepoMirror(
      config, remote, root, env, passthrough,
      {
        lockWaitMs: 10,
        lockPollMs: 1,
        report: (progress) => { if (progress.event === "lock-steal") steals += 1; },
      },
      async (path) => path,
    );
    assert.equal(taken, mirror);
    assert.equal(steals, 1);
    // Released on the way out, or the next run on this machine would wait ten
    // minutes for a mirror nobody is holding.
    await assert.rejects(stat(lock));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file where the lock directory belongs is stolen rather than waited on", async () => {
  const { root, remote, config, mirror } = await fixture("lock-file");
  const env = workspaceEnvironment(config);
  try {
    // What a heartbeat that raced its own release leaves behind. No mkdir can
    // ever acquire it, so waiting out the stale window would wedge the machine
    // for nothing.
    await mkdir(join(root, "mirrors"), { recursive: true });
    await writeFile(`${mirror}.lock`, "");
    const taken = await withRepoMirror(
      config, remote, root, env, passthrough,
      { lockWaitMs: 10, lockPollMs: 1, report: silent() },
      async (path) => path,
    );
    assert.equal(taken, mirror);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a holder that was taken over does not delete its successor's lock", async () => {
  const { root, remote, config, mirror } = await fixture("release");
  const env = workspaceEnvironment(config);
  const lock = `${mirror}.lock`;
  try {
    await withRepoMirror(config, remote, root, env, passthrough, { report: silent() }, async () => {
      // What a stale takeover looks like from inside the declared-dead holder:
      // its lock is gone and someone else's is at the path.
      await rm(lock, { recursive: true, force: true });
      await mkdir(lock);
      await writeFile(join(lock, "owner"), "successor\n");
      return null;
    });
    assert.equal((await readFile(join(lock, "owner"), "utf8")).trim(), "successor");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the mirror is private to the account that runs the tasks", async () => {
  const { root, remote, config, mirror, mirrorRoot } = await fixture("private");
  const previous = process.umask(0o022);
  try {
    await provisionWorkspace(config, claimFor(remote, "private"), NO_DEPENDENCIES, { mirrorOptions: { report: silent() } });
    // The mirror carries the same history as the run workspace and lives in the
    // task account's own home. Nothing outside that account has business
    // reading it, and a permissive umask must not decide otherwise.
    assert.equal((await stat(mirrorRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(mirror)).isDirectory(), true);
  } finally {
    process.umask(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("every mirror command runs through the run-as prefix, so the account with the credentials fetches", async () => {
  const { root, remote, config, mirrorRoot } = await fixture("run-as");
  try {
    const log = join(root, "prefix.log");
    const launcher = join(root, "run-as.sh");
    // Stands in for `sudo -u agentrunner`: same uid, but it records the argv it
    // was handed. The mirror lives in a launched account's 0700 home, which the
    // daemon's own uid cannot even enter — so anything the daemon did directly
    // would fail in a real OS-isolated deployment.
    await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexec "$@"\n`, { mode: 0o755 });
    const isolated = { ...config, runAsPrefix: [launcher] } as RunnerConfig;
    await mkdir(config.workspaceRoot, { recursive: true });

    await provisionWorkspace(isolated, claimFor(remote, "run-as"), NO_DEPENDENCIES, { mirrorOptions: { report: silent() } });

    const argv = await readFile(log, "utf8");
    assert.match(argv, /git init --bare/u);
    assert.match(argv, /git fetch --prune/u);
    assert.match(argv, /git clone --branch/u);
    // The mirror root, the lock and the staging directory are created by the
    // same account, not by node's fs as the daemon.
    assert.equal(argv.includes(`/bin/sh -c`), true);
    assert.equal(argv.includes(mirrorRoot), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a mirror root reached through a symlinked ancestor still counts as inside the workspace root", async () => {
  const { root, remote, config } = await fixture("overlap");
  const env = workspaceEnvironment(config);
  try {
    // Nothing textual connects these two paths; the link is what puts the
    // mirror inside the tree the runner reclaims between runs.
    await mkdir(config.workspaceRoot, { recursive: true });
    await symlink(config.workspaceRoot, join(root, "alias"));
    const overlapping = { ...config, repoMirrorRoot: join(root, "alias", "mirrors") } as RunnerConfig;

    await assert.rejects(
      withRepoMirror(overlapping, remote, root, env, passthrough, { report: silent() }, async () => undefined),
      /overlaps the workspace root/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staging the sweep could not remove is reported rather than swallowed", async () => {
  const { root, remote, config, mirrorRoot } = await fixture("staging");
  const env = workspaceEnvironment(config);
  const stranded = join(mirrorRoot, ".stage-abandoned");
  try {
    await mkdir(mirrorRoot, { recursive: true });
    // What a process killed between mktemp and mv leaves behind, aged past the
    // sweep's threshold and made unremovable the way a restrictive ACL or a
    // read-only filesystem would: rm cannot descend into it to empty it.
    await mkdir(stranded, { recursive: true });
    await writeFile(join(stranded, "HEAD"), "ref: refs/heads/main\n");
    const aged = new Date(Date.now() - 3_600_000);
    await utimes(stranded, aged, aged);
    await chmod(stranded, 0o000);

    const progress: RepoMirrorProgress[] = [];
    await withRepoMirror(
      config, remote, root, env, passthrough,
      { report: (event) => progress.push(event) },
      async () => undefined,
    );

    // The run still succeeds — a leaked copy is not a reason to refuse work —
    // but it names what is now occupying the disk instead of exiting 0 over it.
    assert.deepEqual(
      progress.filter((event) => event.event === "staging-retained").map((event) => event.mirror),
      [stranded],
    );
  } finally {
    await chmod(stranded, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("mirror git runs are addressed by GIT_DIR, never by entering the mirror the daemon cannot", async () => {
  const { root, remote, config, mirror } = await fixture("git-dir");
  const env = workspaceEnvironment(config);
  const runs: { args: string[]; cwd: string; gitDir: string | undefined }[] = [];
  const observed: MirrorCommandExecutor = (mirrorConfig, executable, args, cwd, commandEnv, options = {}) => {
    if (executable === "git") runs.push({ args, cwd, gitDir: commandEnv.GIT_DIR });
    return runCommand(mirrorConfig.runAsPrefix, executable, args, cwd, commandEnv, options);
  };
  try {
    await withRepoMirror(config, remote, root, env, observed, { report: silent() }, async () => undefined);

    const bare = runs.filter((run) => run.args[0] === "fetch" || run.args[0] === "config");
    assert.equal(bare.length > 0, true);
    for (const run of bare) {
      // GIT_DIR, because node chdirs into cwd as the daemon's own uid before
      // the run-as prefix executes, and a task account's home is 0700.
      assert.equal(typeof run.gitDir, "string");
      assert.equal(run.cwd.startsWith(mirror), false);
      assert.equal(run.cwd, root);
      // The subcommand stays at argv[0] so network-retry's allowlist, and the
      // timeout riding on it, still match.
      assert.equal(run.args[0] === "fetch" || run.args[0] === "config", true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("object presence is read from cat-file's own answer, never from an exit code", async () => {
  const { root, remote, seed, config } = await fixture("objects");
  const env = workspaceEnvironment(config);
  try {
    const present = git(seed, "rev-parse", "HEAD");
    const absent = "0".repeat(40);
    const answers = await withRepoMirror(
      config, remote, root, env, passthrough, { report: silent() },
      (mirror) => mirrorRevisionsPresent(config, mirror, [present, absent], root, env, passthrough),
    );
    assert.equal(answers.get(present), true);
    assert.equal(answers.get(absent), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
