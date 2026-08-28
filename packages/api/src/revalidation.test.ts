import assert from "node:assert/strict";
import test from "node:test";

import { TaskStatus } from "@anneal/db";

import {
  deriveBoundImplementationTask,
  SPEC_REVALIDATOR_AGENT_NAME,
  validateRevalidatedBrief,
  type RevalidationTask,
} from "./revalidation.js";

const task = (input: Partial<RevalidationTask> & Pick<RevalidationTask, "id" | "chainIndex" | "chainLayer" | "dispatchAfterTaskId">): RevalidationTask => ({
  id: input.id,
  projectId: input.projectId ?? "project-1",
  chainId: input.chainId === undefined ? "chain-1" : input.chainId,
  chainIndex: input.chainIndex,
  chainLayer: input.chainLayer,
  dispatchAfterTaskId: input.dispatchAfterTaskId,
  description: input.description ?? "description",
  name: input.name ?? input.id,
  status: input.status ?? TaskStatus.TODO,
  assigneeAgentId: input.assigneeAgentId ?? "agent-revalidator",
  templateId: input.templateId ?? "template-1",
  templateStepId: input.templateStepId ?? `step-${input.id}`,
  templateStep: input.templateStep ?? {
    stepIndex: 2,
    outputKind: "other",
    priorOutputKinds: [],
    taskTemplate: { name: "direct-engineer-workflow" },
  },
});

const caller = (overrides: Partial<RevalidationTask> = {}): RevalidationTask & { agentId: string; agentName: string } => ({
  ...task({
    id: "revalidate",
    chainIndex: 0,
    chainLayer: 0,
    dispatchAfterTaskId: "prior",
    templateStep: {
      stepIndex: 1,
      outputKind: "revalidation",
      priorOutputKinds: [],
      taskTemplate: { name: "direct-engineer-workflow" },
    },
    ...overrides,
  }),
  agentId: "agent-revalidator",
  agentName: SPEC_REVALIDATOR_AGENT_NAME,
});

test("derives exactly one downstream same-chain implementation task", () => {
  const implementation = task({
    id: "implementation",
    chainIndex: 1,
    chainLayer: 1,
    dispatchAfterTaskId: null,
    templateStep: {
      stepIndex: 2,
      outputKind: "implementation",
      priorOutputKinds: ["revalidation"],
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  });
  const result = deriveBoundImplementationTask(caller(), [caller(), implementation]);
  assert.equal("message" in result, false);
  if (!("message" in result)) {
    assert.equal(result.id, "implementation");
  }
});

test("rejects a non-revalidator, an unbound task, and ambiguous implementations", () => {
  const implementation = task({
    id: "implementation",
    chainIndex: 1,
    chainLayer: 1,
    dispatchAfterTaskId: null,
    templateStep: {
      stepIndex: 2,
      outputKind: "implementation",
      priorOutputKinds: [],
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  });
  const wrongAgent = deriveBoundImplementationTask({ ...caller(), agentName: "senior-dev" }, [caller(), implementation]);
  assert.ok("message" in wrongAgent);
  if ("message" in wrongAgent) assert.equal(wrongAgent.reason, "forbidden");
  const unbound = deriveBoundImplementationTask(caller({ chainId: null, dispatchAfterTaskId: null }), [implementation]);
  assert.ok("message" in unbound);
  if ("message" in unbound) assert.equal(unbound.reason, "conflict");
  const ambiguous = deriveBoundImplementationTask(caller(), [caller(), implementation, {
    ...implementation,
    id: "implementation-2",
    chainIndex: 2,
    chainLayer: 2,
  }]);
  assert.ok("message" in ambiguous);
  if ("message" in ambiguous) assert.equal(ambiguous.reason, "conflict");
});

test("rejects compound, custom-template, non-revalidation, and cross-template callers", () => {
  const implementation = task({
    id: "implementation",
    chainIndex: 1,
    chainLayer: 1,
    dispatchAfterTaskId: null,
    templateStep: {
      stepIndex: 2,
      outputKind: "implementation",
      priorOutputKinds: ["revalidation"],
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  });
  const cases = [
    caller({ templateStep: { ...caller().templateStep!, taskTemplate: { name: "compound-engineer-workflow" } } }),
    caller({ templateStep: { ...caller().templateStep!, taskTemplate: { name: "custom-workflow" } } }),
    caller({ templateStep: { ...caller().templateStep!, outputKind: "implementation" } }),
  ];
  for (const candidate of cases) {
    const result = deriveBoundImplementationTask(candidate, [candidate, implementation]);
    assert.ok("message" in result);
    if ("message" in result) assert.equal(result.reason, "forbidden");
  }
  const crossTemplate = deriveBoundImplementationTask(caller(), [caller(), { ...implementation, templateId: "other-template" }]);
  assert.ok("message" in crossTemplate);
  if ("message" in crossTemplate) assert.equal(crossTemplate.reason, "conflict");
});

const brief = [
  "Ship a revalidation step without changing product intent.",
  "",
  "Background: taskPatch reads oldHandler today.",
  "",
  "Changes:",
  "1. Update oldHandler in packages/api/src/old-route.ts while preserving cancellation semantics.",
  "2. Keep the task PATCH route fail-closed.",
  "",
  "Out of scope: compound templates.",
  "",
  "Constraints: existing chains stay byte-identical.",
  "",
  "Acceptance: the named regression passes.",
  "",
  "Route: implementation=senior-dev - transaction boundary",
].join("\n");

test("revalidation permits background and descriptive code-reference drift", () => {
  const stored = brief.replace(
    "oldHandler in packages/api/src/old-route.ts",
    "`oldHandler` in `packages/api/src/old-route.ts`",
  );
  const proposed = stored
    .replace("taskPatch reads oldHandler today", "patchBoundImplementationDescription reads newHandler today")
    .replace("`oldHandler` in `packages/api/src/old-route.ts`", "`newHandler` in `packages/api/src/new-route.ts`");
  assert.equal(validateRevalidatedBrief(stored, proposed), null);
});

test("revalidation rejects Changes-item intent mutations hidden in backticks", () => {
  const stored = brief.replace("Update oldHandler", "`Update oldHandler`");
  const proposed = stored.replace("`Update oldHandler`", "`Delete oldHandler`");

  const refusal = validateRevalidatedBrief(stored, proposed);

  assert.deepEqual(refusal, {
    reason: "invalid-request",
    message: "Revalidation cannot change the intent of a Changes item",
  });
});

test("revalidation rejects mutations to every immutable Product Contract bar", () => {
  const attempts = [
    brief.replace("Ship a revalidation step", "Remove the revalidation step"),
    brief.replace("Update oldHandler", "Delete oldHandler"),
    brief.replace("Out of scope: compound templates.", "Out of scope: nothing."),
    brief.replace("Constraints: existing chains stay byte-identical.", "Constraints: compatibility may break."),
    brief.replace("Acceptance: the named regression passes.", "Acceptance: no tests are required."),
    brief.replace("Route: implementation=senior-dev", "Route: implementation=frontend-dev"),
  ];
  for (const proposed of attempts) {
    const refusal = validateRevalidatedBrief(brief, proposed);
    assert.ok(refusal);
    assert.equal(refusal.reason, "invalid-request");
  }
});
