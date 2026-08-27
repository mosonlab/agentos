import { confirmedWrite, isDeterministicRefusal, isLostResponse } from "@agentos/github-client";

import type { ClaimedTask, FailureClass } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { isCommandTimeout, KILL_OVERHEAD_MS, platformCommitArgs, runCommand, type CommandOptions } from "./exec.js";
import {
  boundedTimeout, budgetRemains, GH_PROBE_TIMEOUT_MS, MIN_ATTEMPT_TIMEOUT_MS, NETWORK_ATTEMPTS,
  NETWORK_COMMAND_TIMEOUT_MS, runWithNetworkRetry, transientBackoff,
  type AttemptBudget, type RetryOptions,
} from "./network-retry.js";
import type { Workspace } from "./workspace.js";
import { workspaceEnvironment } from "./workspace.js";

export type DeliveryResult = {
  pushStatus: "SUCCEEDED" | "FAILED";
  pushRemote: string;
  /** The ref actually handed to `git push`, reported on every path that pushed —
   *  including the PR-failure path, where the branch is on the remote no matter
   *  what `gh` did. The control plane treats this as the one publication
   *  signal, so a path that pushes and forgets to report it makes a chain step
   *  base on the wrong branch. */
  pushedBranch?: string;
  headSha?: string;
  pushError?: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  deliveryInstructions?: string;
  failureClass?: FailureClass;
  /** The delivery command's own failure, kept structured. Never part of the
   *  completion payload — runner.ts destructures it off before the spread —
   *  because its `error` is a live object, not something to serialise. */
  failure?: DeliveryFailure;
};

/**
 * Why delivery failed, in the form the failure envelope needs.
 *
 * `message` and `stderr` are text; `error` is the original exception, held by
 * reference so its *type* survives. That is the whole point: #124 made a
 * per-command timeout a `CommandTimeoutError` rather than a phrase, and
 * flattening it to `error.message` here threw the type away one line after it
 * was caught — so a genuinely hung `git push` reached the API looking like an
 * ordinary failed run and was classified TASK_FAILED, non-retryable.
 */
export type DeliveryFailure = {
  /** The command that failed, named as an operator would name it. */
  operation: string;
  message: string;
  error: unknown;
};

export type CommandExecutor = (
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options?: CommandOptions,
) => Promise<string>;

export const executeCommand = (config: RunnerConfig): CommandExecutor => (
  executable,
  args,
  cwd,
  env,
  options,
) => runCommand(config.runAsPrefix, executable, args, cwd, env, options ?? {});

const githubRepo = (remote: string): string | null => {
  const ssh = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (ssh?.[1]) return ssh[1];
  try {
    const url = new URL(remote);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    return url.pathname.replace(/^\//, "").replace(/\.git$/, "") || null;
  } catch {
    return null;
  }
};

// \bauth\w* would still swallow "Author identity unknown" (git's real error
// for a missing user.email, a config problem, not credentials) — so the auth
// terms are spelled out instead of matched as a bare substring.
const failureClassFor = (message: string): FailureClass =>
  /authentication|authorization|unauthorized|credential|permission denied|\b403\b|\b401\b/i.test(message)
    ? "AUTH_REQUIRED"
    : "TOOL_FAILED";

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const manual = (branch: string, remote: string, reason: string): DeliveryResult => ({
  pushStatus: "SUCCEEDED",
  pushRemote: remote,
  pushedBranch: branch,
  deliveryInstructions: `${reason} Branch '${branch}' was pushed. Open a pull request manually against the repository default branch.`,
});

/** The step pushed and is done: it was never meant to open a pull request, so
 *  saying "open one manually" would be wrong advice, not just noise. */
const noPullRequest = (branch: string, remote: string): DeliveryResult => ({
  pushStatus: "SUCCEEDED",
  pushRemote: remote,
  pushedBranch: branch,
  deliveryInstructions: `Branch '${branch}' was pushed. This step does not open a pull request.`,
});

/** A GitHub delivery failure after the branch was published. */
const failedPullRequestDelivery = (
  branch: string,
  remote: string,
  operation: string,
  error: unknown,
  reason: string,
  instructions: string,
): DeliveryResult => ({
  pushStatus: "FAILED",
  pushRemote: remote,
  pushedBranch: branch,
  pushError: reason,
  deliveryInstructions: instructions,
  failureClass: failureClassFor(reason),
  failure: { operation, message: reason, error },
});

/**
 * Classify a failed `gh pr create` for the confirmed-write loop.
 *
 * This asks the shared question — did the write's response get lost? — with the
 * shared predicates, so the runner, the merge executor and the API answer it
 * identically. It is deliberately NOT `isTransientNetworkError`: that predicate
 * answers a different question ("may I retry this command?") about a different
 * input (raw CLI stderr, including adapters.ts's "preflight timed out" for a
 * broken binary), and its narrower table would classify a bare `EOF` as a
 * refusal — which the loop then declines to resend even after a read-back has
 * proved nothing landed.
 *
 * Our own kill-at-the-deadline is a lost response by construction: the process
 * was killed, so its answer is gone, but the request may well have been
 * delivered. It is recognised by type, never by its wording.
 *
 * Anything neither lost nor a recognised refusal is treated as a refusal, which
 * is the safe direction: it is read back like everything else, and only the
 * resend is withheld.
 */
const classifyCreateFailure = (error: unknown, reason: string): { status: "lost" | "refused"; reason: string } => {
  if (isDeterministicRefusal(error)) return { status: "refused", reason };
  if (isCommandTimeout(error) || isLostResponse(error)) return { status: "lost", reason };
  return { status: "refused", reason };
};

/** `gh pr create` answers with the URL of what it made. */
const pullRequestFromUrl = (stdout: string): { url: string; number: number } | null => {
  const match = stdout.trim().match(/^(https:\/\/\S*\/pull\/(\d+))\s*$/mu);
  const url = match?.[1];
  const number = Number(match?.[2]);
  return url && Number.isInteger(number) && number > 0 ? { url, number } : null;
};

// A chain step is named "<chain>: <step>"; the PR is the chain's, not the step's.
export const pullRequestTitle = (task: ClaimedTask["task"]): string => {
  const step = task.templateStep?.name;
  const suffix = step ? `: ${step}` : null;
  return suffix && task.name.endsWith(suffix) && task.name.length > suffix.length
    ? task.name.slice(0, -suffix.length)
    : task.name;
};

export const deliverWorkspace = async (
  config: RunnerConfig,
  claim: ClaimedTask,
  workspace: Workspace,
  command: CommandExecutor = executeCommand(config),
  recordPublication: (branch: string) => Promise<void> = async () => undefined,
  retryOptions: RetryOptions = {},
): Promise<DeliveryResult> => {
  const env = workspaceEnvironment(config);
  const remote = claim.repo.remoteUrl;
  // `!== false`, not a truthiness test, and the difference is the whole point.
  // The field is required in ClaimedTask so our own code cannot omit it; the
  // comparison is what makes a *stale API build* that omits it from the claim
  // payload degrade to today's behaviour (open the PR) instead of to the
  // expensive failure (never open one again, silently). Read from `run`, not
  // `task`: the run carries the snapshot taken when it was created, so an
  // operator's PATCH cannot change a run that is already queued.
  // No step name, output kind or task name is consulted here or anywhere in
  // this package.
  const opensPullRequest = claim.run.opensPullRequest !== false;
  // The push is unconditional: a step that opens no PR still publishes its
  // branch, which is what lets the *next* step of the chain clone it.
  try {
    await runWithNetworkRetry("git", ["push"],
      ({ timeoutMs }) => command("git", ["push", "--set-upstream", "origin", workspace.branch], workspace.path, env, { timeoutMs }),
      retryOptions,
    );
  } catch (error: unknown) {
    const message = messageOf(error);
    return {
      pushStatus: "FAILED",
      pushRemote: remote,
      pushError: message,
      // Still computed, still sent — but as the runner's advisory first guess.
      // The API classifies from `failure` below.
      failureClass: failureClassFor(message),
      failure: { operation: "git push", message, error },
    };
  }
  // This API write intentionally sits immediately after git push and before
  // any GitHub lookup, cleanup, or terminal completion. It closes the large
  // post-push loss window; provisionWorkspace's remote-head check covers the
  // irreducible crash between these two network operations. A transient ACK
  // failure does not turn a successful push into a failed push: completion is
  // a second persistence opportunity and remote reconciliation is the final
  // source of truth.
  await recordPublication(workspace.branch).catch(() => undefined);
  const repo = githubRepo(remote);
  if (!repo) {
    return opensPullRequest
      ? manual(workspace.branch, remote, "Remote is not hosted on GitHub.")
      : noPullRequest(workspace.branch, remote);
  }
  try {
    // Capped against the same phase deadline as everything else here: this is
    // the one command in delivery that is not on the retry allowlist, and a
    // hung `gh` would otherwise stall the phase before the budget applies.
    await command("gh", ["--version"], workspace.path, env, { timeoutMs: boundedTimeout(retryOptions, GH_PROBE_TIMEOUT_MS) });
  } catch (error: unknown) {
    if (!opensPullRequest) return noPullRequest(workspace.branch, remote);
    const reason = messageOf(error);
    return failedPullRequestDelivery(
      workspace.branch,
      remote,
      "gh --version",
      error,
      reason,
      `The gh CLI is unavailable. Branch '${workspace.branch}' was pushed, but pull request delivery failed: ${reason}.`,
    );
  }
  // Only an *open* PR on this head may be reused: a merged or closed one would
  // silently swallow the push. One open PR per head branch is a GitHub invariant,
  // so a chain sharing a branch keeps exactly one human-facing PR.
  // This lookup is also the read-back for `gh pr create` below, which is what
  // makes creation idempotent: the open PR on this head IS the key. `inherited`
  // carries the enclosing phase deadline when it runs in that role, because a
  // nested loop that opened its own budget could double the operation's worst
  // case behind the back of the timing contract in network-retry.ts.
  const openPullRequest = async (inherited: AttemptBudget = {}): Promise<{ url: string; number: number } | null> => {
    const args = [
      "pr", "list", "--repo", repo, "--head", workspace.branch, "--state", "open", "--limit", "1", "--json", "url,number",
    ];
    const raw = await runWithNetworkRetry("gh", args,
      ({ timeoutMs }) => command("gh", args, workspace.path, env, { timeoutMs }),
      { ...retryOptions, ...(inherited.deadline === undefined ? {} : { deadline: inherited.deadline }) },
    );
    const parsed = JSON.parse(raw || "[]") as Array<{ url: string; number: number }>;
    return parsed[0] ?? null;
  };
  try {
    // The lookup runs before the flag check on purpose: a documentation step
    // running after the implementation step still reports the chain's PR on its
    // gate card and in GET /tasks/:id. Only *creation* is suppressed.
    const existing = await openPullRequest();
    if (existing) return { pushStatus: "SUCCEEDED", pushRemote: remote, pushedBranch: workspace.branch, pullRequestUrl: existing.url, pullRequestNumber: existing.number };
    if (!opensPullRequest) return noPullRequest(workspace.branch, remote);
    const createArguments = [
      "pr", "create", "--repo", repo,
      "--base", claim.run.pullRequestBase ?? claim.repo.defaultBranch,
      "--head", workspace.branch,
      "--title", pullRequestTitle(claim.task),
      "--body", `Automated delivery for AgentOS task ${claim.task.id}.`,
    ];
    // The one creating GitHub write this package makes, and the reason #139
    // exists. A create response can be lost after GitHub has committed the PR,
    // so the error is never the verdict: the open PR on this head is the
    // idempotency key, and confirmedWrite reads it back after every failed send
    // and resends only when that read positively found nothing. A read-back
    // that cannot be completed ends the loop as `indeterminate` — which is what
    // this call site used to get wrong, because a probe that threw on a flaky
    // link looked like a transient failure of the *create* and earned it
    // another send.
    let lastCreateError: unknown;
    let lastReadBackError: unknown;
    const creation = await confirmedWrite<{ url: string; number: number } | null>({
      resend: "after-confirmed-absent",
      attempts: NETWORK_ATTEMPTS,
      wait: retryOptions.wait ?? transientBackoff,
      // The same judgment the retry loop makes about itself: the first send may
      // spend the last of the budget, because publishing the run's work is
      // worth the one documented overrun; a resend may not, because a send that
      // cannot finish inside the deadline buys nothing and costs the lease.
      canSend: (attemptNumber) => budgetRemains(
        retryOptions,
        attemptNumber === 1 ? 1 : MIN_ATTEMPT_TIMEOUT_MS + KILL_OVERHEAD_MS,
      ),
      attempt: async () => {
        try {
          const stdout = await command("gh", createArguments, workspace.path, env,
            { timeoutMs: boundedTimeout(retryOptions, NETWORK_COMMAND_TIMEOUT_MS) });
          // `gh pr create` prints the URL of the pull request it made. Taking
          // the identity from the write's own answer is what removes the
          // read-after-write step entirely — and with it the case where a
          // confirmed-successful create was followed by a failed lookup and the
          // operator was told to go and create another one.
          return { status: "applied", value: pullRequestFromUrl(stdout) };
        } catch (createError: unknown) {
          lastCreateError = createError;
          const reason = createError instanceof Error ? createError.message : String(createError);
          // Both classifications are read back before anything is decided; the
          // split only decides whether a *resend* may follow a confirmed absence.
          return classifyCreateFailure(createError, reason);
        }
      },
      readBack: async () => {
        try {
          // The enclosing phase deadline is inherited rather than reopened: a
          // probe with its own budget would double the operation's worst case
          // behind the back of the timing contract in network-retry.ts.
          const found = await openPullRequest(
            retryOptions.deadline === undefined ? {} : { deadline: retryOptions.deadline },
          );
          return found ? { status: "applied", value: found } : { status: "absent" };
        } catch (probeError: unknown) {
          lastReadBackError = probeError;
          return { status: "unreadable", reason: probeError instanceof Error ? probeError.message : String(probeError) };
        }
      },
    });
    if (creation.status !== "applied") {
      let error = lastCreateError ?? new Error(creation.reason);
      if (creation.status === "indeterminate") {
        error = lastReadBackError ?? error;
        if (isCommandTimeout(lastCreateError) && !isCommandTimeout(lastReadBackError)) error = lastCreateError;
      }
      const instructions = creation.status === "indeterminate"
        ? `Branch '${workspace.branch}' was pushed, but PR creation failed without a verdict: ${creation.reason}. A pull request may already have been created — check the head branch before retrying.`
        : `Branch '${workspace.branch}' was pushed, but PR creation failed: ${creation.reason}.`;
      return failedPullRequestDelivery(
        workspace.branch,
        remote,
        "gh pr create",
        error,
        creation.reason,
        instructions,
      );
    }
    if (creation.value) {
      // Either `gh pr create` named it on stdout, or the read-back found it —
      // our own lost create having landed, or a concurrent human or runner
      // having opened it first. Either way it is the PR.
      return {
        pushStatus: "SUCCEEDED",
        pushRemote: remote,
        pushedBranch: workspace.branch,
        pullRequestUrl: creation.value.url,
        pullRequestNumber: creation.value.number,
      };
    }
    // The create succeeded but did not name the pull request — an older `gh`,
    // or output we could not parse. One lookup gets the identity.
    try {
      const created = await openPullRequest();
      const missingPullRequest = "gh pr create succeeded without returning a pull request URL, and no open pull request was found";
      return created
        ? { pushStatus: "SUCCEEDED", pushRemote: remote, pushedBranch: workspace.branch, pullRequestUrl: created.url, pullRequestNumber: created.number }
        : failedPullRequestDelivery(
          workspace.branch,
          remote,
          "gh pr create",
          new Error(missingPullRequest),
          missingPullRequest,
          `Branch '${workspace.branch}' was pushed, but PR creation returned no URL and no open pull request was found.`,
        );
    } catch (lookupError: unknown) {
      // The write is CONFIRMED applied and only its name is missing. Falling
      // through to a manual-create advisory would risk a duplicate, because
      // the write is known to have created a pull request. The run fails so its
      // identity can be recorded by a retry, while the lookup error remains on
      // the delivery result for the completion envelope.
      const reason = messageOf(lookupError);
      return failedPullRequestDelivery(
        workspace.branch,
        remote,
        "gh pr list",
        lookupError,
        reason,
        `Branch '${workspace.branch}' was pushed and a pull request was created for it, but its URL could not be read back: ${reason}. Do not create another — inspect the head branch.`,
      );
    }
  } catch (error: unknown) {
    const message = messageOf(error);
    // The push above already succeeded, so the branch exists on the remote no
    // matter what `gh` did. Report that fact (`pushedBranch`) on both paths, or
    // the chain's next step bases on the default branch and its push of the
    // already-published shared name is rejected non-fast-forward — a wedge no
    // retry clears.
    //
    // For a step that was never meant to open a PR, a failed `gh pr list` is
    // not a delivery failure at all: everything this step owed the chain is
    // already on the remote. Reporting FAILED here would fail a documentation
    // step *after* its push, and the runner marks a delivery failure with a
    // failureClass non-retryable.
    if (!opensPullRequest) return noPullRequest(workspace.branch, remote);
    return failedPullRequestDelivery(
      workspace.branch,
      remote,
      "gh pr list",
      error,
      message,
      `Branch '${workspace.branch}' was pushed, but checking for an open pull request failed: ${message}.`,
    );
  }
};

/**
 * Salvage for a failed run: commit any trackable worktree changes, then push the
 * run branch as WIP so the work survives workspace cleanup. Never opens a PR,
 * and never reports a failureClass — the run already has one from CLI evidence.
 *
 * The per-run branch here is deliberate and is now load-bearing: a failed run's
 * half-finished tree must never enter the chain's shared branch, which every
 * later step of the chain clones. Never change this to workspace.branch.
 *
 * Note what this function does *not* control: the completion payload still
 * reports `Run.branch` as the workspace branch (runner.ts spreads the workspace
 * result before this one), so a salvaged run still *looks* like a push to the
 * shared branch in that column. `pushedBranch` is the column that tells the
 * truth, and it is the only one @agentos/db's resolveRunBranches trusts. Keep
 * them in sync: whatever ref is handed to `git push` is the ref reported as
 * `pushedBranch`.
 */
export const salvageWorkspace = async (
  config: RunnerConfig,
  identity: { taskId: string; runId: string; runNumber: number; remoteUrl?: string },
  workspace: Workspace,
  command: CommandExecutor = executeCommand(config),
  retryOptions: RetryOptions = {},
): Promise<DeliveryResult | null> => {
  const env = workspaceEnvironment(config);
  const remote = identity.remoteUrl ?? "origin";
  const branch = `agentos/${identity.taskId}/run-${identity.runNumber}`;
  try {
    // Respect .gitignore while including tracked deletions and untracked files.
    await command("git", ["add", "-A"], workspace.path, env);
    const status = await command("git", ["status", "--porcelain"], workspace.path, env);
    if (status) {
      await command(
        "git",
        platformCommitArgs(`WIP salvage for AgentOS run ${identity.runId}`),
        workspace.path,
        env,
      );
    }
    const head = await command("git", ["rev-parse", "HEAD"], workspace.path, env);
    // A clean run branch that never diverged from its base has nothing to push.
    if (head === workspace.baseSha) return null;
    // Plain push, never forced: the run branch is unique per (task, run), so a
    // rejection means something else is there and salvaging must not clobber it.
    await runWithNetworkRetry("git", ["push"],
      ({ timeoutMs }) => command("git", ["push", "origin", `HEAD:refs/heads/${branch}`], workspace.path, env, { timeoutMs }),
      retryOptions,
    );
    return {
      pushStatus: "SUCCEEDED",
      pushRemote: remote,
      pushedBranch: branch,
      headSha: head,
      deliveryInstructions: `Run failed; its commits were pushed to '${branch}' as work in progress. No pull request was opened.`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { pushStatus: "FAILED", pushRemote: remote, pushError: `WIP salvage failed: ${message}` };
  }
};

export const deliverFailedWorkspace = async (
  config: RunnerConfig,
  claim: ClaimedTask,
  workspace: Workspace,
  command: CommandExecutor = executeCommand(config),
  retryOptions: RetryOptions = {},
): Promise<DeliveryResult | null> => salvageWorkspace(config, {
  taskId: claim.task.id,
  runId: claim.run.id,
  runNumber: claim.run.runNumber,
  remoteUrl: claim.repo.remoteUrl,
}, workspace, command, retryOptions);
