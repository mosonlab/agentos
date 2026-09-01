import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { controlledGitEnvironment, prefixedCommand, splitRunAsPrefix } from "./git-launch.js";
import type { OnboardingInput } from "./onboarding.js";

export type DependencyProvisioning = "NONE" | "NPM_CI";

export type RepositoryPreflightFailure =
  | "git-unavailable"
  | "git-identity-missing"
  | "remote-unreachable"
  | "default-branch-missing"
  | "push-not-authorized"
  | "package-lock-missing"
  | "command-timeout";

export class RepositoryPreflightError extends Error {
  constructor(readonly reason: RepositoryPreflightFailure) {
    super(`repository-preflight-${reason}`);
    this.name = "RepositoryPreflightError";
  }
}

export interface RepositoryPreflightInput {
  remoteUrl: string;
  defaultBranch: string;
  dependencyProvisioning: DependencyProvisioning;
}

export type RepositoryPreflight = (input: RepositoryPreflightInput) => Promise<void>;

type CommandResult = { code: number | null; stdout: string };
export type RepositoryPreflightCommand = (
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

const COMMAND_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 64 * 1024;

const runCommand: RepositoryPreflightCommand = (executable, args, cwd, env) => new Promise((resolve, reject) => {
  const prefix = splitRunAsPrefix(process.env.RUNNER_RUN_AS_PREFIX ?? "");
  const launched = prefixedCommand(executable, args, prefix);
  const child = spawn(launched.executable, launched.args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let settled = false;
  const finish = (result: CommandResult | Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (result instanceof Error) reject(result); else resolve(result);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < OUTPUT_LIMIT) stdout += chunk.slice(0, OUTPUT_LIMIT - stdout.length);
  });
  child.once("error", (error: NodeJS.ErrnoException) => {
    finish(new RepositoryPreflightError(error.code === "ENOENT" ? "git-unavailable" : "remote-unreachable"));
  });
  child.once("close", (code) => finish({ code, stdout }));
  const timer = setTimeout(() => {
    if (child.pid === undefined) child.kill("SIGTERM");
    else try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    setTimeout(() => {
      if (settled) return;
      if (child.pid === undefined) child.kill("SIGKILL");
      else try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      finish(new RepositoryPreflightError("command-timeout"));
    }, 1_000).unref();
  }, COMMAND_TIMEOUT_MS);
  timer.unref();
});

const expectSuccess = async (
  run: RepositoryPreflightCommand,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  reason: RepositoryPreflightFailure,
): Promise<CommandResult> => {
  const result = await run("git", args, cwd, env);
  if (result.code !== 0) throw new RepositoryPreflightError(reason);
  return result;
};

const hasRootPackageLockBlob = (stdout: string): boolean => stdout.split("\0").some((entry) => {
  const match = /^(100644|100755) blob [0-9a-f]+\tpackage-lock\.json$/u.exec(entry.trim());
  return match !== null;
});

/**
 * Repository creation uses the same host-identity, remote, branch, fetch, and
 * dry-run-push checks as first-run onboarding, but deliberately exposes only
 * the values needed by those checks. In particular, a Repo credential
 * Secret is not part of this operation and cannot become an ambient Git
 * credential by accident.
 */
export const preflightRepository = async (
  input: RepositoryPreflightInput,
  run: RepositoryPreflightCommand = runCommand,
): Promise<void> => {
  const env = controlledGitEnvironment();
  const cwd = process.cwd();
  for (const key of ["user.name", "user.email"]) {
    const identity = await expectSuccess(run, ["config", "--global", "--get", key], cwd, env, "git-identity-missing");
    if (identity.stdout.trim() === "") throw new RepositoryPreflightError("git-identity-missing");
  }

  const ref = `refs/heads/${input.defaultBranch}`;
  const remote = input.remoteUrl;
  const read = await run("git", ["ls-remote", "--exit-code", "--heads", remote, ref], cwd, env);
  if (read.code === 2) throw new RepositoryPreflightError("default-branch-missing");
  if (read.code !== 0) throw new RepositoryPreflightError("remote-unreachable");

  const scratch = await mkdtemp(join(tmpdir(), "agentos-onboarding-preflight-"));
  try {
    await expectSuccess(run, ["init", "--bare", scratch], cwd, env, "git-unavailable");
    await expectSuccess(run, ["fetch", "--depth=1", remote, ref], scratch, env, "remote-unreachable");
    if (input.dependencyProvisioning === "NPM_CI") {
      const lockfile = await run("git", ["ls-tree", "-z", "FETCH_HEAD", "--", "package-lock.json"], scratch, env);
      if (lockfile.code !== 0 || !hasRootPackageLockBlob(lockfile.stdout)) {
        throw new RepositoryPreflightError("package-lock-missing");
      }
    }
    const probeRef = `refs/heads/agentos-preflight-${randomBytes(8).toString("hex")}`;
    await expectSuccess(run, ["push", "--dry-run", remote, `FETCH_HEAD:${probeRef}`], scratch, env, "push-not-authorized");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

export const preflightOnboardingRepository = async (
  input: OnboardingInput,
  run: RepositoryPreflightCommand = runCommand,
): Promise<void> => preflightRepository({
  remoteUrl: input.repo.remoteUrl,
  defaultBranch: input.repo.defaultBranch,
  dependencyProvisioning: "NONE",
}, run);
