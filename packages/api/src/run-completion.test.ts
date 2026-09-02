import assert from "node:assert/strict";
import test from "node:test";

import { completionEvidenceRefusal } from "./run-completion.js";

const baseSha = "5".repeat(40);

const implementationStep = {
  outputKind: "implementation",
  requiresCommit: true,
  taskTemplate: { name: "direct-engineer-workflow" },
};

const continuation = (overrides: Record<string, unknown> = {}) => ({
  id: "run-2",
  runNumber: 2,
  maxRunsPerTask: 2,
  requiresCommit: false,
  opensPullRequest: true,
  baseSha,
  task: { templateStep: implementationStep },
  ...overrides,
});

const implementationOutput = (overrides: Record<string, unknown> = {}) => ({
  runId: "run-2",
  kind: "implementation",
  body: JSON.stringify({
    schemaVersion: 1,
    headSha: baseSha,
    baseSha,
    summary: "The salvaged base already delivers the brief.",
    testsRun: ["focused"],
  }),
  commitSha: baseSha,
  metadata: {},
  ...overrides,
});

test("an unchanged relaxed Run completes SUCCEEDED only with canonical implementation evidence", () => {
  const run = continuation();

  assert.equal(completionEvidenceRefusal(run, true, baseSha, implementationOutput()), null);
  assert.equal(
    completionEvidenceRefusal(run, true, baseSha, null),
    "missing implementation task output for current Run run-2",
  );
});

test("a manual own-publication continuation cannot clean-exit without implementation evidence", () => {
  const run = continuation({ task: { templateStep: null } });

  assert.equal(
    completionEvidenceRefusal(run, true, baseSha, null),
    "missing implementation task output for current Run run-2",
  );
  assert.equal(
    completionEvidenceRefusal(run, true, baseSha, implementationOutput({ kind: "result" })),
    "task output kind result does not match canonical kind implementation",
  );
});

test("a configured non-committing Step keeps its ordinary completion semantics", () => {
  const run = continuation({
    opensPullRequest: false,
    task: {
      templateStep: {
        outputKind: "regression-verification-v2",
        requiresCommit: false,
        taskTemplate: { name: "direct-engineer-workflow" },
      },
    },
  });

  assert.equal(completionEvidenceRefusal(run, true, baseSha, null), null);
});
