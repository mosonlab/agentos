import assert from "node:assert/strict";
import test from "node:test";

import {
  planStaffingProfileCarry,
  staffingOutputKindBase,
  type StaffingProfileCarrySource,
} from "./staffing-profile-carry.js";

const profile = (
  name: string,
  entries: StaffingProfileCarrySource["entries"],
  isDefault = true,
): StaffingProfileCarrySource => ({ name, isDefault, entries });

test("the base kind strips only a -vN output-protocol suffix", () => {
  assert.equal(staffingOutputKindBase("implementation"), "implementation");
  assert.equal(staffingOutputKindBase("implementation-v2"), "implementation");
  assert.equal(staffingOutputKindBase("implementation-v12"), "implementation");
  // Not a protocol version: v0, a bare v, and a non-terminal match stay whole.
  assert.equal(staffingOutputKindBase("implementation-v0"), "implementation-v0");
  assert.equal(staffingOutputKindBase("implementation-v"), "implementation-v");
  assert.equal(staffingOutputKindBase("implementation-v2-notes"), "implementation-v2-notes");
});

test("exact output kinds carry unchanged, with names and default membership", () => {
  const plan = planStaffingProfileCarry(
    [
      profile("Default", [
        { outputKind: "spec", assigneeAgentId: "agent-spec", include: null },
        { outputKind: "implementation", assigneeAgentId: "agent-impl", include: null },
        { outputKind: "blind-findings", assigneeAgentId: null, include: false },
      ]),
      profile("Fast", [{ outputKind: "spec", assigneeAgentId: "agent-other", include: null }], false),
    ],
    ["spec", "implementation", "blind-findings"],
  );

  assert.deepEqual(plan.profiles, [
    {
      name: "Default",
      isDefault: true,
      entries: [
        { outputKind: "spec", assigneeAgentId: "agent-spec", include: null },
        { outputKind: "implementation", assigneeAgentId: "agent-impl", include: null },
        { outputKind: "blind-findings", assigneeAgentId: null, include: false },
      ],
    },
    {
      name: "Fast",
      isDefault: false,
      entries: [{ outputKind: "spec", assigneeAgentId: "agent-other", include: null }],
    },
  ]);
  assert.deepEqual(plan.dropped, []);
  assert.deepEqual(plan.reportLines, []);
});

test("a kind whose protocol version moved is carried by its base kind", () => {
  const plan = planStaffingProfileCarry(
    [profile("Default", [
      { outputKind: "regression-verification", assigneeAgentId: "agent-regression", include: null },
    ])],
    ["regression-verification-v2"],
  );

  assert.deepEqual(plan.profiles[0]!.entries, [
    { outputKind: "regression-verification-v2", assigneeAgentId: "agent-regression", include: null },
  ]);
  assert.deepEqual(plan.dropped, []);
});

test("an exact match keeps its target away from another entry's fallback", () => {
  const plan = planStaffingProfileCarry(
    [profile("Default", [
      { outputKind: "findings-v2", assigneeAgentId: "agent-exact", include: null },
      { outputKind: "findings", assigneeAgentId: "agent-fallback", include: null },
    ])],
    ["findings-v2"],
  );

  assert.deepEqual(plan.profiles[0]!.entries, [
    { outputKind: "findings-v2", assigneeAgentId: "agent-exact", include: null },
  ]);
  assert.deepEqual(plan.dropped, [
    { profileName: "Default", outputKind: "findings", reason: "ambiguous-kind" },
  ]);
});

test("several new steps sharing one base kind refuse to guess", () => {
  const plan = planStaffingProfileCarry(
    [profile("Default", [{ outputKind: "notes", assigneeAgentId: "agent-notes", include: null }])],
    ["notes-v2", "notes-v3"],
  );

  assert.deepEqual(plan.profiles[0]!.entries, []);
  assert.deepEqual(plan.dropped, [
    { profileName: "Default", outputKind: "notes", reason: "ambiguous-kind" },
  ]);
  assert.match(plan.reportLines[0]!, /several steps whose output kind reduces to notes/u);
});

test("an entry the new graph does not produce is dropped and reported", () => {
  const plan = planStaffingProfileCarry(
    [profile("Default", [
      { outputKind: "spec", assigneeAgentId: "agent-spec", include: null },
      { outputKind: "retired-kind", assigneeAgentId: "agent-gone", include: true },
    ])],
    ["spec"],
  );

  assert.deepEqual(plan.profiles[0]!.entries, [
    { outputKind: "spec", assigneeAgentId: "agent-spec", include: null },
  ]);
  assert.deepEqual(plan.dropped, [
    { profileName: "Default", outputKind: "retired-kind", reason: "unknown-kind" },
  ]);
  assert.deepEqual(plan.reportLines, [
    "Staffing profile Default: entry retired-kind dropped; the new graph has no step producing it",
  ]);
});

test("a template with no profiles carries nothing and reports nothing", () => {
  assert.deepEqual(planStaffingProfileCarry([], ["spec"]), {
    profiles: [],
    dropped: [],
    reportLines: [],
  });
});
