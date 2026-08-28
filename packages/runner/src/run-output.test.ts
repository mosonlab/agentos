import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ControlPlaneError, type ClaimedTask } from "./api.js";
import { adapters, type RuntimeHandle } from "./adapters.js";
import type { RunnerConfig } from "./config.js";
import { RUNNER_EXCEPTION_REASON, summarizeEvidence } from "./envelope.js";
import { executeClaim } from "./runner.js";
import { createControlPlaneDouble } from "./test-control-plane.js";

const REGRESSION_OUTPUT_KIND = "regression-verification-v2";

/**
 * What a failed run actually hands the API.
 *
 * Issue #114 is an API-side loss, but the claim it rests on is a runner-side
 * fact: `completeRun` carries the run's own output tail on *every* completion,
 * not only on the ones the API happened to keep. This test drives the real
 * `executeClaim` against a real clone and a real child process, so
 * `packages/api/src/run-output.dbtest.ts` can assert persistence against the
 * shape produced here rather than one invented there. Keep the two in step.
 */

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/**
 * A stub agent CLI. It answers the runner's real preflight — `--version`, then
 * `auth status` in the shape the CLAUDE adapter greps for — and then, on the
 * run itself, says something worth keeping and dies the way a failing agent
 * does. No stream-json, so `finalOutput` stays null and the tail the runner
 * sends is the raw stdout, which is the failure case exactly.
 */
const failingAgent = [
  "#!/bin/sh",
  'case "$1" in',
  '  --version) echo "1.2.3-stub"; exit 0 ;;',
  '  --help) echo "--setting-sources"; exit 0 ;;',
  '  auth) echo \'{"loggedIn": true, "authMethod": "stub"}\'; exit 0 ;;',
  "esac",
  "cat > /dev/null",
  'echo "reproduced the deadlock: workers 3 and 7 both hold the inbox advisory lock"',
  'echo "the fix needs the lock ordering inverted in reconcile.ts"',
  ">&2 echo 'Error: session ended without a result'",
  "exit 1",
].join("\n");

/**
 * The same stub, succeeding: it emits the CLAUDE adapter's terminal `result`
 * event, so `finalOutput` — not stdout — is what the runner sends as the tail.
 * Both cases have to reach the API for a run's own account of itself to be
 * readable afterwards, whichever way the run went.
 */
const succeedingAgent = [
  "#!/bin/sh",
  'case "$1" in',
  '  --version) echo "1.2.3-stub"; exit 0 ;;',
  '  --help) echo "--setting-sources"; exit 0 ;;',
  '  auth) echo \'{"loggedIn": true, "authMethod": "stub"}\'; exit 0 ;;',
  "esac",
  "cat > /dev/null",
  'echo \'{"type":"result","is_error":false,"terminal_reason":"completed",'
  + '"result":"inverted the lock ordering in reconcile.ts and added the regression test"}\'',
  "exit 0",
].join("\n");

const remediatingAgent = (
  remediationPrompt: string,
  resumeCommands: string[] = [],
  remediationResult = "task output persisted",
): string => [
  "#!/bin/sh",
  'case "$1" in',
  '  --version) echo "1.2.3-stub"; exit 0 ;;',
  '  --help) echo "--setting-sources"; exit 0 ;;',
  '  auth) echo \'{"loggedIn": true, "authMethod": "stub"}\'; exit 0 ;;',
  "esac",
  'case " $* " in',
  '  *" --resume conversation-114 "*)',
  `    cat > ${JSON.stringify(remediationPrompt)}`,
  ...resumeCommands.map((command) => `    ${command}`),
  '    echo \'{"type":"system","session_id":"conversation-114"}\'',
  `    echo ${JSON.stringify(JSON.stringify({
    type: "result",
    is_error: false,
    terminal_reason: "completed",
    session_id: "conversation-114",
    result: remediationResult,
  }))}`,
  "    ;;",
  "  *)",
  "    cat > /dev/null",
  '    echo \'{"type":"system","session_id":"conversation-114"}\'',
  '    echo \'{"type":"result","is_error":false,"terminal_reason":"completed","session_id":"conversation-114","result":"implemented the requested change"}\'',
  "    ;;",
  "esac",
  "exit 0",
].join("\n");

const seedRemote = async (root: string): Promise<string> => {
  const remote = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "--initial-branch=master", remote);
  git(root, "init", "--initial-branch=master", seed);
  git(seed, "config", "user.name", "AgentOS Test");
  git(seed, "config", "user.email", "runner@agentos.local");
  await writeFile(join(seed, "tree.txt"), "base\n");
  git(seed, "add", "tree.txt");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "master");
  return remote;
};

// `home` is deliberately not the workspace root: the runner keeps its
// repository mirror under the former and refuses one that overlaps the latter,
// which workspace reclamation sweeps.
const config = (workspaceRoot: string, agentBinary: string): RunnerConfig => ({
  apiUrl: "http://api.invalid",
  runnerToken: "runner-token",
  runnerId: "runner-1",
  daemonVersion: "0.0.0-test",
  pollIntervalMs: 5_000,
  leaseSeconds: 60,
  heartbeatIntervalMs: 60_000,
  path: process.env.PATH ?? "/usr/bin:/bin",
  home: join(workspaceRoot, "..", "home"),
  gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
  workspaceRoot,
  failedWorkspaceRetention: 0,
  workspaceReclaimIntervalMs: 300_000,
  toolDeadlineMs: 60_000,
  apiTimeoutMs: 5_000,
  runAsPrefix: [],
  binaries: { CLAUDE: agentBinary, CODEX: agentBinary, PI: agentBinary },
});

const claim = (remoteUrl: string): ClaimedTask => ({
  executionMode: "agent",
  specificationMaterialization: null,
  task: {
    id: "task-114",
    chainId: null,
    chainIndex: null,
    name: "Find the inbox deadlock",
    description: "work",
    repoId: "repo-1",
    targetBranch: "master",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    maxSessionsPerTask: 1,
    templateStep: null,
  },
  agent: {
    id: "agent-1", name: "agent", model: "claude", foundationalPrompt: "f", rolePrompt: "r", disabledTools: [],
  },
  repo: { id: "repo-1", remoteUrl, defaultBranch: "master", mountPath: "/does/not/exist" },
  run: {
    id: "run-114",
    runNumber: 1,
    opensPullRequest: false,
    pullRequestBase: "master",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    // One run, so nothing in this test depends on a retry being created.
    maxRunsPerTask: 1,
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
  session: { id: "session-114" },
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

const requiredOutputClaim = (remoteUrl: string): ClaimedTask => {
  const base = claim(remoteUrl);
  return {
    ...base,
    task: {
      ...base.task,
      templateStep: { name: "Implementation", outputKind: "implementation" },
    },
  };
};

const regressionOutputClaim = (remoteUrl: string): ClaimedTask => {
  const base = claim(remoteUrl);
  return {
    ...base,
    task: {
      ...base.task,
      chainId: "chain-1",
      chainIndex: 5,
      templateStep: { name: "Regression verification", outputKind: REGRESSION_OUTPUT_KIND },
    },
  };
};

const regressionFailureAgent = [
  "#!/bin/sh",
  'case "$1" in',
  '  --version) echo "1.2.3-stub"; exit 0 ;;',
  '  --help) echo "--setting-sources"; exit 0 ;;',
  '  auth) echo \'{"loggedIn": true, "authMethod": "stub"}\'; exit 0 ;;',
  "esac",
  "cat > /dev/null",
  'head_sha="$(git rev-parse HEAD)"',
  'mkdir -p "$AGENTOS_WORKSPACE_PATH/.agentos"',
  'HEAD_SHA="$head_sha" node -e \'',
  'const body = JSON.stringify({ schemaVersion: 2, outcome: "review-fail", headSha: process.env.HEAD_SHA, baseHeadSha: "b".repeat(40), summary: "RF-2 remains open" });',
  'process.stdout.write(JSON.stringify({ schemaVersion: 1, runId: process.env.AGENTOS_RUN_ID, kind: "regression-verification-v2", body, commitSha: process.env.HEAD_SHA }));',
  '\' > "$AGENTOS_WORKSPACE_PATH/.agentos/regression-output.json"',
  'chmod 600 "$AGENTOS_WORKSPACE_PATH/.agentos/regression-output.json"',
  'echo "Error: provider transport disconnected after verdict" >&2',
  "exit 1",
].join("\n");

const outputStatus = (overrides: Partial<{
  outputKind: string | null;
  outputRequired: boolean;
  outputRemediationAllowed: boolean;
  outputSatisfiedByPriorRun: boolean;
  outputPersisted: boolean;
}> = {}) => ({
  task: {
    outputKind: "implementation",
    outputRequired: true,
    outputRemediationAllowed: true,
    outputSatisfiedByPriorRun: false,
    outputPersisted: false,
    ...overrides,
  },
});

/**
 * The succeeding stub again, with one addition: it drops a sentinel file on its
 * way out. The fetch stub below watches for that file, so a request can be
 * failed *after* the agent has finished and not before — which is the only
 * window in which the runner holds output it could still lose.
 */
const succeedingAgentThatSignalsExit = (sentinel: string): string =>
  succeedingAgent.replace(/exit 0$/u, `touch ${sentinel}\nexit 0`);

test("a failed run's completion carries the output tail the run produced", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "failing-agent.sh");
    await writeFile(agentBinary, failingAgent);
    await chmod(agentBinary, 0o755);

    const controlPlane = createControlPlaneDouble();

    await executeClaim(config(join(root, "workspaces"), agentBinary), claim(remote), { controlPlane: controlPlane.controlPlane });

    const completion = controlPlane.completions.at(-1);
    assert.ok(completion, "the run must complete even though the agent failed");
    assert.equal(completion.terminalSuccess, false, "this is the failing case, not a success in disguise");
    // The two facts issue #114 turns on: the tail exists on the wire, and it is
    // the agent's own account of what it found — the thing that used to be
    // dropped by the handler that received it.
    assert.equal(typeof completion.output, "string");
    assert.match(
      String(completion.output),
      /reproduced the deadlock: workers 3 and 7 both hold the inbox advisory lock/,
    );
    assert.match(String(completion.output), /lock ordering inverted in reconcile\.ts$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful run's completion carries its final output as the same tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-ok-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "succeeding-agent.sh");
    await writeFile(agentBinary, succeedingAgent);
    await chmod(agentBinary, 0o755);

    const controlPlane = createControlPlaneDouble();

    await executeClaim(config(join(root, "workspaces"), agentBinary), claim(remote), { controlPlane: controlPlane.controlPlane });

    const completion = controlPlane.completions.at(-1);
    assert.ok(completion, "the run must complete");
    assert.equal(completion.terminalSuccess, true);
    assert.equal(
      completion.output,
      "inverted the lock ordering in reconcile.ts and added the regression test",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a negative Regression verdict settles mechanically when provider transport fails afterwards", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-regression-transport-failure-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "regression-agent.sh");
    await writeFile(agentBinary, regressionFailureAgent);
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble();

    await executeClaim(
      config(join(root, "workspaces"), agentBinary),
      regressionOutputClaim(remote),
      { controlPlane: controlPlane.controlPlane },
    );

    assert.equal(
      controlPlane.taskOutputs.length,
      1,
      JSON.stringify({ completion: controlPlane.completions.at(-1), events: controlPlane.eventBatches.flat() }),
    );
    const persisted = controlPlane.taskOutputs[0];
    assert.equal(persisted?.kind, REGRESSION_OUTPUT_KIND);
    assert.match(persisted?.commitSha ?? "", /^[0-9a-f]{40}$/u);
    assert.deepEqual(JSON.parse(persisted?.body ?? "{}"), {
      schemaVersion: 2,
      outcome: "review-fail",
      headSha: persisted?.commitSha,
      baseHeadSha: "b".repeat(40),
      summary: "RF-2 remains open",
    });
    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, true);
    assert.equal(completion?.exitCode, 0);
    assert.equal(completion?.signal, null);
    assert.equal(completion?.terminalEventSeen, true);
    assert.equal(completion?.terminationReason, null);
    assert.ok(controlPlane.eventBatches.flat().some(({ type }) => type === "REGRESSION_OUTPUT_HANDOFF_PERSISTED"));
    assert.equal(
      controlPlane.eventBatches.flat().some(({ type }) => type === "TASK_OUTPUT_REMEDIATION_STARTED"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Regression mechanical output handoff retries a transient control-plane failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-regression-output-retry-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "regression-agent.sh");
    await writeFile(agentBinary, regressionFailureAgent);
    await chmod(agentBinary, 0o755);
    let attempts = 0;
    const controlPlane = createControlPlaneDouble({
      persistSessionTaskOutput: async () => {
        attempts += 1;
        if (attempts === 1) throw new ControlPlaneError(500, "transaction expired");
      },
    });

    await executeClaim(
      config(join(root, "workspaces"), agentBinary),
      regressionOutputClaim(remote),
      { controlPlane: controlPlane.controlPlane },
    );

    assert.equal(attempts, 2);
    assert.equal(controlPlane.completions.at(-1)?.terminalSuccess, true);
    const retrying = controlPlane.eventBatches.flat()
      .find(({ type }) => type === "REGRESSION_OUTPUT_HANDOFF_RETRYING");
    assert.equal(retrying?.payload.attempt, 1);
    assert.equal(retrying?.payload.attempts, 3);
    assert.ok(controlPlane.eventBatches.flat().some(({ type }) => type === "REGRESSION_OUTPUT_HANDOFF_PERSISTED"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Regression v2 never resumes the model to remediate an absent mechanical handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-regression-no-model-remediation-"));
  try {
    const remote = await seedRemote(root);
    const remediationPrompt = join(root, "remediation-prompt.txt");
    const agentBinary = join(root, "regression-agent.sh");
    await writeFile(agentBinary, remediatingAgent(remediationPrompt));
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => outputStatus({
        outputKind: REGRESSION_OUTPUT_KIND,
        outputRemediationAllowed: true,
      }).task,
    });

    await executeClaim(
      config(join(root, "workspaces"), agentBinary),
      regressionOutputClaim(remote),
      { controlPlane: controlPlane.controlPlane },
    );

    assert.equal(existsSync(remediationPrompt), false);
    assert.equal(controlPlane.completions.at(-1)?.terminalSuccess, false);
    assert.equal(
      controlPlane.completions.at(-1)?.failureClass,
      "PROTOCOL_ERROR",
      JSON.stringify({ completion: controlPlane.completions.at(-1), events: controlPlane.eventBatches.flat() }),
    );
    const unavailable = controlPlane.eventBatches.flat()
      .find(({ type }) => type === "TASK_OUTPUT_REMEDIATION_UNAVAILABLE");
    assert.equal(unavailable?.payload.reason, "mechanical-handoff-absent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful run remediates its missing required output in the same provider session", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-remediation-"));
  try {
    const remote = await seedRemote(root);
    const remediationPrompt = join(root, "remediation-prompt.txt");
    const agentBinary = join(root, "remediating-agent.sh");
    await writeFile(agentBinary, remediatingAgent(remediationPrompt));
    await chmod(agentBinary, 0o755);

    let statusReads = 0;
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => {
        statusReads += 1;
        return outputStatus({ outputPersisted: statusReads >= 2 }).task;
      },
    });

    await executeClaim(
      config(join(root, "workspaces"), agentBinary),
      requiredOutputClaim(remote),
      { controlPlane: controlPlane.controlPlane },
    );

    assert.equal(
      statusReads,
      2,
      "runner must confirm both the miss and its repair",
    );
    const prompt = await readFile(remediationPrompt, "utf8");
    assert.match(prompt, /call task_output with kind 'implementation'/u);
    assert.match(prompt, /Do not redo the task/u);
    const eventTypes = controlPlane.eventBatches
      .flatMap((batch) => batch)
      .map(({ type }) => type);
    assert.ok(eventTypes.includes("TASK_OUTPUT_REMEDIATION_STARTED"));
    assert.ok(eventTypes.includes("TASK_OUTPUT_REMEDIATION_FINISHED"));
    const completion = controlPlane.completions.at(-1);
    assert.ok(completion);
    assert.equal(completion.terminalSuccess, true);
    assert.equal(completion.output, "implemented the requested change");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an immutable output satisfied by a prior Run skips remediation", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-remediation-immutable-"));
  try {
    const remote = await seedRemote(root);
    const remediationPrompt = join(root, "remediation-prompt.txt");
    const agentBinary = join(root, "remediating-agent.sh");
    await writeFile(agentBinary, remediatingAgent(remediationPrompt));
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => outputStatus({
          outputRemediationAllowed: false,
          outputSatisfiedByPriorRun: true,
      }).task,
    });

    await executeClaim(config(join(root, "workspaces"), agentBinary), requiredOutputClaim(remote), {
      controlPlane: controlPlane.controlPlane,
    });

    assert.equal(existsSync(remediationPrompt), false);
    assert.ok(controlPlane.eventBatches.flat().some(({ type }) => type === "TASK_OUTPUT_REMEDIATION_SKIPPED"));
    assert.equal(controlPlane.completions.at(-1)?.terminalSuccess, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing output with no provider conversation reports remediation unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-remediation-no-conversation-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, succeedingAgent);
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => outputStatus().task,
    });

    await executeClaim(config(join(root, "workspaces"), agentBinary), requiredOutputClaim(remote), {
      controlPlane: controlPlane.controlPlane,
    });

    const unavailable = controlPlane.eventBatches.flat().find(({ type }) => type === "TASK_OUTPUT_REMEDIATION_UNAVAILABLE");
    assert.ok(unavailable);
    assert.equal(unavailable.payload.providerConversationIdAvailable, false);
    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, false);
    assert.equal(completion?.failureClass, "PROTOCOL_ERROR");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed output status read is diagnosed without attempting remediation", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-remediation-check-failed-"));
  try {
    const remote = await seedRemote(root);
    const remediationPrompt = join(root, "remediation-prompt.txt");
    const agentBinary = join(root, "remediating-agent.sh");
    await writeFile(agentBinary, remediatingAgent(remediationPrompt));
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => {
        throw new ControlPlaneError(503, "status unavailable");
      },
    });

    await executeClaim(config(join(root, "workspaces"), agentBinary), requiredOutputClaim(remote), {
      controlPlane: controlPlane.controlPlane,
    });

    assert.equal(existsSync(remediationPrompt), false);
    const events = controlPlane.eventBatches.flat();
    const failed = events.find(({ type }) => type === "TASK_OUTPUT_REMEDIATION_CHECK_FAILED");
    assert.ok(failed);
    assert.match(String(failed.payload.message), /503/u);
    assert.equal(events.some(({ type }) => type === "TASK_OUTPUT_REMEDIATION_STARTED"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remediation that still leaves output missing fails with provider evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-remediation-still-missing-"));
  try {
    const remote = await seedRemote(root);
    const remediationPrompt = join(root, "remediation-prompt.txt");
    const agentBinary = join(root, "remediating-agent.sh");
    const remediationResult = `${"x".repeat(5_000)}diagnostic final output`;
    await writeFile(agentBinary, remediatingAgent(remediationPrompt, [], remediationResult));
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => outputStatus().task,
    });

    await executeClaim(config(join(root, "workspaces"), agentBinary), requiredOutputClaim(remote), {
      controlPlane: controlPlane.controlPlane,
    });

    const finished = controlPlane.eventBatches.flat().find(({ type }) => type === "TASK_OUTPUT_REMEDIATION_FINISHED");
    assert.ok(finished);
    assert.equal(finished.payload.outputPersisted, false);
    const evidence = finished.payload.evidence as Record<string, unknown>;
    assert.equal(evidence.finalOutputTail, summarizeEvidence(remediationResult));
    assert.match(String(evidence.finalOutputTail), /^…\[\d+ earlier characters truncated\]/u);
    assert.match(String(evidence.finalOutputTail), /diagnostic final output$/u);
    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, false);
    assert.equal(completion?.failureClass, "PROTOCOL_ERROR");
    assert.match(String(completion?.failureReason), /finished without persisting implementation output/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation during remediation drains the resumed handle before ACK", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-remediation-cancel-"));
  try {
    const remote = await seedRemote(root);
    const remediationPrompt = join(root, "remediation-prompt.txt");
    const agentBinary = join(root, "remediating-agent.sh");
    await writeFile(agentBinary, remediatingAgent(remediationPrompt, ["sleep 30"]));
    await chmod(agentBinary, 0o755);
    let resumedHandle: RuntimeHandle | null = null;
    let resumeReturning = false;
    let resumedHandleDrained = false;
    const adapter = {
      ...adapters.CLAUDE,
      resume: async (...args: Parameters<typeof adapters.CLAUDE.resume>) => {
        const launched = await adapters.CLAUDE.resume(...args);
        resumedHandle = launched;
        resumeReturning = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        return launched;
      },
      kill: async (...args: Parameters<typeof adapters.CLAUDE.kill>) => {
        const result = await adapters.CLAUDE.kill(...args);
        if (args[0] === resumedHandle) resumedHandleDrained = !result.processAlive;
        return result;
      },
    };
    let cancellationSent = false;
    let ackObservedAfterDrain = false;
    let acknowledgementCount = 0;
    const configured = { ...config(join(root, "workspaces"), agentBinary), heartbeatIntervalMs: 10 };
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => outputStatus().task,
      heartbeat: async () => {
        if (!resumeReturning || cancellationSent) return { ok: true, cancellation: null };
        cancellationSent = true;
        return {
          ok: false,
          cancellation: { requestId: "cancel-remediation", reason: "operator stop", requestedAt: new Date(0).toISOString() },
        };
      },
      acknowledgeCancellation: async () => {
        acknowledgementCount += 1;
        ackObservedAfterDrain = resumedHandleDrained;
      },
    });

    await executeClaim(configured, requiredOutputClaim(remote), { adapter, controlPlane: controlPlane.controlPlane });

    assert.equal(cancellationSent, true);
    assert.equal(resumedHandleDrained, true);
    assert.equal(ackObservedAfterDrain, true);
    assert.equal(acknowledgementCount, 1);
    assert.equal(controlPlane.completions.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remediation cannot change workspace HEAD or publish its changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-remediation-head-drift-"));
  try {
    const remote = await seedRemote(root);
    const originalHead = git(root, `--git-dir=${remote}`, "rev-parse", "refs/heads/master");
    const remediationPrompt = join(root, "remediation-prompt.txt");
    const agentBinary = join(root, "remediating-agent.sh");
    await writeFile(agentBinary, remediatingAgent(remediationPrompt, [
      "printf 'remediation edit\\n' > tree.txt",
      "git add tree.txt",
      "git -c user.name='AgentOS Test' -c user.email='runner@agentos.local' commit -m 'forbidden remediation edit' >/dev/null",
    ]));
    await chmod(agentBinary, 0o755);
    let statusReads = 0;
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => {
        statusReads += 1;
        return outputStatus({ outputPersisted: statusReads >= 2 }).task;
      },
    });

    await executeClaim(config(join(root, "workspaces"), agentBinary), requiredOutputClaim(remote), {
      controlPlane: controlPlane.controlPlane,
    });

    const finished = controlPlane.eventBatches.flat().find(({ type }) => type === "TASK_OUTPUT_REMEDIATION_FINISHED");
    assert.ok(finished);
    assert.equal(finished.payload.workspaceChanged, true);
    assert.notEqual(
      (finished.payload.workspaceBefore as Record<string, unknown>).headSha,
      (finished.payload.workspaceAfter as Record<string, unknown>).headSha,
    );
    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.failureClass, "PROTOCOL_ERROR");
    assert.equal(completion?.pushStatus, "NOT_REQUESTED");
    assert.equal(git(root, `--git-dir=${remote}`, "rev-parse", "refs/heads/master"), originalHead);
    assert.deepEqual(git(root, `--git-dir=${remote}`, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n"), ["refs/heads/master"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the original Run budget continues through remediation", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-remediation-budget-"));
  try {
    const remote = await seedRemote(root);
    const remediationPrompt = join(root, "remediation-prompt.txt");
    const agentBinary = join(root, "remediating-agent.sh");
    await writeFile(agentBinary, remediatingAgent(remediationPrompt, ["sleep 30"]));
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => outputStatus().task,
    });
    const configured = { ...config(join(root, "workspaces"), agentBinary), heartbeatIntervalMs: 10 };
    const claimed = requiredOutputClaim(remote);
    claimed.run.maxDurationMin = 0.002;

    await executeClaim(configured, claimed, { controlPlane: controlPlane.controlPlane });
    // The heartbeat callback that performs the budget kill finishes its
    // best-effort event report asynchronously. Under full-suite load a fixed
    // sleep can expire before that callback is scheduled, so wait for the
    // observable report instead.
    let finished = controlPlane.eventBatches.flat().find(({ type }) => type === "TASK_OUTPUT_REMEDIATION_FINISHED");
    for (let attempt = 0; attempt < 100 && !finished; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      finished = controlPlane.eventBatches.flat().find(({ type }) => type === "TASK_OUTPUT_REMEDIATION_FINISHED");
    }

    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, false);
    assert.equal(completion?.failureClass, "BUDGET_EXCEEDED");
    assert.match(String(completion?.failureReason), /walltime budget exceeded/u);
    assert.ok(finished);
    assert.equal(finished.payload.outputPersisted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("output the agent already produced survives a delivery-phase failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-deliver-"));
  try {
    const remote = await seedRemote(root);
    const sentinel = join(root, "agent-exited");
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, succeedingAgentThatSignalsExit(sentinel));
    await chmod(agentBinary, 0o755);

    const controlPlane = createControlPlaneDouble({
      appendEvents: async () => {
      // The event flush the runner performs once the agent is gone, on its way
      // into delivery. A dropped connection there is ordinary — and it throws
      // out of the try block, into the catch that reports the run.
        if (existsSync(sentinel)) throw new Error("connection reset by peer");
      },
    });
    // The drain retries the flush until the delivery deadline, so this test's
    // wall clock is that deadline and nothing else. A 60s lease makes it 35s;
    // a short one floors it at MIN_DELIVERY_BUDGET_MS instead. The loop is
    // exercised identically either way — it exhausts its budget with events
    // still pending — and the gate's critical path keeps the other 25 seconds.
    const configured = { ...config(join(root, "workspaces"), agentBinary), leaseSeconds: 26 };

    await executeClaim(configured, claim(remote), { controlPlane: controlPlane.controlPlane });

    const completion = controlPlane.completions.at(-1);
    assert.ok(completion, "the run must still be completed");
    // The failure is the runner's own, reported as such: this is the exception
    // path, not the ordinary one.
    assert.equal(completion.terminationReason, RUNNER_EXCEPTION_REASON);
    assert.match(String(completion.failureReason), /connection reset by peer/);
    // And the agent's work is still in it. This path used to rebuild its
    // evidence from the error message alone, so a run that had produced a real
    // answer reported nothing but the plumbing fault that followed it.
    assert.equal(
      completion.output,
      "inverted the lock ordering in reconcile.ts and added the regression test",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run that fails before its agent exists sends no output at all", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-none-"));
  try {
    const controlPlane = createControlPlaneDouble();

    // A remote no clone can reach: the run dies in PROVISION, before any agent
    // has run. The carried tail must stay null rather than report an empty
    // string as if the agent had produced nothing.
    await executeClaim(
      config(join(root, "workspaces"), join(root, "never-spawned.sh")),
      claim("/nonexistent/agentos-issue-114-no-such-repo.git"),
      { controlPlane: controlPlane.controlPlane },
    );

    const completion = controlPlane.completions.at(-1);
    assert.ok(completion, "a provisioning failure still completes the run");
    assert.equal(completion.output ?? null, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
