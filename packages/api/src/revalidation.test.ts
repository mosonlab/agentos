import assert from "node:assert/strict";
import test from "node:test";

import { TaskStatus } from "@anneal/db";

import {
  deriveBoundImplementationTask,
  SPEC_REVALIDATOR_AGENT_NAME,
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
  templateStep: input.templateStep ?? { outputKind: "other", priorOutputKinds: [] },
});

const caller = (overrides: Partial<RevalidationTask> = {}): RevalidationTask & { agentId: string; agentName: string } => ({
  ...task({ id: "revalidate", chainIndex: 0, chainLayer: 0, dispatchAfterTaskId: "prior", ...overrides }),
  agentId: "agent-revalidator",
  agentName: SPEC_REVALIDATOR_AGENT_NAME,
});

test("derives exactly one downstream same-chain implementation task", () => {
  const implementation = task({
    id: "implementation",
    chainIndex: 1,
    chainLayer: 1,
    dispatchAfterTaskId: null,
    templateStep: { outputKind: "implementation", priorOutputKinds: ["revalidation"] },
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
    templateStep: { outputKind: "implementation", priorOutputKinds: [] },
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
