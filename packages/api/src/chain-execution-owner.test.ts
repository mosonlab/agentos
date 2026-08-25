import assert from "node:assert/strict";
import test from "node:test";

import { chainExecutionOwner } from "./chain-execution-owner.js";

const step = (stepIndex: number, outputKind: string, name: string) => ({
  stepIndex,
  outputKind,
  taskTemplate: { name },
});

test("chain execution owner exposes real system principals without changing assignees", () => {
  assert.equal(chainExecutionOwner({
    assigneeType: "AGENT",
    templateStep: step(7, "merge-authorization", "direct-engineer-workflow"),
  }), "control-plane");
  assert.equal(chainExecutionOwner({
    assigneeType: "AGENT",
    templateStep: step(13, "merge-result", "compound-engineer-workflow"),
  }), "merge-executor");
  assert.equal(chainExecutionOwner({
    assigneeType: "AGENT",
    templateStep: step(5, "regression-verification", "direct-engineer-workflow"),
  }), "agent");
  assert.equal(chainExecutionOwner({ assigneeType: "HUMAN", templateStep: null }), "human");
});
