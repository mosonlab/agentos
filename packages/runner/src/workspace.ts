import { appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import type { ClaimedTask } from "./api.js";
import { defaultSessionConfigBaselineRoot, runnerProxyEnvironment, type RunnerConfig, type RunnerKind } from "./config.js";
import { materializeWorkspaceDependencies, type DependencyCacheOptions } from "./dependency-cache.js";
import { runCommand, type CommandOptions } from "./exec.js";
import { type RetryOptions } from "./network-retry.js";
import {
  ensureMirrorRevisions, mirrorHasBranch, withRepoMirror, type RepoMirrorOptions,
} from "./repo-mirror.js";

export type Workspace = {
  path: string;
  branch: string;
  baseSha: string;
  /** Present only for an object-id-only detached checkout. */
  pinnedBaseSha?: string;
};

const inside = (root: string, candidate: string): boolean => candidate.startsWith(`${root}${sep}`);

export type WorkspaceCommandExecutor = (
  config: RunnerConfig,
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options?: CommandOptions,
) => Promise<string>;

/**
 * Every workspace mutation runs through here so that, when RUNNER_RUN_AS_PREFIX
 * is set, whatever it creates is owned by the launched account rather than by
 * the runner daemon's own uid. `input` exists for the same reason: a secret
 * reaches the launched account on stdin, never in argv, which `ps` shows to
 * every account on the host.
 *
 * It delegates to exec.ts's runCommand like every other external command in the
 * runner — the process-group kill and the timeout ceiling are not properties a
 * second spawn point should be allowed to miss.
 */
const commandWithInput = (
  config: Pick<RunnerConfig, "runAsPrefix">,
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input: string | null,
): Promise<string> => runCommand(
  config.runAsPrefix, executable, args, cwd, env, input === null ? {} : { input },
);

const command: WorkspaceCommandExecutor = (
  config: RunnerConfig,
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: CommandOptions = {},
): Promise<string> => runCommand(config.runAsPrefix, executable, args, cwd, env, options);

export const workspaceEnvironment = (
  config: Pick<RunnerConfig, "path" | "home" | "runAsPrefix">
    & Partial<Pick<RunnerConfig, "gateServer">>
    & Partial<Pick<RunnerConfig, "proxyEnvironment">>,
): NodeJS.ProcessEnv => ({
  PATH: config.path,
  HOME: config.home,
  LANG: "C.UTF-8",
  GIT_TERMINAL_PROMPT: "0",
  ...(config.gateServer ? { AGENTOS_GATE_SERVER: config.gateServer } : {}),
  ...(config.proxyEnvironment ?? runnerProxyEnvironment()),
  // macOS Keychain lookups (claude CLI auth) fail without the login identity.
  // Only the daemon's own identity is meant here: under a run-as prefix the
  // child is a different account, and telling it USER=<daemon owner> while
  // HOME is the launched account's home makes the CLI look up a Keychain and a
  // git identity for a user it is not running as. Leave the launcher to set it.
  ...(config.runAsPrefix.length === 0 && process.env.USER
    ? { USER: process.env.USER, LOGNAME: process.env.LOGNAME ?? process.env.USER }
    : {}),
});

export type AgentScratch = {
  /** The disposable directory both runner roots live in; removed when the run ends. */
  base: string;
  workspaceRoot: string;
  stateDir: string;
  /** A per-session CLI config root; it is outside `base` so failures can retain it. */
  configRoot: string;
};

export const sessionConfigBaselineRoot = defaultSessionConfigBaselineRoot;

const sessionConfigParent = async (): Promise<string> => {
  const parent = join(await realpath(tmpdir()), "agentos-session-config");
  await mkdir(parent, { recursive: true, mode: 0o711 });
  await chmod(parent, 0o711);
  return parent;
};

const sessionConfigPath = async (sessionId: string): Promise<string> => {
  if (!/^[A-Za-z0-9_-]+$/u.test(sessionId)) throw new Error(`Invalid session id for CLI config root: ${sessionId}`);
  return join(await sessionConfigParent(), sessionId, "config");
};

export const sessionConfigRootExists = async (scratch: AgentScratch): Promise<boolean> => {
  try {
    const info = await lstat(scratch.configRoot);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/**
 * A per-run disposable root for anything *inside* the run that resolves a
 * workspace root or a control-plane state dir from the environment.
 *
 * Both 2026-08-18 workspace-wipe incidents were replays of a bug that master
 * had already fixed: the runs executed checkouts pinned to older bases, whose
 * code still defaulted to the production ~/.agentos/runs and swept it. A
 * default lives in the checkout, which the runner cannot fix retroactively;
 * the environment lives in the runner, which always runs current code. So the
 * runner hands every session a throwaway root instead, and no base — however
 * old — can resolve its way back to production state.
 *
 * The two directories are siblings rather than nested: the control plane
 * refuses a state dir that overlaps its workspace root. The base is realpath'd
 * because the control plane also refuses aliased paths and symlinked path
 * components (on macOS os.tmpdir() sits under /var -> /private/var).
 */
export const provisionAgentScratch = async (config: RunnerConfig, sessionId = `anonymous-${randomUUID()}`): Promise<AgentScratch> => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "agentos-run-scratch-")));
  const workspaceRoot = join(base, "workspaces");
  const stateDir = join(base, "control-plane");
  // Deliberately name the root before it exists. If baseline or auth seeding
  // fails, the caller can report and retain the exact path it attempted.
  const configRoot = await sessionConfigPath(sessionId);
  if (config.runAsPrefix.length > 0) {
    // The session runs as another principal: it has to own what it writes, so
    // let it traverse the base and create both directories itself.
    await chmod(base, 0o711);
    await command(config, "/bin/mkdir", ["-m", "700", workspaceRoot, stateDir], base, workspaceEnvironment(config));
  } else {
    for (const directory of [workspaceRoot, stateDir]) {
      await mkdir(directory);
      // Exactly 0700, whatever the umask: the control plane rejects any other
      // mode on its state dir.
      await chmod(directory, 0o700);
    }
  }
  return { base, workspaceRoot, stateDir, configRoot };
};

export const cleanupAgentScratch = async (
  config: RunnerConfig,
  scratch: AgentScratch,
  options: { retainConfigRoot?: boolean } = {},
): Promise<void> => {
  const configParent = dirname(scratch.configRoot);
  if (config.runAsPrefix.length > 0) {
    const targetOwnedRoots = [
      scratch.workspaceRoot,
      scratch.stateDir,
      ...(options.retainConfigRoot ? [] : [scratch.configRoot]),
    ];
    await command(
      config,
      "/bin/sh",
      [
        "-c",
        'for root do [ ! -e "$root" ] || find "$root" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; done',
        "agentos-cleanup",
        ...targetOwnedRoots,
      ],
      await realpath(tmpdir()),
      workspaceEnvironment(config),
    );
    await Promise.all(targetOwnedRoots.map((root) => rm(root, { recursive: true, force: true })));
    if (!options.retainConfigRoot) await rm(configParent, { recursive: true, force: true });
  } else {
    await Promise.all([
      rm(scratch.workspaceRoot, { recursive: true, force: true }),
      rm(scratch.stateDir, { recursive: true, force: true }),
      ...(options.retainConfigRoot ? [] : [rm(scratch.configRoot, { recursive: true, force: true })]),
    ]);
    if (!options.retainConfigRoot) await rm(configParent, { recursive: true, force: true });
  }
  await rm(scratch.base, { recursive: true, force: true });
};

const codexBaselineFile = (config: RunnerConfig): string =>
  join(config.sessionConfigBaselineRoot ?? sessionConfigBaselineRoot(), "codex", "config.toml");

const sessionConfigOwnerUid = async (config: RunnerConfig, cwd: string): Promise<number> => {
  if (config.runAsPrefix.length > 0) {
    const uidText = await command(config, "/usr/bin/id", ["-u"], cwd, workspaceEnvironment(config));
    const uid = Number(uidText);
    if (!Number.isSafeInteger(uid) || uid < 0) throw new Error(`run-as launcher returned an invalid uid: ${uidText}`);
    return uid;
  }

  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("runner process uid is unavailable");
  return uid;
};

const validateSessionConfigRoot = async (configRoot: string, expectedOwnerUid: number): Promise<void> => {
  const info = await lstat(configRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`created path is not a real directory: ${configRoot}`);
  }
  if (info.uid !== expectedOwnerUid) {
    throw new Error(`created directory ${configRoot} has uid ${info.uid}, expected ${expectedOwnerUid}`);
  }
};

/**
 * Provision only the configuration a CLI is allowed to see. Codex receives the
 * repository baseline plus host auth; PI receives host auth only, deliberately
 * excluding host settings and every other discovery surface. Claude has no
 * config-home provisioner because its authentication remains in Keychain.
 */
export const provisionSessionConfig = async (
  config: RunnerConfig,
  runner: RunnerKind,
  scratch: AgentScratch,
  options: { reuse?: boolean } = {},
): Promise<void> => {
  if (runner === "CLAUDE") return;
  const runnerLabel = runner === "CODEX" ? "Codex" : "PI";
  if (options.reuse) {
    try {
      const info = await lstat(scratch.configRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("existing session config root is not a real directory");
      return;
    } catch (error: unknown) {
      throw new Error(`Unable to reuse ${runnerLabel} session CLI config root ${scratch.configRoot}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  const baseline = codexBaselineFile(config);
  const configParent = dirname(scratch.configRoot);
  try {
    await mkdir(configParent, { mode: 0o711 });
    await chmod(configParent, 0o711);
    const expectedOwnerUid = await sessionConfigOwnerUid(config, configParent);
    if (config.runAsPrefix.length > 0) {
      // Open the daemon-owned parent only for the one operation that needs it:
      // creation by the target uid. A failed mkdir must stop provisioning, and
      // the parent is made non-writable again before any baseline or auth copy.
      await chmod(configParent, 0o733);
      try {
        await command(config, "/bin/mkdir", ["-m", "700", scratch.configRoot], configParent, workspaceEnvironment(config));
      } finally {
        await chmod(configParent, 0o711);
      }
    } else {
      await mkdir(scratch.configRoot, { mode: 0o700 });
      await chmod(scratch.configRoot, 0o700);
    }

    await validateSessionConfigRoot(scratch.configRoot, expectedOwnerUid);
    if (runner === "CODEX") {
      if (config.runAsPrefix.length > 0) {
        await command(config, "/bin/cp", [baseline, join(scratch.configRoot, "config.toml")], configParent, workspaceEnvironment(config));
        await command(config, "/bin/chmod", ["600", join(scratch.configRoot, "config.toml")], configParent, workspaceEnvironment(config));
      } else {
        await copyFile(baseline, join(scratch.configRoot, "config.toml"));
        await chmod(join(scratch.configRoot, "config.toml"), 0o600);
      }
    }
  } catch (error: unknown) {
    await chmod(configParent, 0o711).catch(() => undefined);
    const sourceDescription = runner === "CODEX" ? ` from baseline ${baseline}` : "";
    const createFailure = runner === "CODEX"
      ? "Unable to create session CLI config root"
      : "Unable to create PI session CLI config root";
    throw new Error(`${createFailure} ${scratch.configRoot}${sourceDescription}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const source = runner === "CODEX"
    ? join(config.home, ".codex", "auth.json")
    : join(config.home, ".pi", "agent", "auth.json");
  const destination = join(scratch.configRoot, "auth.json");
  try {
    if (config.runAsPrefix.length > 0) {
      await command(config, "/bin/cp", [source, destination], configParent, workspaceEnvironment(config));
      await command(config, "/bin/chmod", ["600", destination], configParent, workspaceEnvironment(config));
    } else {
      await copyFile(source, destination);
      await chmod(destination, 0o600);
    }
  } catch (error: unknown) {
    throw new Error(`Unable to establish ${runnerLabel} authentication in ${scratch.configRoot} from ${source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    // The target account needed write access only long enough to create its
    // own 0700 root. Afterwards other runner accounts may traverse the
    // session-specific parent but cannot add, replace, or enumerate entries.
    await chmod(configParent, 0o711);
  }
};

export const provisionWorkspace = async (
  config: RunnerConfig,
  claim: ClaimedTask,
  execute: WorkspaceCommandExecutor = command,
  retryOptions: RetryOptions = {},
  dependencyCacheOptions: DependencyCacheOptions = {},
  mirrorOptions: RepoMirrorOptions = {},
): Promise<Workspace> => {
  const root = resolve(config.workspaceRoot);
  const workspace = resolve(root, claim.run.id);
  if (!inside(root, workspace)) throw new Error("Resolved workspace escaped the controlled root");
  const env = workspaceEnvironment(config);
  if (config.runAsPrefix.length > 0) {
    const rootInfo = await stat(root);
    if (!rootInfo.isDirectory()) throw new Error("RUNNER_WORKSPACE_ROOT is not a directory");
    // 0711, created through the prefix so the launched account owns it.
    //
    // Not 0700: node applies a child's `cwd` by chdir-ing in the forked child
    // *before* exec, so it runs as the daemon's uid, not the launched one. A
    // 0700 run directory would make every later spawn that works inside the
    // workspace — the CLI itself, capture, delivery — fail with EACCES before
    // the prefix ever ran.
    //
    // What 0711 buys is that a sibling account cannot enumerate the tree. It
    // does not make the checkout secret: files git writes are world-readable
    // and the paths are guessable. The boundary that matters for #117 is the
    // sticky workspace root, which is what stops one account unlinking or
    // renaming another's run directory; the session token is protected by its
    // own 0600 mode, and CLI credentials by the per-account home.
    await command(config, "/bin/sh", ["-c", 'mkdir "$1"; chmod 711 "$1"', "agentos-workspace", workspace], root, env);
  } else {
    await mkdir(root, { recursive: true, mode: 0o750 });
    await mkdir(workspace, { recursive: false, mode: 0o750 });
  }
  try {
    const target = claim.run.targetBranch ?? claim.repo.defaultBranch;
    const branch = claim.run.branch ?? `agentos/${claim.task.id}/run-${claim.run.runNumber}`;
    const pinnedBaseSha = claim.run.pinnedBaseSha;
    // Dependencies are materialised after the mirror lock is released: `npm ci`
    // is bounded in half-hours, and holding a machine-wide lock across it would
    // serialise every other run on the host behind an install that never
    // touches the mirror.
    //
    // The mirror belongs to the account that runs the task, and `root` is what
    // the daemon can chdir into before the run-as prefix takes over.
    const provisioned = await withRepoMirror(
      config,
      claim.repo.remoteUrl,
      root,
      env,
      execute,
      { fetchRetryOptions: retryOptions, ...mirrorOptions },
      async (mirror): Promise<Workspace> => {
        if (pinnedBaseSha) {
          const implementationBaseSha = claim.run.implementationBaseSha;
          if (!implementationBaseSha || claim.run.implementationHeadSha !== pinnedBaseSha) {
            throw new Error(`Pinned run ${claim.run.id} is missing its immutable implementation range`);
          }
          // A branch clone would advertise and fetch the shared chain ref before
          // a blind reviewer starts. Build an empty repository, fetch the
          // immutable implementation range endpoints by object id, and stay
          // detached at its head. With no fetch of the chain branch, successor
          // commits and their report artifacts are not reachable from this
          // object database — and fetching by object id keeps that true when the
          // source is the mirror, which does carry the chain ref: a fetch
          // transfers only what the requested objects reach, never the mirror's
          // other refs.
          await ensureMirrorRevisions(
            config, mirror, [implementationBaseSha, pinnedBaseSha], root, env, execute, retryOptions,
          );
          await execute(config, "git", ["init"], workspace, env);
          await execute(config, "git", ["remote", "add", "origin", claim.repo.remoteUrl], workspace, env);
          // Local transport: slow on a large range, but it cannot hang on a
          // network that is no longer in the path, so it carries no ceiling.
          await execute(config, "git", ["fetch", "--no-tags", mirror, implementationBaseSha, pinnedBaseSha], workspace, env);
          await execute(config, "git", ["checkout", "--detach", pinnedBaseSha], workspace, env);
          const baseSha = await execute(config, "git", ["rev-parse", "HEAD"], workspace, env);
          if (baseSha !== pinnedBaseSha) {
            throw new Error(`Pinned workspace resolved ${baseSha}, expected ${pinnedBaseSha}`);
          }
          return { path: workspace, branch, baseSha, pinnedBaseSha };
        }
        // The publication ACK is fenced and immediate, but no database protocol
        // can eliminate a crash between the remote accepting git push and that
        // ACK. When the run's intended head already exists remotely, clone that
        // durable truth instead of the stale fallback base. Derived chain heads
        // are unique per project+chain, so this cannot accidentally adopt
        // another chain.
        //
        // The mirror was pruned against the remote moments ago, so its refs are
        // the same answer `git ls-remote` used to make a round trip for.
        let cloneTarget = target;
        if (branch !== target && !claim.run.targetBranchPublished
          && await mirrorHasBranch(config, mirror, branch, root, env, execute)) {
          cloneTarget = branch;
        }
        if (!await mirrorHasBranch(config, mirror, cloneTarget, root, env, execute)) {
          // The mirror was pruned against the remote moments ago, so this is the
          // remote's answer, not a mirror fault: the branch the run was told to
          // start from does not exist.
          throw new Error(`Branch ${cloneTarget} is absent from ${claim.repo.remoteUrl}`);
        }
        // Local clone: git hardlinks the object database instead of copying it,
        // which is what turns a two-minute transfer into a disk operation. The
        // hardlinks survive the mirror repacking later, because unlinking a
        // packfile the workspace also links does not free it. Where the kernel
        // refuses the link — Linux protected_hardlinks, with the mirror owned by
        // the daemon and the clone running as another account — git copies the
        // file instead. That is still local disk, and still not the remote.
        await execute(config, "git", ["clone", "--branch", cloneTarget, "--single-branch", mirror, workspace], root, env);
        // Delivery pushes to `origin`; the mirror is a provisioning detail and
        // must never become the run's publication target.
        await execute(config, "git", ["remote", "set-url", "origin", claim.repo.remoteUrl], workspace, env);
        const baseSha = await execute(config, "git", ["rev-parse", "HEAD"], workspace, env);
        if (branch !== cloneTarget) await execute(config, "git", ["switch", "-c", branch], workspace, env);
        return { path: workspace, branch, baseSha };
      },
    );
    await materializeWorkspaceDependencies(config, workspace, env, execute, dependencyCacheOptions);
    return provisioned;
  } catch (error: unknown) {
    await cleanupWorkspace(config, workspace).catch(() => undefined);
    throw error;
  }
};

export const reuseWorkspace = async (config: RunnerConfig, claim: ClaimedTask): Promise<Workspace> => {
  if (!claim.run.workspacePath || !claim.run.branch || !claim.run.baseSha) throw new Error("Resumed Run is missing workspace metadata");
  const root = resolve(config.workspaceRoot);
  const workspace = resolve(claim.run.workspacePath);
  if (!inside(root, workspace)) throw new Error("Resumed workspace escaped the controlled root");
  const info = await stat(workspace);
  if (!info.isDirectory()) throw new Error("Resumed workspace is not a directory");
  return {
    path: workspace,
    branch: claim.run.branch,
    baseSha: claim.run.baseSha,
    ...(claim.run.pinnedBaseSha ? { pinnedBaseSha: claim.run.pinnedBaseSha } : {}),
  };
};

/**
 * Session credentials for the AgentOS MCP server, written per claim because the
 * session token and fencing token are reissued on every claim.
 *
 * They live in a 0600 file rather than only in the child environment because
 * codex spawns MCP servers with a scrubbed environment. The file is inside the
 * throwaway workspace, so it dies with it; git is told to ignore it locally so
 * an agent running `git add -A` cannot commit it.
 */
export const writeSessionCredentials = async (
  config: Pick<RunnerConfig, "apiUrl" | "path" | "home" | "runAsPrefix">,
  claim: ClaimedTask,
  workspace: Workspace,
): Promise<string> => {
  const directory = join(workspace.path, ".agentos");
  const path = join(directory, "session.json");
  const exclude = join(workspace.path, ".git", "info", "exclude");
  const payload = JSON.stringify({
    apiUrl: config.apiUrl,
    runId: claim.run.id,
    sessionToken: claim.sessionToken,
    fencingToken: claim.fencingToken,
    workspacePath: workspace.path,
  });
  if (config.runAsPrefix.length > 0) {
    // Under a run-as prefix the workspace tree belongs to the launched account:
    // this uid can neither create the directory nor leave the MCP server a 0600
    // file it is able to read. Writing through the prefix is what makes the
    // file's owner and its reader the same account. `umask 077` closes the
    // window in which the token would exist under the default 0644.
    const env = workspaceEnvironment(config);
    await commandWithInput(config, "/bin/sh", ["-c", 'umask 077; mkdir -p "$1"; chmod 700 "$1"', "agentos-credentials", directory], workspace.path, env, null);
    await commandWithInput(config, "/bin/sh", ["-c", 'umask 077; cat > "$1"; chmod 600 "$1"', "agentos-credentials", path], workspace.path, env, payload);
    await commandWithInput(config, "/bin/sh", ["-c", 'cat >> "$1"', "agentos-credentials", exclude], workspace.path, env, "\n/.agentos/\n").catch(() => undefined);
    return path;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, payload, { mode: 0o600 });
  await appendFile(exclude, "\n/.agentos/\n").catch(() => undefined);
  return path;
};

export const captureWorkspaceResult = async (
  config: RunnerConfig,
  workspace: Workspace,
): Promise<{ branch: string; baseSha: string; headSha: string }> => {
  const env = workspaceEnvironment(config);
  const branch = workspace.pinnedBaseSha
    ? workspace.branch
    : await command(config, "git", ["branch", "--show-current"], workspace.path, env);
  const headSha = await command(config, "git", ["rev-parse", "HEAD"], workspace.path, env);
  return { branch, baseSha: workspace.baseSha, headSha };
};

export const cleanupWorkspace = async (
  config: RunnerConfig,
  workspacePath: string,
): Promise<void> => {
  const root = resolve(config.workspaceRoot);
  const workspace = resolve(workspacePath);
  if (!inside(root, workspace) || workspace === root) throw new Error("Refusing to clean a path outside the controlled workspace root");
  if (config.runAsPrefix.length > 0) {
    await command(config, "/bin/rm", ["-rf", "--", workspace], root, workspaceEnvironment(config));
  } else {
    await rm(workspace, { recursive: true, force: true });
  }
};
