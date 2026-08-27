import { spawn } from "node:child_process";

/**
 * Grace between the SIGTERM and the SIGKILL sent to a timed-out command's
 * process group. Deliberately shorter than adapters.ts's 5s CLI grace: git and
 * gh have no shutdown work worth waiting for, and every second spent here is a
 * second of the run lease.
 */
export const KILL_GRACE_MS = 2_000;

/**
 * Worst-case wall clock a timed-out command can cost beyond its own timeout:
 * SIGTERM grace, then the same grace again before we stop waiting for a process
 * that ignored SIGKILL (uninterruptible sleep). network-retry.ts budgets with
 * this so a timeout can never quietly outlive the lease it was added to protect.
 */
export const KILL_OVERHEAD_MS = 2 * KILL_GRACE_MS;

export const platformCommitArgs = (message: string, pathspec?: string): string[] => [
  "-c", "user.name=AgentOS Runner",
  "-c", "user.email=runner@agentos.local",
  "-c", "commit.gpgSign=false",
  "-c", "core.hooksPath=/dev/null",
  "commit", "--no-verify", "-m", message,
  ...(pathspec === undefined ? [] : ["--", pathspec]),
];

export type CommandOptions = {
  /**
   * Wall-clock ceiling for the command. Omitting it means "no timeout", which
   * is the deliberate policy for local git commands (commit of a huge tree,
   * checkout of a huge repo): only the network allowlist in network-retry.ts
   * gets a ceiling, because only a network command can hang without failing.
   */
  timeoutMs?: number | undefined;
  /**
   * Written to the child's stdin, which is then closed. This is how a secret
   * reaches a command run under RUNNER_RUN_AS_PREFIX: argv is visible to every
   * account on the host through `ps`, and stdin is not. Omitting it leaves
   * stdin closed, so a command that unexpectedly reads it fails instead of
   * hanging on a terminal the daemon does not have.
   */
  input?: string | undefined;
};

/**
 * Thrown when, and only when, this module's own per-command timeout fired.
 *
 * It is a *type*, not a message token, because classification must be able to
 * tell it apart from every other "timed out" string in the runner — the CLI
 * preflight in adapters.ts already emits "preflight timed out after 30
 * seconds", and matching that as a network blip would make a missing binary
 * look retryable. network-retry.ts is the only place that reads this.
 */
export class CommandTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(executable: string, args: readonly string[], timeoutMs: number) {
    super(`${executable} ${args[0] ?? ""}`.trim() + ` timed out after ${timeoutMs}ms; its process group was killed`);
    this.name = "CommandTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export const isCommandTimeout = (error: unknown): error is CommandTimeoutError => error instanceof CommandTimeoutError;

/**
 * The single spawn point for the runner's external git/gh commands.
 *
 * The child leads its own process group (`detached`) so a timeout can kill the
 * whole tree. That is not a detail: `git clone` over https/ssh forks
 * git-remote-https and ssh helpers that hold the socket, and signalling only
 * the git parent leaves those helpers orphaned, still writing into a workspace
 * the runner is about to delete.
 */
export const runCommand = (
  runAsPrefix: readonly string[],
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: CommandOptions = {},
): Promise<string> => new Promise((resolve, reject) => {
  const prefixed = runAsPrefix.length > 0;
  const launcher = prefixed ? runAsPrefix[0]! : executable;
  const argv = prefixed ? [...runAsPrefix.slice(1), executable, ...args] : args;
  // Two spawns rather than one with a computed stdio tuple: the literal tuple
  // is what tells the node types that stdout and stderr are readable streams.
  const child = options.input === undefined
    ? spawn(launcher, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
    : spawn(launcher, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timedOut = false;
  // Two separate sets. `settleTimers` are about *this promise* and die with it;
  // the escalation timer is about the *process group* and must outlive it. A
  // group leader that obeys SIGTERM while a descendant ignores it (and has
  // redirected the inherited pipes) makes the child `close` fire first: if that
  // cancelled the pending SIGKILL, the descendant would survive as an orphan —
  // exactly the leak the process-group kill exists to prevent.
  const settleTimers: NodeJS.Timeout[] = [];
  const signalGroup = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    // Negative pid = the whole process group. A failure here means the group is
    // already gone, which is the outcome we wanted.
    try { process.kill(-pid, signal); } catch { /* already reaped */ }
  };
  const settle = (action: () => void): void => {
    if (settled) return;
    settled = true;
    for (const timer of settleTimers) clearTimeout(timer);
    action();
  };
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined) {
    settleTimers.push(setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      // Deliberately not in settleTimers: the group must still be killed even
      // once the promise has settled. Left ref'd on purpose — holding the event
      // loop for 2s is a cheaper price than an escalation that never fires.
      setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
      // Last resort for the promise: a process wedged in an uninterruptible
      // wait never closes its pipes, and waiting forever for it is exactly the
      // lease-eating failure this timeout exists to prevent.
      settleTimers.push(setTimeout(
        () => settle(() => reject(new CommandTimeoutError(executable, args, timeoutMs))),
        KILL_OVERHEAD_MS,
      ));
    }, timeoutMs));
  }
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.once("error", (error: Error) => settle(() => reject(error)));
  if (options.input !== undefined && child.stdin) {
    // EPIPE means the child exited before reading its input — a `sudo` that
    // refused, say. The close handler below has the exit code and stderr, so it
    // is the one that gets to say why; rejecting here would replace that with
    // "EPIPE". Anything else on a pipe we did open is a real failure.
    child.stdin.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") settle(() => reject(error));
    });
    child.stdin.end(options.input);
  }
  child.once("close", (code, signal) => settle(() => {
    if (timedOut) reject(new CommandTimeoutError(executable, args, timeoutMs ?? 0));
    else if (code === 0 && !signal) resolve(stdout.trim());
    // Unchanged wording: delivery.ts classifies AUTH_REQUIRED off this string.
    else reject(new Error(`${executable} failed (${signal ?? code}): ${stderr.trim()}`));
  }));
});
