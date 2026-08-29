import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  assertSanitized,
  parseArguments,
  runReset,
  runSetup,
  validateAuthority,
  verifyEvidence,
} from "./templates-release-demo.mjs";

const withEvidence = async (config, operation) => {
  const evidenceDir = mkdtempSync(join(tmpdir(), "agentos-templates-evidence-"));
  writeFileSync(join(evidenceDir, "preflight.json"), `${JSON.stringify({ ...config, evidenceDir }, null, 2)}\n`);
  try {
    return await operation(evidenceDir);
  } finally {
    rmSync(evidenceDir, { recursive: true, force: true });
  }
};

test("the CLI parser is strict and help is executable", () => {
  assert.deepEqual(parseArguments(["setup", "--run-id", "oss-c0-demo-001"]), {
    command: "setup",
    options: { "run-id": "oss-c0-demo-001" },
  });
  assert.deepEqual(parseArguments(["preflight", "--help"]), { command: "help", options: {} });
  assert.throws(() => parseArguments(["setup", "--run-id"]), /requires a value/);
  assert.throws(() => parseArguments(["unknown"]), /unknown command/);
  const help = spawnSync(process.execPath, ["scripts/templates-release-demo.mjs", "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /preflight/);
  assert.match(help.stdout, /setup\|instantiate\|capture\|verify/);
});

test("authority artifacts are approved, commit-bound, scoped, and attributed", () => {
  const commit = "a".repeat(40);
  const approved = {
    status: "approved",
    agentosCommit: commit,
    approver: "the operator",
    approvedAt: "2026-08-19T12:00:00.000Z",
    scopes: { providerPath: true },
  };
  assert.equal(validateAuthority(approved, commit, "providerPath").approver, "the operator");
  assert.throws(() => validateAuthority({ ...approved, status: "pending" }, commit, "providerPath"), /not approved/);
  assert.throws(() => validateAuthority({ ...approved, agentosCommit: "b".repeat(40) }, commit, "providerPath"), /another Anneal commit/);
  assert.throws(() => validateAuthority({ ...approved, scopes: {} }, commit, "providerPath"), /does not approve/);
});

test("evidence rejects secret keys and credential-shaped values", () => {
  assert.doesNotThrow(() => assertSanitized({ runId: "oss-c0-demo-001", digest: "a".repeat(64) }));
  assert.throws(() => assertSanitized({ authorization: "redacted" }), /forbidden key/);
  assert.throws(() => assertSanitized({ body: `ghp_${"A".repeat(24)}` }), /credential-shaped/);
});

test("setup converges on the canonical twelve-step topology and grants every agent step", async () => {
  const steps = Array.from({ length: 12 }, (_, offset) => ({
    id: `step-${offset + 1}`,
    stepIndex: offset + 1,
    assigneeType: "AGENT",
    assigneeAgentId: `agent-${offset + 1}`,
    assigneeAgent: {
      id: `agent-${offset + 1}`,
      name: offset === 10 ? "review-coordinator" : offset === 11 ? "merge-integrator" : `agent-${offset + 1}`,
      archivedAt: null,
    },
    outputKind: offset === 10 ? "merge-authorization" : offset === 11 ? "merge-result" : `kind-${offset + 1}`,
    approvalGate: false,
    opensPullRequest: offset !== 11,
  }));
  const calls = [];
  const request = async (_config, method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/projects") return [{ id: "project-1", slug: "agentos-example", name: "Old name" }];
    if (path === "/projects/project-1" && method === "PATCH") return { id: "project-1", slug: "agentos-example", name: "Templates Demo Project" };
    if (path.endsWith("/task-templates")) return [{ id: "template-1", name: "compound-engineer-workflow", steps }];
    if (path.endsWith("/repos") && method === "GET") return [];
    if (path.endsWith("/repos") && method === "POST") return { id: "repo-1", name: "oss-c0-demo-001", defaultBranch: "main" };
    if (path.endsWith("/access")) return { ok: true };
    throw new Error(`unexpected request ${method} ${path}`);
  };
  await withEvidence({
    runId: "oss-c0-demo-001",
    schema: "oss_c0_templates_demo_001",
    mode: "rehearsal",
    targetRemote: "file:///tmp/demo.git",
    targetDefaultBranch: "main",
    targetMountPath: "/workspace/templates-demo",
  }, async (evidenceDir) => {
    const result = await runSetup(
      { "run-id": "oss-c0-demo-001", "evidence-dir": evidenceDir },
      request,
      () => ({ argv: ["npm", "run", "db:verify-agent-template"], exitCode: 0, stdoutSha256: "a".repeat(64), stderrSha256: "b".repeat(64) }),
    );
    assert.equal(result.steps.length, 12);
    assert.equal(result.steps[10].agentName, "review-coordinator");
    assert.equal(result.steps[11].agentName, "merge-integrator");
    assert.equal(result.steps[11].opensPullRequest, false);
    assert.equal(calls.filter((call) => call.path.endsWith("/access")).length, 12);
  });
});

const completeEvidence = (mode = "rehearsal") => {
  const steps = Array.from({ length: 12 }, (_, offset) => ({
    stepIndex: offset + 1,
    outputKind: offset === 10 ? "merge-authorization" : offset === 11 ? "merge-result" : `kind-${offset + 1}`,
  }));
  const tasks = steps.map((step, offset) => ({
    id: `task-${step.stepIndex}`,
    chainIndex: step.stepIndex,
    status: "DONE",
    assigneeType: "AGENT",
    agentName: offset === 10 ? "review-coordinator" : offset === 11 ? "merge-integrator" : `agent-${offset + 1}`,
    templateStep: { outputKind: step.outputKind, opensPullRequest: offset !== 11 },
    output: { kind: step.outputKind, bytes: 1, sha256: "a".repeat(64) },
    activity: { count: 1, digest: "b".repeat(64) },
    runs: offset === 4 ? [{
      pullRequestUrl: "https://github.com/example/demo/pull/1",
      deliveryInstructions: false,
    }] : [],
  }));
  return {
    config: { runId: "oss-c0-demo-001", mode, branch: "agentos/oss-c0-demo-001" },
    setup: { runId: "oss-c0-demo-001", steps },
    instantiated: { runId: "oss-c0-demo-001", chainId: "chain-1", branchName: "agentos/oss-c0-demo-001" },
    capture: { runId: "oss-c0-demo-001", chainId: "chain-1", tasks },
  };
};

test("verification proves positions 1-12 and distinguishes rehearsal from public proof", () => {
  const rehearsal = completeEvidence();
  assert.equal(verifyEvidence(rehearsal.config, rehearsal.setup, rehearsal.instantiated, rehearsal.capture).verdict, "REHEARSAL_ONLY");
  const published = completeEvidence("public");
  assert.equal(verifyEvidence(published.config, published.setup, published.instantiated, published.capture).verdict, "PASS");

  const reordered = completeEvidence();
  reordered.capture.tasks[4].chainIndex = 9;
  assert.throws(() => verifyEvidence(reordered.config, reordered.setup, reordered.instantiated, reordered.capture), /missing or reordered/);
  const missing = completeEvidence();
  missing.capture.tasks[6].output = null;
  assert.throws(() => verifyEvidence(missing.config, missing.setup, missing.instantiated, missing.capture), /output is missing/);
  const manual = completeEvidence("public");
  manual.capture.tasks[4].runs[0].deliveryInstructions = true;
  assert.throws(() => verifyEvidence(manual.config, manual.setup, manual.instantiated, manual.capture), /automatic pull request/);
});

test("reset is rehearsal-only, exact-run confirmed, and deletes only the recorded project", async () => {
  await withEvidence({ runId: "oss-c0-demo-001", schema: "oss_c0_templates_demo_001", mode: "rehearsal" }, async (evidenceDir) => {
    writeFileSync(join(evidenceDir, "setup.json"), JSON.stringify({ project: { id: "project-1" } }));
    const calls = [];
    const request = async (_config, method, path) => {
      calls.push({ method, path });
      return method === "GET" ? [] : null;
    };
    await assert.rejects(
      () => runReset({ "run-id": "oss-c0-demo-001", "confirm-run-id": "oss-c0-demo-002", "evidence-dir": evidenceDir }, request),
      /confirmation does not match/,
    );
    const result = await runReset({
      "run-id": "oss-c0-demo-001",
      "confirm-run-id": "oss-c0-demo-001",
      "evidence-dir": evidenceDir,
    }, request);
    assert.equal(result.projectId, "project-1");
    assert.deepEqual(calls, [
      { method: "GET", path: "/tasks?projectId=project-1" },
      { method: "DELETE", path: "/projects/project-1" },
    ]);
  });
});
