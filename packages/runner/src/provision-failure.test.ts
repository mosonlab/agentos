import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { RUNNER_EXCEPTION_REASON, runnerExceptionEnvelope } from "./envelope.js";
import { runCommand } from "./exec.js";
import { executeClaim } from "./runner.js";
import { createControlPlaneDouble, envelopeOf } from "./test-control-plane.js";
import { provisionWorkspace } from "./workspace.js";

/**
 * What the API actually receives when provisioning fails.
 *
 * Issue #113's regression test used to hand-write this payload, and hand-wrote
 * it wrong: `terminationReason: null` for a clone failure the real runner
 * stamps `"runner exception"`. The API reads a termination reason as a
 * cancelled session, so the production path answered CANCELLED_OR_TIMED_OUT —
 * a class no whitelist retries — while the test asserted a retry that only its
 * own invented envelope could produce.
 *
 * These tests drive the real `executeClaim` and the real `provisionWorkspace`.
 * `packages/api/src/provision-budget.dbtest.ts` asserts the API's verdict on
 * the exact objects they produce; keep the two in step.
 */

// Separate roots on purpose: the runner refuses a mirror root that overlaps the
// workspace root, because workspace reclamation sweeps what it finds there.
const config = (root: string): RunnerConfig => ({
  apiUrl: "http://api.invalid",
  runnerToken: "runner-token",
  runnerId: "runner-1",
  daemonVersion: "0.0.0-test",
  pollIntervalMs: 5_000,
  claimMaxLoadAverage: 1.5,
  leaseSeconds: 60,
  heartbeatIntervalMs: 5_000,
  path: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
  home: join(root, "home"),
  gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
  workspaceRoot: join(root, "runs"),
  hostProofSlots: 3,
  failedWorkspaceRetention: 2,
  workspaceReclaimIntervalMs: 300_000,
  toolDeadlineMs: 60_000,
  apiTimeoutMs: 5_000,
  runAsPrefix: [],
  binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
});

/** A remote no clone can reach and no retry can fix: the failure is immediate
 *  and deterministic, so this test costs one `git clone`, not a backoff ladder. */
const UNREACHABLE_REMOTE = "/nonexistent/agentos-issue-113-no-such-repo.git";

const claim = (remoteUrl: string): ClaimedTask => ({
  executionMode: "agent",
  specificationMaterialization: null,
  task: {
    id: "task-113",
    chainId: null,
    chainIndex: null,
    chainLayer: null,
    name: "Rate limit the inbox poller",
    description: "work",
    repoId: "repo-1",
    targetBranch: "master",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    maxSessionsPerTask: 2,
    templateStep: null,
  },
  agent: {
    id: "agent-1", name: "agent", model: "claude", foundationalPrompt: "f", rolePrompt: "r", disabledTools: [],
  },
  repo: {
    id: "repo-1",
    remoteUrl,
    defaultBranch: "master",
    mountPath: "/does/not/exist",
    dependencyProvisioning: "NONE",
  },
  run: {
    id: "run-113",
    taskId: "task-113",
    runNumber: 1,
    opensPullRequest: true,
    requiresCommit: true,
    pullRequestBase: "master",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    maxRunsPerTask: 2,
    model: "claude",
    codexServiceTier: "DEFAULT",
    subagentModel: null,
    subagentMaxConcurrent: null,
    targetBranch: "master",
    targetBranchPublished: false,
    pinnedBaseSha: null,
    implementationBaseSha: null,
    implementationHeadSha: null,
    promptHash: "hash",
    workspacePath: null,
    branch: null,
    baseSha: null,
  },
  session: { id: "session-113" },
  resume: null,
  nextEventSeq: 0,
  runner: "CLAUDE",
  fencingToken: "fence-1",
  sessionToken: "session-token",
  secrets: {},
  priorOutputs: [],
  operatorNotes: [],
  previousRunHandoff: null,
  regressionRepairHandoff: null,
});

test("a clone that cannot succeed reaches the API as a PROVISION envelope stamped 'runner exception'", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-provision-"));
  const controlPlane = createControlPlaneDouble();

  await executeClaim(config(root), claim(UNREACHABLE_REMOTE), { controlPlane: controlPlane.controlPlane });

  const completion = controlPlane.completions.at(-1);
  assert.ok(completion, "provisioning failure must still complete the run");
  const envelope = envelopeOf(completion.outcome);
  // The three facts the API's verdict turns on, none of which the old
  // hand-written fixture had right.
  assert.equal(envelope.phase, "PROVISION", "no agent was started, so this is the runner's own plumbing");
  assert.equal(envelope.agentExited, false);
  assert.equal(envelope.terminationReason, RUNNER_EXCEPTION_REASON);
  // Not a network blip: git could not find a repository there, and retrying is
  // pointless. The API must therefore refund the attempt without retrying it.
  assert.equal(envelope.transient, false);
  assert.equal(envelope.timedOut, false);
  assert.match(String(envelope.stderrSummary), /repository|not a git|does not exist/i);
  // `agentExited: false` above is what the API reads as "the environment
  // failed"; the runner no longer asserts an `externalFailure` flag of its own.
  assert.equal(completion.terminationReason, RUNNER_EXCEPTION_REASON);
});

test("a transient mirror fetch failure escapes provisioning as a transient error, and the envelope says so", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-provision-transient-"));
  // The 2026-08-17 error, thrown by the real call site that still reaches the
  // network: the mirror's own fetch. `attempts: 1` collapses the real retry
  // ladder rather than replacing it — the loop, its transient predicate and its
  // rethrow are the production ones, and the backoff is the only thing skipped.
  const message = "git failed (128): fatal: unable to access 'https://example.test/repo.git/': "
    + "LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to example.test:443";
  const escaped = await provisionWorkspace(
    config(root),
    claim("https://example.test/repo.git"),
    // The mirror fetch fails before dependencies are ever reached.
    { provision: false, evidence: "Dependency provisioning skipped: Repo.dependencyProvisioning=NONE" },
    {
      execute: async (executorConfig, executable, args, cwd, env) => {
        // Only git is faked: the mirror's own filesystem bookkeeping is real work
        // in a temporary directory, and the retry under test rides on the fetch.
        if (executable === "/bin/sh") return runCommand(executorConfig.runAsPrefix, executable, args, cwd, env, {});
        if (args[0] === "fetch") throw new Error(message);
        return "";
      },
      retryOptions: { attempts: 1 },
    },
  ).then(() => null, (error: unknown) => error);
  assert.ok(escaped instanceof Error, "the fetch failure must escape provisioning, not be swallowed");

  // Through the same function the production catch calls.
  const envelope = runnerExceptionEnvelope({
    phase: "PROVISION",
    evidence: {
      exitCode: 1, signal: null, terminalEventSeen: false, terminalSuccess: false,
      finalOutput: null, providerError: null, terminationReason: null, stdout: "", stderr: escaped.message,
    },
    runnerClass: "TRANSIENT_PROVIDER",
    error: escaped,
  });
  assert.equal(envelope.phase, "PROVISION");
  assert.equal(envelope.agentExited, false);
  assert.equal(envelope.terminationReason, RUNNER_EXCEPTION_REASON);
  // The one field that separates this from the test above, and it comes from
  // the runner's typed predicate rather than from anything the test asserts.
  assert.equal(envelope.transient, true);
});
