import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";

import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { CLONE_COMMAND_TIMEOUT_MS, NETWORK_COMMAND_TIMEOUT_MS } from "./network-retry.js";
import {
  cleanupAgentScratch, provisionAgentScratch, provisionWorkspace, workspaceEnvironment, writeSessionCredentials,
  type WorkspaceCommandExecutor,
} from "./workspace.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("provisioning trusts an already-published intended head after its database ACK was lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-publication-"));
  try {
    const remote = join(root, "origin.git");
    const seed = join(root, "seed");
    git(root, "init", "--bare", remote);
    git(root, "init", "--initial-branch=main", seed);
    git(seed, "config", "user.name", "AgentOS Test");
    git(seed, "config", "user.email", "runner@agentos.local");
    await writeFile(join(seed, "tree.txt"), "base\n");
    git(seed, "add", "tree.txt");
    git(seed, "commit", "-m", "base");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");
    git(seed, "switch", "-c", "agentos/chain/demo-deadbeef");
    await writeFile(join(seed, "tree.txt"), "published\n");
    git(seed, "commit", "-am", "published before ACK loss");
    git(seed, "push", "-u", "origin", "agentos/chain/demo-deadbeef");
    const publishedSha = git(seed, "rev-parse", "HEAD");

    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: process.env.HOME ?? root,
    } as unknown as RunnerConfig;
    const claim = {
      task: { id: "task-1" },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: {
        id: "run-2",
        runNumber: 2,
        // Database evidence was lost, so the resolver selected main even
        // though the intended shared head is already durable on the remote.
        targetBranch: "main",
        branch: "agentos/chain/demo-deadbeef",
      },
    } as ClaimedTask;

    const workspace = await provisionWorkspace(config, claim);
    assert.equal(workspace.branch, "agentos/chain/demo-deadbeef");
    assert.equal(workspace.baseSha, publishedSha);
    assert.equal(await readFile(join(workspace.path, "tree.txt"), "utf8"), "published\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pinned workspace fetches only the recorded commit and never creates the chain ref", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-pinned-"));
  try {
    const remote = join(root, "origin.git");
    const seed = join(root, "seed");
    git(root, "init", "--bare", remote);
    git(root, "init", "--initial-branch=main", seed);
    git(seed, "config", "user.name", "AgentOS Test");
    git(seed, "config", "user.email", "runner@agentos.local");
    await writeFile(join(seed, "base.txt"), "review base\n");
    git(seed, "add", "base.txt");
    git(seed, "commit", "-m", "review base");
    const implementationBaseSha = git(seed, "rev-parse", "HEAD");
    await writeFile(join(seed, "implementation.txt"), "delivered\n");
    git(seed, "add", "implementation.txt");
    git(seed, "commit", "-m", "implementation");
    const pinnedBaseSha = git(seed, "rev-parse", "HEAD");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");
    const chainBranch = "agentos/chain/blind-demo";
    git(seed, "switch", "-c", chainBranch);
    await writeFile(join(seed, "successor-report.md"), "must stay unreachable\n");
    git(seed, "add", "successor-report.md");
    git(seed, "commit", "-m", "successor artifact");
    const successorSha = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "-u", "origin", chainBranch);

    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: process.env.HOME ?? root,
    } as unknown as RunnerConfig;
    const claim = {
      task: { id: "task-blind" },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: {
        id: "run-blind",
        runNumber: 1,
        targetBranch: pinnedBaseSha,
        pinnedBaseSha,
        implementationBaseSha,
        implementationHeadSha: pinnedBaseSha,
        branch: chainBranch,
      },
    } as ClaimedTask;

    const workspace = await provisionWorkspace(config, claim);
    assert.equal(workspace.baseSha, pinnedBaseSha);
    assert.equal(git(workspace.path, "branch", "--show-current"), "");
    assert.equal(git(workspace.path, "for-each-ref", "--format=%(refname)"), "");
    assert.doesNotThrow(() => git(workspace.path, "cat-file", "-e", `${implementationBaseSha}^{commit}`));
    assert.equal(await readFile(join(workspace.path, "implementation.txt"), "utf8"), "delivered\n");
    await assert.rejects(readFile(join(workspace.path, "successor-report.md")), /ENOENT/u);
    assert.throws(
      () => git(workspace.path, "cat-file", "-e", `${successorSha}^{commit}`),
      /Command failed/u,
      "the successor commit must not exist in the pinned workspace's object database",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace clone retries two transient failures and succeeds on the third attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-retry-"));
  try {
    let cloneCalls = 0;
    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: process.env.HOME ?? root,
    } as unknown as RunnerConfig;
    const claim = {
      task: { id: "task-retry" },
      repo: { remoteUrl: "https://github.com/acme/app.git", defaultBranch: "main" },
      run: { id: "run-retry", runNumber: 1, targetBranch: "main", branch: "main" },
    } as ClaimedTask;
    const fake = async (_config: RunnerConfig, executable: string, args: string[]): Promise<string> => {
      if (executable === "git" && args[0] === "clone") {
        cloneCalls += 1;
        if (cloneCalls < 3) throw new Error("fatal: unable to access remote: ECONNRESET");
      }
      if (executable === "git" && args[0] === "rev-parse") return "base-sha";
      return "";
    };
    const workspace = await provisionWorkspace(config, claim, fake, { wait: async () => undefined });
    assert.equal(cloneCalls, 3);
    assert.equal(workspace.baseSha, "base-sha");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cloning carries a per-command ceiling while local git commands stay uncapped", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-timeout-"));
  try {
    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: process.env.HOME ?? root,
    } as unknown as RunnerConfig;
    const claim = {
      task: { id: "task-timeout" },
      repo: { remoteUrl: "https://github.com/acme/app.git", defaultBranch: "main" },
      run: { id: "run-timeout", runNumber: 1, targetBranch: "main", branch: "agentos/task-timeout/run-1" },
    } as ClaimedTask;
    const ceilings = new Map<string, number | undefined>();
    const fake: WorkspaceCommandExecutor = async (_config, executable, args, _cwd, _env, options) => {
      ceilings.set(`${executable} ${args[0]}`, options?.timeoutMs);
      // Exit 2 from ls-remote: the intended head is not published yet.
      if (args[0] === "ls-remote") throw new Error("git failed (2): ");
      if (args[0] === "rev-parse") return "base-sha";
      return "";
    };
    await provisionWorkspace(config, claim, fake, { wait: async () => undefined });
    // Nothing bounds a hung clone before the agent starts, so the two commands
    // that talk to a remote are capped — the clone generously, because a large
    // repo is slow rather than hung and provisioning heartbeats cover slow.
    assert.equal(ceilings.get("git ls-remote"), NETWORK_COMMAND_TIMEOUT_MS);
    assert.equal(ceilings.get("git clone"), CLONE_COMMAND_TIMEOUT_MS);
    // ...while checkout of a huge tree is slow, not hung, and stays uncapped.
    assert.equal(ceilings.get("git rev-parse"), undefined);
    assert.equal(ceilings.get("git switch"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session credentials are created through the run-as prefix, with the token off the command line", async () => {
  // Without this, the daemon's own uid writes into a tree owned by the launched
  // account: the mkdir fails outright, and if it did not, the 0600 file would
  // belong to a user the MCP server is not running as and could not read.
  const root = await mkdtemp(join(tmpdir(), "agentos-credentials-prefix-"));
  try {
    const workspacePath = join(root, "run-1");
    await mkdir(join(workspacePath, ".git", "info"), { recursive: true });
    const log = join(root, "prefix.log");
    const launcher = join(root, "run-as.sh");
    // Stands in for `sudo -u agentrunner`: same uid, but it records the argv it
    // was handed, which is what proves the write went through the prefix.
    await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexec "$@"\n`, { mode: 0o755 });
    const config = {
      apiUrl: "http://api.local",
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: root,
      runAsPrefix: [launcher],
    } as unknown as RunnerConfig;
    const claim = {
      run: { id: "run-1" },
      sessionToken: "session-token-never-in-argv",
      fencingToken: "fencing-token-never-in-argv",
    } as ClaimedTask;

    const path = await writeSessionCredentials(config, claim, { path: workspacePath, branch: "topic", baseSha: "base" });

    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      apiUrl: "http://api.local",
      runId: "run-1",
      sessionToken: "session-token-never-in-argv",
      fencingToken: "fencing-token-never-in-argv",
      workspacePath,
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(workspacePath, ".agentos"))).mode & 0o777, 0o700);
    assert.match(await readFile(join(workspacePath, ".git", "info", "exclude"), "utf8"), /\/\.agentos\//u);

    const argv = await readFile(log, "utf8");
    assert.match(argv, /mkdir -p/u, "the credentials directory must be created by the launched account");
    assert.ok(!argv.includes("session-token-never-in-argv"), "a token in argv is readable by every account through ps");
    assert.ok(!argv.includes("fencing-token-never-in-argv"), "a token in argv is readable by every account through ps");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the run-as prefix keeps the launcher's own login identity out of the launched account's environment", () => {
  const base = { path: "/bin", home: "/opt/agentos/accounts/_agentos1" };
  const launched = workspaceEnvironment({ ...base, runAsPrefix: ["sudo", "-u", "agentrunner"] });
  // USER=<daemon owner> alongside HOME=<launched account> sends the CLI's
  // Keychain and git identity lookups at an account it is not running as.
  assert.equal(launched.USER, undefined);
  assert.equal(launched.LOGNAME, undefined);
  assert.equal(launched.HOME, "/opt/agentos/accounts/_agentos1");
  assert.equal(workspaceEnvironment({ ...base, runAsPrefix: [] }).USER, process.env.USER);
});

test("a run-as workspace is provisioned by the launched account and cannot be enumerated by its siblings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-prefix-"));
  try {
    const remote = join(root, "origin.git");
    const seed = join(root, "seed");
    git(root, "init", "--bare", remote);
    git(root, "init", "--initial-branch=main", seed);
    git(seed, "config", "user.name", "AgentOS Test");
    git(seed, "config", "user.email", "runner@agentos.local");
    await writeFile(join(seed, "tree.txt"), "base\n");
    git(seed, "add", "tree.txt");
    git(seed, "commit", "-m", "base");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");

    const workspaceRoot = join(root, "runs");
    await mkdir(workspaceRoot);
    const log = join(root, "prefix.log");
    const launcher = join(root, "run-as.sh");
    await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexec "$@"\n`, { mode: 0o755 });
    const config = {
      workspaceRoot,
      runAsPrefix: [launcher],
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: root,
    } as unknown as RunnerConfig;
    const claim = {
      task: { id: "task-prefix" },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: { id: "run-prefix", runNumber: 1, targetBranch: "main", branch: "main" },
    } as ClaimedTask;

    const workspace = await provisionWorkspace(config, claim);

    // Traverse but not list. It cannot be 0700: node chdirs into `cwd` as the
    // daemon's uid before exec, so the CLI's own spawn would fail with EACCES
    // against a directory only the launched account can enter.
    assert.equal((await stat(workspace.path)).mode & 0o777, 0o711);
    const argv = await readFile(log, "utf8");
    assert.match(argv, /git clone/u, "the clone must run as the launched account, or it owns nothing it later deletes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Chain and salvage runs execute checkouts pinned to bases that predate any
// given safety fix, so a run can still resolve the production workspace root
// from a stale default and sweep it (2026-08-18, twice, run
// cmsyab8e200p2mp76pfhxl5xe). The runner always runs current code, so it is
// the only place that can contain every base: it hands the session throwaway
// roots via the environment.
//
// Both prefixes are covered: with a run-as launcher the session principal has
// to create the directories itself, which is a different code path from the
// direct mkdir. `/usr/bin/env --` is a launcher that changes no identity, so
// the branch is exercised without the test needing to become another user.
for (const runAsPrefix of [[], ["/usr/bin/env", "--"]]) {
  const label = runAsPrefix.length > 0 ? "behind a run-as launcher" : "directly";
  test(`agent scratch gives a run disposable roots the control plane will accept, provisioned ${label}`, async () => {
    const config = {
      workspaceRoot: join(await mkdtemp(join(tmpdir(), "agentos-configured-root-")), "runs"),
      runAsPrefix,
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: process.env.HOME ?? tmpdir(),
    } as unknown as RunnerConfig;

    const scratch = await provisionAgentScratch(config);
    try {
      assert.notEqual(scratch.workspaceRoot, config.workspaceRoot);
      assert.equal(scratch.workspaceRoot.startsWith(`${scratch.base}${sep}`), true);
      assert.equal(scratch.stateDir.startsWith(`${scratch.base}${sep}`), true);
      // Siblings, never nested: the control plane refuses a state dir that
      // overlaps its workspace root.
      assert.equal(scratch.stateDir.startsWith(`${scratch.workspaceRoot}${sep}`), false);
      assert.equal(scratch.workspaceRoot.startsWith(`${scratch.stateDir}${sep}`), false);

      for (const directory of [scratch.workspaceRoot, scratch.stateDir]) {
        const info = await stat(directory);
        assert.equal(info.isDirectory(), true);
        // The control plane demands exactly 0700 on its state dir.
        assert.equal(info.mode & 0o777, 0o700);
      }

      // Aliased paths and symlinked components are both rejected by the control
      // plane; macOS puts os.tmpdir() under /var -> /private/var.
      assert.equal(await realpath(scratch.base), scratch.base);
      for (let cursor = scratch.stateDir; dirname(cursor) !== cursor; cursor = dirname(cursor)) {
        assert.equal((await lstat(cursor)).isSymbolicLink(), false, `${cursor} is a symlink`);
      }

      // Disposable: under the system temp dir, not the configured root.
      assert.equal(scratch.base.startsWith(`${await realpath(tmpdir())}${sep}`), true);
    } finally {
      await cleanupAgentScratch(config, scratch);
    }
    await assert.rejects(stat(scratch.base));
  });
}
