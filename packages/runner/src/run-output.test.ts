import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { RUNNER_EXCEPTION_REASON } from "./envelope.js";
import { executeClaim } from "./runner.js";
import { createControlPlaneDouble } from "./test-control-plane.js";

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

const remediatingAgent = (remediationPrompt: string): string => [
  "#!/bin/sh",
  'case "$1" in',
  '  --version) echo "1.2.3-stub"; exit 0 ;;',
  '  --help) echo "--setting-sources"; exit 0 ;;',
  '  auth) echo \'{"loggedIn": true, "authMethod": "stub"}\'; exit 0 ;;',
  "esac",
  'case " $* " in',
  '  *" --resume conversation-114 "*)',
  `    cat > ${JSON.stringify(remediationPrompt)}`,
  '    echo \'{"type":"system","session_id":"conversation-114"}\'',
  '    echo \'{"type":"result","is_error":false,"terminal_reason":"completed","session_id":"conversation-114","result":"task output persisted"}\'',
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
        return {
          outputKind: "implementation",
          outputRequired: true,
          outputRemediationAllowed: true,
          outputPersisted: statusReads >= 2,
        };
      },
    });

    const baseClaim = claim(remote);
    await executeClaim(config(join(root, "workspaces"), agentBinary), {
      ...baseClaim,
      task: {
        ...baseClaim.task,
        templateStep: { name: "Implementation", outputKind: "implementation" },
      },
    }, { controlPlane: controlPlane.controlPlane });

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

    await executeClaim(config(join(root, "workspaces"), agentBinary), claim(remote), { controlPlane: controlPlane.controlPlane });

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
