/**
 * `@agentos/merge-executor` — the merge authority, in its own package, its own
 * process, and its own OS principal (§D-P1).
 *
 * What this process does NOT contain, structurally: an adapter, a prompt
 * builder, a CLI binary reference, workspace provisioning, or any delivery code.
 * It never spawns a child process, so neither the App private key nor a minted
 * installation token can reach a child environment or argv. Those properties
 * are asserted by `import-graph.test.ts` and `no-child-process.test.ts`, not
 * merely intended.
 */

import "dotenv/config";

import { INTEGRATOR_OUTPUT_KIND, MERGE_INTEGRATOR_KIND, MERGE_INTEGRATOR_SCHEMA_VERSION, serializeMergeResult } from "@agentos/db/merge-integrator";

import { makeAgentOsClient, type MechanicalClaim } from "./agentos.js";
import { loadExecutorConfig, type ExecutorConfig } from "./config.js";
import { execute, type Deps } from "./decision-table.js";
import { mintInstallationToken } from "./github-app-auth.js";
import { makeGitHubClient } from "./github.js";
import { evaluatePreconditions, liveDeps } from "./preconditions.js";
import { makeLog, makeRedactor, type ExecutorLog } from "./redaction.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export const runClaim = async (
  config: ExecutorConfig,
  privateKeyFile: string,
  claimed: MechanicalClaim,
  log: ExecutorLog,
  fetchImpl: typeof fetch = fetch,
  overrides: {
    mintToken?: typeof mintInstallationToken;
    makeGitHub?: typeof makeGitHubClient;
    executeDecision?: typeof execute;
  } = {},
): Promise<void> => {
  const agentos = makeAgentOsClient(config, fetchImpl);
  const chainIndex = claimed.task.chainIndex ?? null;
  if (chainIndex === null) {
    // Fail closed and loudly: a mechanical run outside a chain has no
    // predecessor to read an authorization from, so there is nothing to execute.
    await agentos.complete(claimed, { succeeded: false, outcome: null, failureReason: "mechanical run is not part of a chain" });
    return;
  }

  const startedAt = new Date();
  let runLog = log;
  const heartbeat = setInterval(() => {
    void agentos.heartbeat(claimed).catch((error: unknown) => { runLog.warn("heartbeat failed", { error }); });
  }, Math.max(5_000, config.leaseSeconds * 500));

  try {
    await agentos.start(claimed);
    const minted = await (overrides.mintToken ?? mintInstallationToken)({
      appId: config.githubAppId,
      installationId: config.githubAppInstallationId,
      privateKeyFile,
      restUrl: config.githubRestUrl,
      timeoutMs: config.githubAppAuthTimeoutMs,
      http: async ({ url, method, headers, body, signal }) => {
        const response = await fetchImpl(url, { method, headers, ...(body === undefined ? {} : { body }), signal });
        return { status: response.status, body: await response.text() };
      },
    });
    if (!minted.ok) {
      const suffix = minted.httpStatus === undefined ? "" : ` (HTTP ${minted.httpStatus})`;
      const failureReason = `GitHub App installation-token mint failed: ${minted.failure}${suffix}`;
      log.error("GitHub App installation-token mint failed", { runId: claimed.run.id, failure: minted.failure, ...(minted.httpStatus === undefined ? {} : { httpStatus: minted.httpStatus }) });
      await agentos.complete(claimed, { succeeded: false, outcome: null, failureReason });
      return;
    }

    runLog = log.withSecrets(minted.token);
    const redactInstallationToken = makeRedactor(minted.token);
    // The installation token is run-scoped: construct the GitHub surface only
    // after this Run's successful mint, and never retain it outside this call.
    const github = (overrides.makeGitHub ?? makeGitHubClient)({
      restUrl: config.githubRestUrl,
      graphqlUrl: config.githubGraphqlUrl,
      token: minted.token,
      timeoutMs: config.githubTimeoutMs,
      http: async ({ url, method, headers, body, signal }) => {
        try {
          const response = await fetchImpl(url, { method, headers, ...(body === undefined ? {} : { body }), signal });
          // Response text is untrusted platform input and can flow into a stop
          // record. Filter an echoed credential before the decision table sees
          // it; a replacement that makes a required field malformed fails shut.
          return { status: response.status, body: redactInstallationToken(await response.text()) };
        } catch {
          // Some transports include request headers in thrown errors. Convert
          // them to a fixed string before the shared HTTP layer classifies the
          // no-response case.
          throw new Error("GitHub request failed");
        }
      },
    });
    const deps: Deps = {
      readChain: () => agentos.readChain(claimed, chainIndex - 1),
      readOwnIntents: () => agentos.readOwnIntents(claimed, chainIndex),
      readPullRequest: (reference) => github.readPullRequest(reference),
      merge: (reference, expectedHeadSha, expectedBase) => github.mergePullRequest(reference, expectedHeadSha, expectedBase),
      disableAutoMerge: (pullRequestId) => github.disableAutoMerge(pullRequestId),
      dequeuePullRequest: (entryId) => github.dequeuePullRequest(entryId),
      writeIntent: async (intent) => {
        await agentos.writeActivity(claimed, `Merge intent recorded for PR #${intent.prNumber} at ${intent.headSha}`, {
          kind: MERGE_INTEGRATOR_KIND.intent,
          schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
          ...intent,
        });
      },
      sleep,
      now: () => new Date(),
      startedAt,
      mergeIdentityLogin: config.mergeIdentityLogin,
      pollAttempts: config.mergeabilityPollAttempts,
      pollIntervalMs: config.mergeabilityPollMs,
      pollBudgetMs: config.mergeabilityPollBudgetMs,
    };

    const outcome = await (overrides.executeDecision ?? execute)(deps);
    // The output is the latest view and is replaceable; the activity is the
    // append-only history the stop guard keys on (Y1). Both are written, always.
    await agentos.writeOutput(claimed, INTEGRATOR_OUTPUT_KIND, serializeMergeResult(outcome));
    await agentos.writeActivity(
      claimed,
      outcome.outcome === "merged"
        ? `Mechanical merge completed as ${outcome.mergeCommitSha}`
        : `Mechanical merge stopped: ${outcome.condition}`,
      { kind: MERGE_INTEGRATOR_KIND.result, schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION, ...outcome },
    );
    // Every executed contract ends SUCCESS, stop or merge alike. FAILURE is for
    // crashes only, so a recorded stop is never automatically retried.
    await agentos.complete(claimed, { succeeded: true, outcome });
    runLog.info("mechanical run completed", { runId: claimed.run.id, outcome: outcome.outcome });
  } catch (error: unknown) {
    runLog.error("mechanical run crashed", { runId: claimed.run.id, error });
    // Deep transport errors can contain request headers. The run record names
    // the failed phase without serialising the thrown value into control-plane
    // evidence; the token-aware logger above remains the diagnostic backstop.
    await agentos.complete(claimed, { succeeded: false, outcome: null, failureReason: "merge executor crashed during mechanical execution" })
      .catch((completionError: unknown) => { runLog.error("completion after crash failed", { error: completionError }); });
  } finally {
    clearInterval(heartbeat);
  }
};

export const claimOnce = async (
  config: ExecutorConfig,
  privateKeyFile: string,
  log: ExecutorLog,
  fetchImpl: typeof fetch = fetch,
  runClaimImpl: typeof runClaim = runClaim,
): Promise<"idle" | "handled"> => {
  const agentos = makeAgentOsClient(config, fetchImpl);
  const claimed = await agentos.claim();
  if (!claimed) return "idle";
  if (claimed.executionMode !== "mechanical") {
    // Symmetric to the ordinary runner's refusal: an allowlisted runner id
    // should be offered nothing else, so being handed an agent run means the
    // allowlist is misconfigured. Refuse it rather than execute it.
    await agentos.complete(claimed, { succeeded: false, outcome: null, failureReason: "the merge executor does not execute model runs" });
    return "handled";
  }
  await runClaimImpl(config, privateKeyFile, claimed, log, fetchImpl);
  return "handled";
};

export const main = async (): Promise<void> => {
  // The isolation gate runs BEFORE anything reads a credential, and its failure
  // is a non-zero exit with a named message — never a warning the deployment can
  // run past.
  const gate = evaluatePreconditions(liveDeps());
  if (!gate.ok) {
    for (const failure of gate.failures) process.stderr.write(`merge-executor startup refused: ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  const log = makeLog(makeRedactor());
  const config = loadExecutorConfig();
  log.info("merge executor started", { osUser: gate.osUser, runnerId: config.runnerId, privateKeyFile: gate.privateKeyFile });

  let running = true;
  const stop = (): void => { running = false; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (running) {
    try {
      const result = await claimOnce(config, gate.privateKeyFile, log);
      if (result === "idle") {
        await sleep(config.pollIntervalMs);
      }
    } catch (error: unknown) {
      log.error("claim loop error", { error });
      await sleep(config.pollIntervalMs);
    }
  }
  log.info("merge executor stopped");
};

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
