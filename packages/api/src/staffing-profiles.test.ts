import assert from "node:assert/strict";
import test from "node:test";

import { AssigneeType, RunnerPreference } from "@anneal/db";

import { canonicalStaffingEntries, staffingAssigneeRefusal } from "./staffing-profiles.js";

const step = (
  stepIndex: number,
  name: string,
  outputKind: string,
  overrides: Partial<Parameters<typeof staffingAssigneeRefusal>[1]> = {},
): Parameters<typeof staffingAssigneeRefusal>[1] => ({
  stepIndex,
  name,
  outputKind,
  optional: false,
  assigneeType: AssigneeType.AGENT,
  assigneeAgentId: "agent-bound",
  runner: null,
  ...overrides,
});

const AGENTS = new Map([["agent-1", {
  id: "agent-1",
  name: "review-coordinator-astra-medium",
  projectId: "project-1",
  archivedAt: null,
  model: "claude-opus-5:medium",
  runnerPreference: RunnerPreference.CLAUDE,
}]]);

const CONTEXT = { projectId: "project-1", templateName: "direct-engineer-workflow" };

const READINESS = step(6, "Merge readiness", "merge-authorization");

test("a control-plane step refuses an agent entry and accepts one that states no opinion", () => {
  const refusal = staffingAssigneeRefusal("agent-1", READINESS, AGENTS, CONTEXT);
  assert.equal(refusal?.code, "staffing_profile_step_control_plane");
  assert.equal(refusal?.outputKind, "merge-authorization");
  // The message names the step an operator has to remove from the profile.
  assert.match(refusal?.message ?? "", /Merge readiness \(merge-authorization\)/u);

  // Null is not an opinion, so the step's own binding stands and nothing is refused.
  assert.equal(staffingAssigneeRefusal(null, READINESS, AGENTS, CONTEXT), null);
  // An ordinary agent step is unaffected.
  assert.equal(
    staffingAssigneeRefusal("agent-1", step(1, "Implementation", "implementation"), AGENTS, CONTEXT),
    null,
  );
});

test("the canonical plan states no assignee for a control-plane step", () => {
  assert.deepEqual(
    canonicalStaffingEntries([step(1, "Implementation", "implementation"), READINESS]),
    [
      { outputKind: "implementation", assigneeAgentId: "agent-bound", include: null },
      { outputKind: "merge-authorization", assigneeAgentId: null, include: null },
    ],
  );
});

test("control-plane ownership takes precedence over HUMAN assignee type", () => {
  const readiness = { ...READINESS, assigneeType: AssigneeType.HUMAN };
  const refusal = staffingAssigneeRefusal("agent-1", readiness, AGENTS, CONTEXT);
  assert.equal(refusal?.code, "staffing_profile_step_control_plane");
  assert.match(refusal?.message ?? "", /Merge readiness.*remove its entry/u);
  assert.equal(staffingAssigneeRefusal(null, readiness, AGENTS, CONTEXT), null);
});
