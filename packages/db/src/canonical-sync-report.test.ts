import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalSyncSummary,
  canonicalSyncSummaryLine,
  emptyCanonicalSyncCounters,
  parseCanonicalSyncSummary,
  recordRolePromptUpdate,
  recordStepPromptUpdate,
  type CanonicalSyncCounters,
  type CanonicalSyncReportKeys,
} from "./canonical-sync-report.js";

const keys: CanonicalSyncReportKeys = {
  templateSteps: new Map([
    ["direct", [{ stepIndex: 0 }, { stepIndex: 1 }]],
    ["compound", [{ stepIndex: 0 }]],
  ]),
  roleNames: ["senior-dev", "reviewer"],
};

const empty = (): CanonicalSyncCounters => emptyCanonicalSyncCounters(keys);

test("an empty report names every canonical step and role at zero", () => {
  assert.deepEqual(empty(), {
    templates: 0,
    createdCanonicalTemplates: 0,
    createdAgents: 0,
    createdAgentRepoGrants: 0,
    adoptedAssignees: 0,
    adoptedStepBases: 0,
    adoptedPriorOutputDeclarations: 0,
    adoptedDependencyProvisioning: 0,
    adoptedOptionalSteps: 0,
    renamedSteps: 0,
    migratedTasks: 0,
    adoptedAgentDefaults: 0,
    runtimeDriftNotices: 0,
    updated: 0,
    preservedTaskAssignments: { archived: 0, nonTodo: 0, started: 0, output: 0 },
    updatedSteps: { direct: { "0": 0, "1": 0 }, compound: { "0": 0 } },
    updatedRoles: { "senior-dev": 0, reviewer: 0 },
  });
});

test("a report counter that no canonical source declares is refused", () => {
  assert.throws(() => recordStepPromptUpdate(empty(), "direct", 7, 1), /no counter for direct step 7/u);
  assert.throws(() => recordStepPromptUpdate(empty(), "absent", 0, 1), /no counter for absent step 0/u);
  assert.throws(() => recordRolePromptUpdate(empty(), "absent", 1), /no counter for Agent absent/u);
});

test("updated sums every write and excludes the templates inspected", () => {
  const counters = empty();
  counters.templates = 4;
  counters.createdAgents = 2;
  counters.migratedTasks = 1;
  counters.preservedTaskAssignments.archived = 3;
  recordStepPromptUpdate(counters, "direct", 1, 5);
  recordRolePromptUpdate(counters, "reviewer", 6);

  const summary = canonicalSyncSummary([{ kind: "synced", slug: "one", counters }], keys);
  assert.equal(summary.projects["one"]?.updated, 14);
  assert.equal(summary.projects["one"]?.templates, 4);
  assert.equal(summary.totals.updated, 14);
});

test("totals accumulate every counter across Projects", () => {
  const first = empty();
  first.templates = 2;
  first.adoptedAssignees = 1;
  first.preservedTaskAssignments.started = 1;
  recordStepPromptUpdate(first, "direct", 0, 1);
  recordRolePromptUpdate(first, "senior-dev", 1);

  const second = empty();
  second.templates = 3;
  second.adoptedAssignees = 4;
  second.preservedTaskAssignments.started = 2;
  recordStepPromptUpdate(second, "direct", 0, 2);
  recordStepPromptUpdate(second, "compound", 0, 1);
  recordRolePromptUpdate(second, "senior-dev", 3);

  const summary = canonicalSyncSummary([
    { kind: "synced", slug: "first", counters: first },
    { kind: "synced", slug: "second", counters: second },
  ], keys);

  assert.equal(summary.totals.templates, 5);
  assert.equal(summary.totals.adoptedAssignees, 5);
  assert.equal(summary.totals.preservedTaskAssignments.started, 3);
  assert.deepEqual(summary.totals.updatedSteps, { direct: { "0": 3, "1": 0 }, compound: { "0": 1 } });
  assert.deepEqual(summary.totals.updatedRoles, { "senior-dev": 4, reviewer: 0 });
  assert.equal(summary.totals.updated, 13);
});

test("summing leaves each Project's own counters alone", () => {
  const counters = empty();
  counters.adoptedAssignees = 1;
  recordStepPromptUpdate(counters, "direct", 0, 1);
  const summary = canonicalSyncSummary([{ kind: "synced", slug: "one", counters }], keys);

  assert.equal(counters.updated, 0);
  assert.equal(summary.projects["one"]?.updated, 2);
  assert.equal(summary.totals.updatedSteps["direct"]?.["0"], 1);
  assert.equal(counters.updatedSteps["direct"]?.["0"], 1);
});

test("a refused Project reports its reason and no counters", () => {
  const summary = canonicalSyncSummary([
    { kind: "refused", slug: "broken", reason: "Agent default drifted" },
    { kind: "synced", slug: "healthy", counters: empty() },
  ], keys);

  assert.deepEqual(Object.keys(summary.projects), ["healthy"]);
  assert.deepEqual(summary.refused, { broken: "Agent default drifted" });
  assert.deepEqual(summary.totals, { ...empty(), updated: 0 });
});

test("Projects are reported by slug, not in the order they were synced", () => {
  const summary = canonicalSyncSummary([
    { kind: "synced", slug: "zulu", counters: empty() },
    { kind: "refused", slug: "mike", reason: "no" },
    { kind: "synced", slug: "alpha", counters: empty() },
  ], keys);

  assert.deepEqual(Object.keys(summary.projects), ["alpha", "zulu"]);
  assert.deepEqual(Object.keys(summary.refused), ["mike"]);
});

test("two outcomes for one Project are refused rather than silently collapsed", () => {
  assert.throws(() => canonicalSyncSummary([
    { kind: "synced", slug: "one", counters: empty() },
    { kind: "refused", slug: "one", reason: "no" },
  ], keys), /Project one reported two sync outcomes/u);
});

test("the printed summary survives a round trip through stdout", () => {
  const counters = empty();
  counters.templates = 1;
  recordRolePromptUpdate(counters, "reviewer", 2);
  const summary = canonicalSyncSummary([
    { kind: "synced", slug: "one", counters },
    { kind: "refused", slug: "two", reason: "Agent default drifted" },
  ], keys);

  const stdout = [
    "SYNCED one: {}",
    "REFUSED two: Agent default drifted",
    canonicalSyncSummaryLine(summary),
    "",
  ].join("\n");
  assert.deepEqual(parseCanonicalSyncSummary(stdout), summary);
});

test("output that carries no summary is refused rather than read as empty", () => {
  assert.throws(() => parseCanonicalSyncSummary("   \n  "), /printed no output/u);
  assert.throws(() => parseCanonicalSyncSummary("SYNCED one: {}"), /not JSON/u);
  assert.throws(() => parseCanonicalSyncSummary("[1,2]"), /not an object/u);
  assert.throws(() => parseCanonicalSyncSummary('{"projects":{},"refused":{}}'), /has no totals/u);
});
