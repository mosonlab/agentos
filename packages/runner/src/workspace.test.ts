import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chown, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";

import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { CLONE_COMMAND_TIMEOUT_MS } from "./network-retry.js";
import {
  cleanupAgentScratch, provisionAgentScratch, provisionSessionConfig, provisionWorkspace, sessionConfigBaselineRoot,
  workspaceEnvironment, writeSessionCredentials,
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

test("a resolver-confirmed newer salvage base outranks an existing declared head", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-salvage-base-"));
  try {
    const remote = join(root, "origin.git");
    const seed = join(root, "seed");
    git(root, "init", "--bare", "--initial-branch=main", remote);
    git(root, "init", "--initial-branch=main", seed);
    git(seed, "config", "user.name", "AgentOS Test");
    git(seed, "config", "user.email", "runner@agentos.local");
    await writeFile(join(seed, "tree.txt"), "base\n");
    git(seed, "add", "tree.txt");
    git(seed, "commit", "-m", "base");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");
    const declared = "agentos/chain/shared";
    git(seed, "switch", "-c", declared);
    await writeFile(join(seed, "tree.txt"), "older declared\n");
    git(seed, "commit", "-am", "declared");
    git(seed, "push", "origin", declared);
    const salvage = "agentos/task-1/run-2";
    await writeFile(join(seed, "tree.txt"), "newer salvage\n");
    git(seed, "commit", "-am", "salvage");
    git(seed, "push", "origin", `HEAD:${salvage}`);
    const salvageSha = git(seed, "rev-parse", "HEAD");
    const config = {
      workspaceRoot: join(root, "workspaces"), runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin", home: process.env.HOME ?? root,
    } as unknown as RunnerConfig;
    const claim = {
      task: { id: "task-1" },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: {
        id: "run-3", runNumber: 3, targetBranch: salvage,
        targetBranchPublished: true, branch: declared,
      },
    } as ClaimedTask;
    const workspace = await provisionWorkspace(config, claim);
    assert.equal(workspace.branch, declared);
    assert.equal(workspace.baseSha, salvageSha);
    assert.equal(await readFile(join(workspace.path, "tree.txt"), "utf8"), "newer salvage\n");
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

test("the mirror fetch retries two transient failures and succeeds on the third attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-retry-"));
  try {
    let fetchCalls = 0;
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
      if (executable === "git" && args[0] === "fetch") {
        fetchCalls += 1;
        if (fetchCalls < 3) throw new Error("fatal: unable to access remote: ECONNRESET");
      }
      if (executable === "git" && args[0] === "clone") cloneCalls += 1;
      if (executable === "git" && args[0] === "for-each-ref") return args[2] ?? "";
      if (executable === "git" && args[0] === "rev-parse") return "base-sha";
      return "";
    };
    const workspace = await provisionWorkspace(config, claim, fake, { wait: async () => undefined });
    // The retried operation is now the mirror's fetch. The clone that follows
    // reads local disk, so retrying it would only repeat a failure that no
    // amount of waiting can change.
    assert.equal(fetchCalls, 3);
    assert.equal(cloneCalls, 1);
    assert.equal(workspace.baseSha, "base-sha");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type RecordedCommand = { args: string[]; cwd: string; timeoutMs: number | undefined };

const recordingExecutor = (
  calls: RecordedCommand[],
  answer: (args: string[]) => string,
): WorkspaceCommandExecutor => async (_config, _executable, args, cwd, _env, options) => {
  calls.push({ args, cwd, timeoutMs: options?.timeoutMs });
  return answer(args);
};

test("the mirror's remote fetch carries a per-command ceiling while local git commands stay uncapped", async () => {
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
    const calls: RecordedCommand[] = [];
    // Only main is published: the intended head's probe finds nothing, exactly
    // as the `ls-remote` round trip it replaced used to report.
    const fake = recordingExecutor(calls, (args) => {
      if (args[0] === "for-each-ref") return args[2] === "refs/heads/main" ? "refs/heads/main" : "";
      if (args[0] === "rev-parse") return "base-sha";
      return "";
    });
    await provisionWorkspace(config, claim, fake, { wait: async () => undefined });
    const ceiling = (name: string): number | undefined => calls.find(({ args }) => args[0] === name)?.timeoutMs;
    // The only command still talking to GitHub is the mirror's fetch, and a
    // hung one is what nothing else bounds before the agent starts.
    assert.equal(ceiling("fetch"), CLONE_COMMAND_TIMEOUT_MS);
    // The clone now reads local disk. Capping it would kill a working run on a
    // large repository to protect against a network that is no longer in play.
    assert.equal(ceiling("clone"), undefined);
    assert.equal(ceiling("for-each-ref"), undefined);
    assert.equal(ceiling("rev-parse"), undefined);
    assert.equal(ceiling("switch"), undefined);
    const clone = calls.find(({ args }) => args[0] === "clone");
    // macOS resolves the temp root through /var -> /private/var; the mirror
    // root is realpath'd before anything is created under it.
    const mirrors = join(await realpath(root), "repo-mirrors");
    assert.equal(clone?.args.at(-2)?.startsWith(mirrors), true, "the clone source must be the mirror");
    // Delivery pushes to origin: the mirror must not survive as the run's
    // publication target.
    assert.deepEqual(
      calls.find(({ args }) => args[0] === "remote" && args[1] === "set-url")?.args,
      ["remote", "set-url", "origin", "https://github.com/acme/app.git"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the pinned range is fetched out of the mirror, and only the mirror's own fetch is capped", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-pinned-timeout-"));
  try {
    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: process.env.HOME ?? root,
    } as unknown as RunnerConfig;
    const claim = {
      task: { id: "task-pinned-timeout" },
      repo: { remoteUrl: "https://github.com/acme/app.git", defaultBranch: "main" },
      run: {
        id: "run-pinned-timeout",
        runNumber: 1,
        targetBranch: "main",
        branch: "agentos/task-pinned-timeout/run-1",
        pinnedBaseSha: "pinned-sha",
        implementationBaseSha: "impl-base-sha",
        implementationHeadSha: "pinned-sha",
      },
    } as ClaimedTask;
    const calls: RecordedCommand[] = [];
    const fake = recordingExecutor(calls, (args) => {
      if (args[0] === "cat-file") return "impl-base-sha commit\npinned-sha commit";
      if (args[0] === "rev-parse") return "pinned-sha";
      return "";
    });
    await provisionWorkspace(config, claim, fake, { wait: async () => undefined });
    const remoteFetch = calls.find(({ args }) => args[0] === "fetch" && args.includes("origin"));
    const rangeFetch = calls.find(({ args }) => args[0] === "fetch" && args.includes("pinned-sha"));
    assert.equal(remoteFetch?.timeoutMs, CLONE_COMMAND_TIMEOUT_MS);
    // Both endpoints were already in the mirror, so the range is assembled from
    // local disk: slow on a long history, but it cannot hang.
    assert.equal(rangeFetch?.timeoutMs, undefined);
    assert.equal(rangeFetch?.args[2]?.startsWith(join(await realpath(root), "repo-mirrors")), true);
    assert.equal(calls.some(({ args }) => args[0] === "clone"), false);
    assert.equal(calls.find(({ args }) => args[0] === "init" && args.length === 1)?.timeoutMs, undefined);
    assert.equal(calls.find(({ args }) => args[0] === "checkout")?.timeoutMs, undefined);
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

test("workspace and Git commands receive the platform-owned proxy environment", () => {
  const proxyEnvironment = {
    HTTP_PROXY: "http://runner-proxy.invalid:7897",
    http_proxy: "http://runner-proxy.invalid:7897",
    HTTPS_PROXY: "http://runner-proxy.invalid:7897",
    https_proxy: "http://runner-proxy.invalid:7897",
    NO_PROXY: "localhost",
    no_proxy: "localhost",
  };
  const launched = workspaceEnvironment({
    path: "/bin", home: "/runner", runAsPrefix: [], proxyEnvironment,
  });
  for (const [name, value] of Object.entries(proxyEnvironment)) assert.equal(launched[name], value);
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

test("Codex session config contains only the platform baseline and host auth, then deletes on success", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-codex-config-"));
  const home = join(root, "runner-home");
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), '{"tokens":"host-only"}\n', { mode: 0o600 });
  const config = {
    workspaceRoot: join(root, "workspaces"),
    runAsPrefix: [],
    path: process.env.PATH ?? "/usr/bin:/bin",
    home,
    sessionConfigBaselineRoot: sessionConfigBaselineRoot(),
  } as unknown as RunnerConfig;
  const scratch = await provisionAgentScratch(config, "session-codex-config");
  try {
    await provisionSessionConfig(config, "CODEX", scratch);
    assert.equal(await readFile(join(scratch.configRoot, "config.toml"), "utf8"), await readFile(join(sessionConfigBaselineRoot(), "codex", "config.toml"), "utf8"));
    assert.equal(await readFile(join(scratch.configRoot, "auth.json"), "utf8"), '{"tokens":"host-only"}\n');
    assert.deepEqual((await readdir(scratch.configRoot)).sort(), ["auth.json", "config.toml"]);
    assert.equal((await stat(scratch.configRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(join(scratch.configRoot, "auth.json"))).mode & 0o777, 0o600);
    assert.equal((await readdir(scratch.configRoot)).includes("AGENTS.md"), false);
    await cleanupAgentScratch(config, scratch);
    await assert.rejects(stat(scratch.configRoot), /ENOENT/u);
  } finally {
    await rm(scratch.configRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("PI session config contains only host auth and excludes hostile host settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-pi-config-"));
  const home = join(root, "runner-home");
  const hostAgentDir = join(home, ".pi", "agent");
  await mkdir(hostAgentDir, { recursive: true });
  await writeFile(join(hostAgentDir, "auth.json"), '{"openai-codex":{"type":"oauth"}}\n', { mode: 0o600 });
  await writeFile(join(hostAgentDir, "settings.json"), '{"shellCommandPrefix":"hostile","defaultTools":[]}\n');
  await mkdir(join(hostAgentDir, "extensions"));
  await writeFile(join(hostAgentDir, "extensions", "hostile.ts"), "throw new Error('loaded host extension');\n");
  const config = {
    workspaceRoot: join(root, "workspaces"),
    runAsPrefix: [],
    path: process.env.PATH ?? "/usr/bin:/bin",
    home,
    sessionConfigBaselineRoot: sessionConfigBaselineRoot(),
  } as unknown as RunnerConfig;
  const scratch = await provisionAgentScratch(config, "session-pi-config");
  try {
    await provisionSessionConfig(config, "PI", scratch);
    assert.deepEqual(await readdir(scratch.configRoot), ["auth.json"]);
    assert.equal(await readFile(join(scratch.configRoot, "auth.json"), "utf8"), '{"openai-codex":{"type":"oauth"}}\n');
    assert.equal((await stat(scratch.configRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(join(scratch.configRoot, "auth.json"))).mode & 0o777, 0o600);
  } finally {
    await cleanupAgentScratch(config, scratch);
    await rm(root, { recursive: true, force: true });
  }
});

test("PI auth provisioning fails loudly without falling back to host settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-pi-config-failure-"));
  const home = join(root, "runner-home");
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(join(home, ".pi", "agent", "settings.json"), '{"defaultProjectTrust":"always"}\n');
  const config = {
    workspaceRoot: join(root, "workspaces"),
    runAsPrefix: [],
    path: process.env.PATH ?? "/usr/bin:/bin",
    home,
    sessionConfigBaselineRoot: sessionConfigBaselineRoot(),
  } as unknown as RunnerConfig;
  const scratch = await provisionAgentScratch(config, "session-pi-config-failure");
  try {
    await assert.rejects(provisionSessionConfig(config, "PI", scratch), (error: unknown) =>
      error instanceof Error
      && error.message.includes("Unable to establish PI authentication")
      && error.message.includes(scratch.configRoot));
    assert.deepEqual(await readdir(scratch.configRoot), []);
  } finally {
    await cleanupAgentScratch(config, scratch);
    await rm(root, { recursive: true, force: true });
  }
});

test("a distinct run-as uid can create and read its Codex config root", {
  skip: typeof process.getuid !== "function" || process.getuid() !== 0
    ? "requires root to exercise a genuinely distinct uid"
    : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-codex-distinct-uid-"));
  const targetUser = "daemon";
  const targetUid = Number(execFileSync("id", ["-u", targetUser], { encoding: "utf8" }).trim());
  const targetGid = Number(execFileSync("id", ["-g", targetUser], { encoding: "utf8" }).trim());
  const home = join(root, "runner-home");
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), '{"tokens":"target-only"}\n', { mode: 0o600 });
  await chown(root, targetUid, targetGid);
  await chown(home, targetUid, targetGid);
  await chown(join(home, ".codex"), targetUid, targetGid);
  await chown(join(home, ".codex", "auth.json"), targetUid, targetGid);
  const config = {
    workspaceRoot: join(root, "workspaces"),
    runAsPrefix: ["/usr/bin/sudo", "-n", "-u", targetUser, "--"],
    path: process.env.PATH ?? "/usr/bin:/bin",
    home,
    sessionConfigBaselineRoot: sessionConfigBaselineRoot(),
  } as unknown as RunnerConfig;
  const scratch = await provisionAgentScratch(config, "session-codex-distinct-uid");
  const configParent = dirname(scratch.configRoot);
  try {
    await provisionSessionConfig(config, "CODEX", scratch);
    assert.equal((await stat(scratch.configRoot)).uid, targetUid);
    assert.equal((await stat(join(scratch.configRoot, "auth.json"))).uid, targetUid);
    assert.equal(execFileSync("/usr/bin/sudo", ["-n", "-u", targetUser, "--", "/bin/cat", join(scratch.configRoot, "auth.json")], { encoding: "utf8" }), '{"tokens":"target-only"}\n');
    await cleanupAgentScratch(config, scratch);
    for (const removed of [scratch.configRoot, configParent, scratch.workspaceRoot, scratch.stateDir, scratch.base]) {
      await assert.rejects(stat(removed), /ENOENT/u);
    }
  } finally {
    await rm(scratch.base, { recursive: true, force: true });
    await rm(configParent, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex auth provisioning fails loudly without touching the host config", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-codex-config-failure-"));
  const home = join(root, "runner-home");
  await mkdir(join(home, ".codex"), { recursive: true });
  const config = {
    workspaceRoot: join(root, "workspaces"),
    runAsPrefix: [],
    path: process.env.PATH ?? "/usr/bin:/bin",
    home,
    sessionConfigBaselineRoot: sessionConfigBaselineRoot(),
  } as unknown as RunnerConfig;
  const scratch = await provisionAgentScratch(config, "session-codex-config-failure");
  try {
    await assert.rejects(provisionSessionConfig(config, "CODEX", scratch), (error: unknown) =>
      error instanceof Error
      && error.message.includes("Unable to establish Codex authentication")
      && error.message.includes(scratch.configRoot));
    assert.equal((await stat(scratch.configRoot)).isDirectory(), true);
    assert.equal(await readFile(join(scratch.configRoot, "config.toml"), "utf8"), await readFile(join(sessionConfigBaselineRoot(), "codex", "config.toml"), "utf8"));
  } finally {
    await cleanupAgentScratch(config, scratch, { retainConfigRoot: false });
    await rm(root, { recursive: true, force: true });
  }
});
