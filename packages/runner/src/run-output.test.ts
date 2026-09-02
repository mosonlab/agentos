import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PR_TEMPLATE_NAME } from "@anneal/db";

import { ControlPlaneError, type ClaimedTask } from "./api.js";
import { adapters, type ExitEvidence, type RuntimeHandle } from "./adapters.js";
import { parseClaudeTranscript } from "./adapters/claude.js";
import { parseCodexTranscript } from "./adapters/codex.js";
import { parsePiTranscript } from "./adapters/pi.js";
import type { RunnerConfig } from "./config.js";
import { RUNNER_EXCEPTION_REASON, summarizeEvidence } from "./envelope.js";
import { executeClaim as executeClaimProduction } from "./runner.js";
import { createControlPlaneDouble } from "./test-control-plane.js";
import { materializeRuntimeTools } from "./workspace.js";

const REGRESSION_OUTPUT_KIND = "regression-verification-v2";

const executeClaim = (
  ...[runnerConfig, claim, dependencies = {}]: Parameters<typeof executeClaimProduction>
) => executeClaimProduction(runnerConfig, claim, {
  materializeRuntimeTools: (config, scratch) => materializeRuntimeTools(config, scratch, {
    sourceRoot: fileURLToPath(new URL("../runtime-tools/", import.meta.url)),
  }),
  ...dependencies,
});

const committedFixtureChange = [
  'printf "delivered fixture change\\n" > runner-fixture.txt',
  "git add runner-fixture.txt",
  'git commit -m "test: create delivered fixture change" >/dev/null',
] as const;

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
  ...committedFixtureChange,
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
  ...committedFixtureChange.map((command) => `    ${command}`),
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
  git(seed, "config", "user.name", "Anneal Test");
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
  claimMaxLoadAverage: 1.5,
  leaseSeconds: 60,
  heartbeatIntervalMs: 60_000,
  path: process.env.PATH ?? "/usr/bin:/bin",
  home: join(workspaceRoot, "..", "home"),
  gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
  workspaceRoot,
  hostProofSlots: 3,
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
  repo: {
    id: "repo-1",
    remoteUrl,
    defaultBranch: "master",
    mountPath: "/does/not/exist",
    dependencyProvisioning: "NPM_CI",
  },
  run: {
    id: "run-114",
    runNumber: 1,
    opensPullRequest: false,
    requiresCommit: true,
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
      templateStep: { name: "Implementation", outputKind: "implementation", provisionDependencies: true },
    },
  };
};

const resultOutputClaim = (remoteUrl: string): ClaimedTask => {
  const base = claim(remoteUrl);
  return {
    ...base,
    task: {
      ...base.task,
      templateStep: { name: "Implementation", outputKind: "result", provisionDependencies: true },
    },
  };
};

const canonicalPrImplementationClaim = (remoteUrl: string): ClaimedTask => {
  const base = requiredOutputClaim(remoteUrl);
  return {
    ...base,
    task: {
      ...base.task,
      chainId: "chain-pr",
      chainIndex: 1,
      templateStep: {
        ...base.task.templateStep!,
        taskTemplate: { name: PR_TEMPLATE_NAME },
      } as ClaimedTask["task"]["templateStep"],
    },
    run: { ...base.run, opensPullRequest: true },
  };
};

const regressionOutputClaim = (remoteUrl: string): ClaimedTask => {
  const base = claim(remoteUrl);
  return {
    ...base,
    run: { ...base.run, requiresCommit: false },
    task: {
      ...base.task,
      chainId: "chain-1",
      chainIndex: 5,
      templateStep: { name: "Regression verification", outputKind: REGRESSION_OUTPUT_KIND, provisionDependencies: true },
    },
  };
};

const regressionAgent = (tail: readonly string[]): string => [
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
  ...tail,
].join("\n");

const regressionFailureAgent = regressionAgent([
  'echo "Error: provider transport disconnected after verdict" >&2',
  "exit 1",
]);

const regressionExplicitTerminalFailureAgent = regressionAgent([
  'echo \'{"type":"result","is_error":true,"terminal_reason":"error","result":"provider rejected regression run"}\'',
  "exit 0",
]);

const outputStatus = (overrides: Partial<{
  outputKind: string | null;
  outputRequired: boolean;
  outputRemediationAllowed: boolean;
  outputSatisfiedByPriorRun: boolean;
  outputPersisted: boolean;
  output: { runId: string; kind: string; commitSha: string | null } | null;
}> = {}) => ({
  task: {
    outputKind: "implementation",
    outputRequired: true,
    outputRemediationAllowed: true,
    outputSatisfiedByPriorRun: false,
    outputPersisted: false,
    output: null,
    ...overrides,
  },
});

const matchingResultOutputStatus = (root: string) => outputStatus({
  outputKind: "result",
  outputPersisted: true,
  output: {
    runId: "run-114",
    kind: "result",
    commitSha: git(join(root, "workspaces", "run-114"), "rev-parse", "HEAD"),
  },
}).task;

/**
 * The succeeding stub again, with one addition: it drops a sentinel file on its
 * way out. The fetch stub below watches for that file, so a request can be
 * failed *after* the agent has finished and not before — which is the only
 * window in which the runner holds output it could still lose.
 */
const succeedingAgentThatSignalsExit = (sentinel: string): string =>
  succeedingAgent.replace(/exit 0$/u, `touch ${sentinel}\nexit 0`);

const streamLostAfterDeliveryAgent = (
  output: "matching" | "mismatched" | "missing" | "protected",
  exitCode = 0,
  stderr = "",
): string => [
  "#!/bin/sh",
  'case "$1" in',
  '  --version) echo "1.2.3-stub"; exit 0 ;;',
  '  --help) echo "--setting-sources"; exit 0 ;;',
  '  auth) echo \'{"loggedIn": true, "authMethod": "stub"}\'; exit 0 ;;',
  "esac",
  "cat > /dev/null",
  ...committedFixtureChange,
  ...(output === "missing" ? [] : [
    'head_sha="$(git rev-parse HEAD)"',
    ...(output === "mismatched" ? [`head_sha="${"a".repeat(40)}"`] : []),
    'printf \'{"runId":"%s","kind":"result","commitSha":"%s"}\\n\' "$AGENTOS_RUN_ID" "$head_sha" > .agentos/task-output-receipt.json',
    ...(output === "protected" ? ["chmod 000 .agentos/task-output-receipt.json"] : []),
  ]),
  ...(stderr ? [`echo ${JSON.stringify(stderr)} >&2`] : []),
  `exit ${exitCode}`,
].join("\n");

const adapterWithTerminalFailure = (state: {
  terminalEventSeen: boolean;
  terminalSuccess: boolean;
  providerError: string | null;
  finalOutput: string | null;
}) => ({
  ...adapters.CLAUDE,
  start: async (...args: Parameters<typeof adapters.CLAUDE.start>) => {
    const runtime = await adapters.CLAUDE.start(...args);
    runtime.exit = runtime.exit.then((evidence) => ({
      ...evidence,
      terminalEventSeen: state.terminalEventSeen,
      terminalSuccess: state.terminalSuccess,
      providerError: state.providerError,
      finalOutput: state.finalOutput,
    }));
    return runtime;
  },
});

const explicitTerminalFailureFixtures = [
  {
    adapter: "Claude",
    state: parseClaudeTranscript([{
      type: "result",
      is_error: true,
      terminal_reason: "completed",
      result: "Claude explicit terminal failure",
    }]),
  },
  {
    adapter: "Codex",
    state: parseCodexTranscript([
      { type: "error", message: "Codex turn failed" },
      { type: "turn.completed" },
    ]),
  },
  {
    adapter: "PI",
    state: parsePiTranscript([
      {
        type: "turn_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "PI final attempt failed" },
      },
      {
        type: "agent_end",
        willRetry: false,
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "PI final attempt failed" }],
      },
      { type: "agent_settled" },
    ]),
  },
] as const;

const rejectedServerIdentityFixtures = [
  {
    name: "a different Run",
    output: (root: string) => ({
      runId: "run-other",
      kind: "result",
      commitSha: git(join(root, "workspaces", "run-114"), "rev-parse", "HEAD"),
    }),
  },
  {
    name: "a non-result kind",
    output: (root: string) => ({
      runId: "run-114",
      kind: "implementation",
      commitSha: git(join(root, "workspaces", "run-114"), "rev-parse", "HEAD"),
    }),
  },
  {
    name: "a non-40-hex commit SHA",
    output: () => ({ runId: "run-114", kind: "result", commitSha: "not-a-commit-sha" }),
  },
] as const;

const mcpServerModule = pathToFileURL(fileURLToPath(new URL("./mcp-server.ts", import.meta.url))).href;
const tsxModule = import.meta.resolve("tsx");
const mcpDeliveredDisconnectAgent = [
  "#!/bin/sh",
  'case "$1" in',
  '  --version) echo "1.2.3-stub"; exit 0 ;;',
  '  --help) echo "--setting-sources"; exit 0 ;;',
  '  auth) echo \'{"loggedIn": true, "authMethod": "stub"}\'; exit 0 ;;',
  "esac",
  "cat > /dev/null",
  ...committedFixtureChange,
  `${JSON.stringify(process.execPath)} --conditions=development --import ${JSON.stringify(tsxModule)} --input-type=module -e ${JSON.stringify([
    `import { invokeTool, readCredentials } from ${JSON.stringify(mcpServerModule)};`,
    'await invokeTool(readCredentials(process.env), "task_output", { kind: "result", body: "delivered" });',
  ].join(" "))}`,
  "exit 0",
].join("\n");

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
    assert.equal(completion?.baseSha, completion?.headSha, "Regression produced a verdict without advancing HEAD");
    assert.equal(completion?.pushStatus, "SUCCEEDED");
    assert.ok(completion?.pushedBranch);
    assert.deepEqual(controlPlane.publishedBranches, [completion.pushedBranch]);
    assert.ok(controlPlane.eventBatches.flat().some(({ type }) => type === "REGRESSION_OUTPUT_HANDOFF_PERSISTED"));
    assert.equal(
      controlPlane.eventBatches.flat().some(({ type }) => type === "TASK_OUTPUT_REMEDIATION_STARTED"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Regression handoff cannot override an explicit provider terminal failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-regression-explicit-failure-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "regression-agent.sh");
    await writeFile(agentBinary, regressionExplicitTerminalFailureAgent);
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble();

    await executeClaim(
      config(join(root, "workspaces"), agentBinary),
      regressionOutputClaim(remote),
      { controlPlane: controlPlane.controlPlane },
    );

    assert.equal(controlPlane.taskOutputs.length, 1);
    assert.equal(controlPlane.taskOutputs[0]?.kind, REGRESSION_OUTPUT_KIND);
    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, false, JSON.stringify(completion));
    assert.equal(completion?.failureReason, "provider rejected regression run");
    assert.equal(
      controlPlane.eventBatches.flat().some(({ type }) => type === "POST_DELIVERY_DISCONNECT_ACCEPTED"),
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
    assert.equal(completion.pushStatus, "SUCCEEDED");
    assert.equal(completion.output, "implemented the requested change");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical PR evidence handoff failures are flushed before completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-pr-evidence-handoff-failure-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, succeedingAgent);
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      // The regular required-output check succeeds. The canonical PR projection
      // is deliberately absent, which must fail closed and leave a durable
      // diagnostic event rather than silently proceeding with generic delivery.
      readSessionTaskOutputStatus: async () => outputStatus({ outputPersisted: true }).task,
    });

    await executeClaim(
      config(join(root, "workspaces"), agentBinary),
      canonicalPrImplementationClaim(remote),
      { controlPlane: controlPlane.controlPlane },
    );

    const completion = controlPlane.completions.at(-1);
    assert.ok(completion);
    assert.equal(completion.terminalSuccess, false);
    assert.equal(completion.failureClass, "PROTOCOL_ERROR");
    assert.match(String(completion.failureReason), /Canonical PR workflow evidence handoff failed/u);
    const events = controlPlane.eventBatches.flat();
    const handoffFailure = events.find(({ type }) => type === "PR_WORKFLOW_EVIDENCE_HANDOFF_FAILED");
    assert.ok(handoffFailure, "the handoff failure must be appended before terminal completion");
    assert.match(String(handoffFailure.payload.message), /omitted canonical PR workflow output evidence/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical PR evidence handoff does not overwrite an earlier terminal failure reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-pr-first-failure-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, succeedingAgent);
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => outputStatus({
        outputPersisted: false,
        outputRemediationAllowed: false,
      }).task,
    });

    await executeClaim(
      config(join(root, "workspaces"), agentBinary),
      canonicalPrImplementationClaim(remote),
      { controlPlane: controlPlane.controlPlane },
    );

    const completion = controlPlane.completions.at(-1);
    assert.ok(completion);
    assert.equal(completion.terminalSuccess, false);
    assert.match(String(completion.failureReason), /Task output remediation unavailable/u);
    assert.doesNotMatch(String(completion.failureReason), /Canonical PR workflow evidence handoff failed/u);
    assert.ok(controlPlane.eventBatches.flat().some(({ type }) => type === "PR_WORKFLOW_EVIDENCE_HANDOFF_FAILED"));
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
    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, false);
    assert.equal(completion?.failureClass, "PROTOCOL_ERROR");
    assert.equal(completion?.retryable, false);
    assert.match(
      String(completion?.failureReason),
      /required 'implementation' output.*status unavailable/u,
    );
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
      "git -c user.name='Anneal Test' -c user.email='runner@agentos.local' commit -m 'forbidden remediation edit' >/dev/null",
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
    await writeFile(agentBinary, remediatingAgent(remediationPrompt));
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => outputStatus().task,
    });
    let initialHandle: RuntimeHandle | null = null;
    let remediationHandle: RuntimeHandle | null = null;
    let finishRemediation: ((evidence: ExitEvidence) => void) | null = null;
    let budgetSignalSent = false;
    let budgetFired = false;
    let remediationSetupState = "not-started";
    const adapter = {
      ...adapters.CLAUDE,
      start: async (...args: Parameters<typeof adapters.CLAUDE.start>) => {
        const launched = await adapters.CLAUDE.start(...args);
        initialHandle = launched;
        return launched;
      },
      resume: async () => {
        const firstHandle = initialHandle;
        if (!firstHandle) throw new Error("remediation setup started without an initial provider handle");
        remediationSetupState = "running";
        const exit = new Promise<ExitEvidence>((resolve) => { finishRemediation = resolve; });
        const startedAt = new Date();
        const resumed: RuntimeHandle = {
          ...firstHandle,
          startedAt,
          lastProcessAliveAt: startedAt,
          lastProgressEventAt: startedAt,
          terminalEventSeen: false,
          terminalSuccess: false,
          terminationReason: null,
          finalOutput: null,
          stdout: "",
          stderr: "",
          child: firstHandle.child,
          pid: null,
          exit,
        };
        remediationHandle = resumed;
        return resumed;
      },
      heartbeat: async (handle: RuntimeHandle) => {
        if (handle !== remediationHandle) return adapters.CLAUDE.heartbeat(handle);
        if (!budgetSignalSent) {
          budgetSignalSent = true;
          const firstHandle = initialHandle;
          if (!firstHandle) throw new Error("remediation heartbeat arrived without an initial provider handle");
          // executeClaim deliberately keeps this Date object as the original
          // Run's budget anchor while it awaits remediation. Advancing it here
          // is the explicit test signal that the original budget has expired.
          firstHandle.startedAt.setTime(0);
        }
        return {
          processAlive: true,
          lastProcessAliveAt: new Date(),
          lastProgressEventAt: new Date(),
          inFlightTool: null,
        };
      },
      kill: async (handle: RuntimeHandle, reason: string) => {
        if (handle !== remediationHandle) return adapters.CLAUDE.kill(handle, reason);
        const finish = finishRemediation;
        if (!finish) throw new Error("budget kill arrived before remediation setup completed");
        budgetFired = reason.includes("walltime budget exceeded");
        remediationSetupState = budgetFired ? "budget-fired" : `stopped-before-budget: ${reason}`;
        handle.terminationReason = reason;
        finish({
          exitCode: null,
          signal: "SIGTERM",
          terminalEventSeen: false,
          terminalSuccess: false,
          terminationReason: reason,
          finalOutput: null,
          providerError: null,
          stdout: "",
          stderr: "",
        });
        return { signal: "SIGTERM" as const, processAlive: false };
      },
    };
    const configured = { ...config(join(root, "workspaces"), agentBinary), heartbeatIntervalMs: 1 };
    const claimed = requiredOutputClaim(remote);
    // Keep a normal Run budget. The adapter heartbeat above supplies an
    // explicit expiry signal once remediation is actually running, so setup
    // cannot race a wall-clock budget or a real sleeping child process.

    await executeClaim(configured, claimed, { adapter, controlPlane: controlPlane.controlPlane });

    const completion = controlPlane.completions.at(-1);
    assert.equal(
      remediationSetupState,
      "budget-fired",
      `remediation setup did not reach the controlled budget expiry (state=${remediationSetupState}; completion=${JSON.stringify(completion)})`,
    );
    assert.equal(budgetSignalSent, true, "the remediation heartbeat did not deliver the controlled budget signal");
    assert.equal(budgetFired, true, "the original Run budget was not the reason remediation stopped");
    assert.equal(completion?.terminalSuccess, false);
    assert.equal(completion?.failureClass, "BUDGET_EXCEEDED");
    assert.match(String(completion?.failureReason), /walltime budget exceeded/u);
    const finished = controlPlane.eventBatches.flat().find(({ type }) => type === "TASK_OUTPUT_REMEDIATION_FINISHED");
    assert.ok(finished);
    assert.equal(finished.payload.outputPersisted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const fixture of explicitTerminalFailureFixtures) {
  test(`${fixture.adapter} explicit terminal failure cannot be promoted by delivered output`, async () => {
    const root = await mkdtemp(join(tmpdir(), `runner-output-${fixture.adapter.toLowerCase()}-terminal-failure-`));
    try {
      const remote = await seedRemote(root);
      const agentBinary = join(root, "agent.sh");
      await writeFile(agentBinary, streamLostAfterDeliveryAgent("matching"));
      await chmod(agentBinary, 0o755);
      const controlPlane = createControlPlaneDouble({
        readSessionTaskOutputStatus: async () => matchingResultOutputStatus(root),
      });

      await executeClaim(config(join(root, "workspaces"), agentBinary), resultOutputClaim(remote), {
        adapter: adapterWithTerminalFailure(fixture.state),
        controlPlane: controlPlane.controlPlane,
      });

      const completion = controlPlane.completions.at(-1);
      assert.equal(completion?.terminalSuccess, false, JSON.stringify(completion));
      assert.equal(completion?.failureReason, fixture.state.providerError);
      assert.equal(controlPlane.outputStatusReadCount(), 0);
      assert.equal(
        controlPlane.eventBatches.flat().some(({ type }) => type === "POST_DELIVERY_DISCONNECT_ACCEPTED"),
        false,
      );
      assert.equal(
        controlPlane.activities.some(({ body }) => body.includes("provider disconnect after delivery was tolerated")),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a missing terminal event with matching server output succeeds without a local receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-disconnect-promoted-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, streamLostAfterDeliveryAgent("missing"));
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => matchingResultOutputStatus(root),
    });
    const promotedClaim = resultOutputClaim(remote);
    promotedClaim.run.branch = "configured-delivery";

    await executeClaim(config(join(root, "workspaces"), agentBinary), promotedClaim, {
      controlPlane: controlPlane.controlPlane,
    });

    const completion = controlPlane.completions.at(-1);
    assert.ok(completion);
    assert.equal(completion.terminalSuccess, true);
    assert.equal(completion.pushedBranch, "configured-delivery", JSON.stringify(completion));
    assert.equal(completion.failureEnvelope, undefined);
    assert.equal(completion.failureClass, undefined);
    assert.deepEqual(controlPlane.publishedBranches, ["configured-delivery"]);
    const accepted = controlPlane.eventBatches.flat()
      .filter(({ type }) => type === "POST_DELIVERY_DISCONNECT_ACCEPTED");
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.payload.runId, "run-114");
    assert.match(String(accepted[0]?.payload.commitSha), /^[0-9a-f]{40}$/u);
    assert.equal(accepted[0]?.payload.providerError, null);
    assert.equal(accepted[0]?.payload.terminalEventSeen, false);
    assert.equal(accepted[0]?.payload.localReceipt, null);
    assert.match(String(accepted[0]?.payload.localReceiptReadError), /receipt is absent/u);
    const tolerated = controlPlane.activities.find(({ body, metadata }) =>
      metadata.stream === "runner" && body.includes("provider disconnect after delivery was tolerated"));
    assert.ok(tolerated);
    assert.match(tolerated.body, /no providerError reported/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transport-noise stderr does not suppress post-delivery disconnect promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-disconnect-noisy-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, streamLostAfterDeliveryAgent(
      "matching",
      0,
      "HTTP 503: connection reset while provider stream disconnected",
    ));
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => matchingResultOutputStatus(root),
    });
    const promotedClaim = resultOutputClaim(remote);
    promotedClaim.run.branch = "configured-delivery";

    await executeClaim(config(join(root, "workspaces"), agentBinary), promotedClaim, {
      controlPlane: controlPlane.controlPlane,
    });

    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, true, JSON.stringify(completion));
    assert.equal(completion?.pushedBranch, "configured-delivery");
    assert.equal(completion?.failureEnvelope, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run-as reader includes an otherwise protected receipt in recovery audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-disconnect-run-as-"));
  try {
    const remote = await seedRemote(root);
    await mkdir(join(root, "workspaces"), { recursive: true });
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, streamLostAfterDeliveryAgent("protected"));
    await chmod(agentBinary, 0o755);
    const prefixLog = join(root, "run-as.log");
    const launcher = join(root, "run-as.sh");
    await writeFile(launcher, [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(prefixLog)}`,
      'case "$*" in',
      '  *agentos-task-output-receipt*)',
      '    receipt="$PWD/.agentos/task-output-receipt.json"',
      `    if [ ! -r "$receipt" ]; then echo protected-receipt >> ${JSON.stringify(prefixLog)}; chmod 600 "$receipt"; fi`,
      "    ;;",
      "esac",
      'exec "$@"',
    ].join("\n"));
    await chmod(launcher, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => matchingResultOutputStatus(root),
    });
    const promotedClaim = resultOutputClaim(remote);
    promotedClaim.run.branch = "configured-delivery";
    const configured = {
      ...config(join(root, "workspaces"), agentBinary),
      runAsPrefix: [launcher],
    };

    await executeClaim(configured, promotedClaim, { controlPlane: controlPlane.controlPlane });

    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, true, JSON.stringify(completion));
    assert.equal(completion?.pushedBranch, "configured-delivery");
    const invocations = await readFile(prefixLog, "utf8");
    assert.match(invocations, /protected-receipt/u, "the receipt started unreadable to the daemon uid");
    assert.match(invocations, /agentos-task-output-receipt/u, "the receipt read must use runAsPrefix");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the real task_output MCP receipt promotes a delivered disconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-disconnect-mcp-"));
  const receivedOutputs: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      if (request.method === "PUT" && request.url === "/session/runs/run-114/output") {
        receivedOutputs.push(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: "output-1" }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const remote = await seedRemote(root);
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, mcpDeliveredDisconnectAgent);
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => {
        const delivered = receivedOutputs.at(-1);
        return outputStatus({
          outputKind: "result",
          outputPersisted: Boolean(delivered),
          output: delivered ? {
            runId: "run-114",
            kind: String(delivered.kind),
            commitSha: String(delivered.commitSha),
          } : null,
        }).task;
      },
    });
    const promotedClaim = resultOutputClaim(remote);
    promotedClaim.run.branch = "configured-delivery";
    const configured = {
      ...config(join(root, "workspaces"), agentBinary),
      apiUrl: `http://127.0.0.1:${port}`,
    };

    await executeClaim(configured, promotedClaim, { controlPlane: controlPlane.controlPlane });

    assert.equal(receivedOutputs.length, 1);
    assert.equal(receivedOutputs[0]?.kind, "result");
    assert.match(String(receivedOutputs[0]?.commitSha), /^[0-9a-f]{40}$/u);
    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, true, JSON.stringify(completion));
    assert.equal(completion?.pushedBranch, "configured-delivery");
    assert.equal(completion?.failureEnvelope, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("exit code 0 with no persisted output stays FAILED", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-disconnect-missing-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, streamLostAfterDeliveryAgent("matching"));
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => outputStatus({ outputKind: "result", outputPersisted: false }).task,
    });

    await executeClaim(config(join(root, "workspaces"), agentBinary), resultOutputClaim(remote), {
      controlPlane: controlPlane.controlPlane,
    });

    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, false);
    assert.equal(completion?.failureClass, "PROTOCOL_ERROR");
    assert.ok(completion?.failureEnvelope);
    assert.notEqual(completion?.pushedBranch, "master");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted output with no server-side identity stays FAILED even with a matching local receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-disconnect-no-receipt-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, streamLostAfterDeliveryAgent("matching"));
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => outputStatus({ outputKind: "result", outputPersisted: true, output: null }).task,
    });

    await executeClaim(config(join(root, "workspaces"), agentBinary), resultOutputClaim(remote), {
      controlPlane: controlPlane.controlPlane,
    });

    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, false);
    assert.equal(completion?.failureClass, "PROTOCOL_ERROR");
    const reported = controlPlane.eventBatches.flat()
      .find(({ type }) => type === "POST_DELIVERY_DISCONNECT_CHECK_FAILED");
    assert.match(String(reported?.payload.message), /no server-side identity/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const fixture of rejectedServerIdentityFixtures) {
  test(`server output identity for ${fixture.name} rejects recovery`, async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-output-disconnect-server-identity-"));
    try {
      const remote = await seedRemote(root);
      const agentBinary = join(root, "agent.sh");
      await writeFile(agentBinary, streamLostAfterDeliveryAgent("matching"));
      await chmod(agentBinary, 0o755);
      const controlPlane = createControlPlaneDouble({
        readSessionTaskOutputStatus: async () => outputStatus({
          outputKind: "result",
          outputPersisted: true,
          output: fixture.output(root),
        }).task,
      });

      await executeClaim(config(join(root, "workspaces"), agentBinary), resultOutputClaim(remote), {
        controlPlane: controlPlane.controlPlane,
      });

      const completion = controlPlane.completions.at(-1);
      assert.equal(completion?.terminalSuccess, false, JSON.stringify(completion));
      assert.equal(completion?.failureClass, "PROTOCOL_ERROR");
      assert.equal(
        controlPlane.eventBatches.flat().some(({ type }) => type === "POST_DELIVERY_DISCONNECT_ACCEPTED"),
        false,
      );
      assert.equal(
        controlPlane.eventBatches.flat()
          .filter(({ type }) => type === "POST_DELIVERY_DISCONNECT_CHECK_FAILED").length,
        1,
      );
      assert.equal(
        controlPlane.activities.some(({ body }) => body.includes("provider disconnect after delivery was tolerated")),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("a tolerance-activity failure does not demote a qualified promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-disconnect-activity-failure-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, streamLostAfterDeliveryAgent("matching"));
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => matchingResultOutputStatus(root),
      appendActivity: async (_config, _claim, body) => {
        if (body.includes("provider disconnect after delivery was tolerated")) throw new Error("activity unavailable");
      },
    });
    const promotedClaim = resultOutputClaim(remote);
    promotedClaim.run.branch = "configured-delivery";

    await executeClaim(config(join(root, "workspaces"), agentBinary), promotedClaim, {
      controlPlane: controlPlane.controlPlane,
    });

    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, true, JSON.stringify(completion));
    assert.equal(completion?.pushedBranch, "configured-delivery");
    const reported = controlPlane.eventBatches.flat()
      .find(({ type }) => type === "POST_DELIVERY_DISCONNECT_ACTIVITY_FAILED");
    assert.match(String(reported?.payload.message), /activity unavailable/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed delivery never claims that its provider disconnect was tolerated", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-disconnect-delivery-failure-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "agent.sh");
    await writeFile(
      agentBinary,
      streamLostAfterDeliveryAgent("matching").replace(
        /\nexit 0$/u,
        "\ngit remote set-url origin /does/not/exist\nexit 0",
      ),
    );
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => matchingResultOutputStatus(root),
    });

    await executeClaim(config(join(root, "workspaces"), agentBinary), resultOutputClaim(remote), {
      controlPlane: controlPlane.controlPlane,
    });

    assert.equal(controlPlane.completions.at(-1)?.terminalSuccess, false);
    assert.equal(
      controlPlane.activities.some(({ body }) => body.includes("provider disconnect after delivery was tolerated")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("output lookup errors preserve the original PROTOCOL_ERROR and are reported", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-disconnect-lookup-error-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, streamLostAfterDeliveryAgent("matching"));
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => {
        throw new ControlPlaneError(503, "output status unavailable");
      },
    });

    await executeClaim(config(join(root, "workspaces"), agentBinary), resultOutputClaim(remote), {
      controlPlane: controlPlane.controlPlane,
    });

    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, false);
    assert.equal(completion?.failureClass, "PROTOCOL_ERROR");
    assert.ok(completion?.failureEnvelope);
    const reported = controlPlane.eventBatches.flat()
      .find(({ type }) => type === "POST_DELIVERY_DISCONNECT_CHECK_FAILED");
    assert.match(String(reported?.payload.message), /503/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rewritten local receipt cannot override a mismatched server commit SHA", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-disconnect-stale-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, streamLostAfterDeliveryAgent("mismatched"));
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => outputStatus({
        outputKind: "result",
        outputPersisted: true,
        output: { runId: "run-114", kind: "result", commitSha: "a".repeat(40) },
      }).task,
    });

    await executeClaim(config(join(root, "workspaces"), agentBinary), resultOutputClaim(remote), {
      controlPlane: controlPlane.controlPlane,
    });

    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, false);
    assert.equal(completion?.failureClass, "PROTOCOL_ERROR");
    assert.ok(completion?.failureEnvelope);
    assert.notEqual(completion?.pushedBranch, "master");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nonzero exit with persisted output stays FAILED", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-disconnect-nonzero-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, streamLostAfterDeliveryAgent("matching", 1));
    await chmod(agentBinary, 0o755);
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => outputStatus({ outputKind: "result", outputPersisted: true }).task,
    });

    await executeClaim(config(join(root, "workspaces"), agentBinary), resultOutputClaim(remote), {
      controlPlane: controlPlane.controlPlane,
    });

    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, false);
    assert.equal(completion?.failureClass, "TASK_FAILED");
    assert.ok(completion?.failureEnvelope);
    assert.equal(controlPlane.outputStatusReadCount(), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timeout terminationReason with persisted output stays FAILED", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-disconnect-terminated-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, streamLostAfterDeliveryAgent("matching"));
    await chmod(agentBinary, 0o755);
    const adapter = {
      ...adapters.CLAUDE,
      start: async (...args: Parameters<typeof adapters.CLAUDE.start>) => {
        const runtime = await adapters.CLAUDE.start(...args);
        runtime.terminationReason = "timeout: test deadline";
        return runtime;
      },
    };
    const controlPlane = createControlPlaneDouble({
      readSessionTaskOutputStatus: async () => outputStatus({ outputKind: "result", outputPersisted: true }).task,
    });

    await executeClaim(config(join(root, "workspaces"), agentBinary), resultOutputClaim(remote), {
      adapter,
      controlPlane: controlPlane.controlPlane,
    });

    const completion = controlPlane.completions.at(-1);
    assert.equal(completion?.terminalSuccess, false);
    assert.equal(completion?.failureClass, "CANCELLED_OR_TIMED_OUT");
    assert.ok(completion?.failureEnvelope);
    assert.equal(controlPlane.outputStatusReadCount(), 0);
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
