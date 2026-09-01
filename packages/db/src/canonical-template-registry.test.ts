import assert from "node:assert/strict";
import test from "node:test";

import { PR_TEMPLATE_NAME } from "./agent-contract.js";
import {
  canonicalStepOrdinals,
  canonicalTemplateIdentity,
  CURRENT_CANONICAL_STEP_ORDINALS,
  LEGACY_TEMPLATE_GENERATIONS,
} from "./canonical-template-transition.js";
import {
  planCanonicalInstallation,
  type CanonicalInstallationRow,
  type CanonicalInstallationSources,
} from "./canonical-template-installation.js";
import type { TemplateStepSource } from "./template-sources.js";

test("the pull-request template has current identity and explicit repair ordinals", () => {
  assert.equal(PR_TEMPLATE_NAME, "pr-engineer-workflow");
  assert.deepEqual(canonicalTemplateIdentity(PR_TEMPLATE_NAME), {
    canonicalName: PR_TEMPLATE_NAME,
    generation: null,
  });
  assert.deepEqual(LEGACY_TEMPLATE_GENERATIONS[PR_TEMPLATE_NAME], []);
  assert.deepEqual(CURRENT_CANONICAL_STEP_ORDINALS[PR_TEMPLATE_NAME], {
    implementation: 1,
    "sol-findings": 2,
    "blind-findings": 3,
    "fixed-implementation": 4,
  });
  assert.deepEqual(canonicalStepOrdinals(PR_TEMPLATE_NAME, null), {
    implementation: 1,
    "sol-findings": 2,
    "blind-findings": 3,
    "fixed-implementation": 4,
  });
});

test("a matching no-history pull-request row is current, never a rollover", () => {
  const sourceSteps: TemplateStepSource[] = [
    {
      stepIndex: 1,
      name: "Implementation",
      layer: 1,
      agentName: "senior-dev-luna",
      approvalGate: false,
      outputKind: "implementation",
      attachmentsFromPrevious: false,
      priorOutputKinds: [],
      opensPullRequest: true,
      requiresCommit: true,
      provisionDependencies: true,
      baseFromStepIndex: null,
      spawnPolicy: null,
      prompt: "implementation",
    },
    {
      stepIndex: 2,
      name: "Code review (Sol)",
      layer: 2,
      agentName: "review-coordinator-sol",
      approvalGate: false,
      outputKind: "sol-findings",
      attachmentsFromPrevious: true,
      priorOutputKinds: ["implementation"],
      opensPullRequest: false,
      requiresCommit: false,
      provisionDependencies: false,
      baseFromStepIndex: 1,
      spawnPolicy: null,
      prompt: "sol",
    },
    {
      stepIndex: 3,
      name: "Code review (Opus blind)",
      layer: 2,
      agentName: "review-coordinator-opus",
      approvalGate: false,
      outputKind: "blind-findings",
      attachmentsFromPrevious: false,
      priorOutputKinds: [],
      opensPullRequest: false,
      requiresCommit: false,
      provisionDependencies: false,
      baseFromStepIndex: 1,
      spawnPolicy: null,
      prompt: "blind",
    },
    {
      stepIndex: 4,
      name: "Apply review fixes",
      layer: 3,
      agentName: "senior-dev",
      approvalGate: false,
      outputKind: "fixed-implementation",
      attachmentsFromPrevious: true,
      priorOutputKinds: ["sol-findings", "blind-findings"],
      opensPullRequest: false,
      requiresCommit: false,
      provisionDependencies: true,
      baseFromStepIndex: null,
      spawnPolicy: null,
      prompt: "fixes",
    },
  ];
  const sourceMap = new Map([[PR_TEMPLATE_NAME as never, sourceSteps]]) as unknown as CanonicalInstallationSources;
  const row = {
    id: "template",
    projectId: "project",
    name: PR_TEMPLATE_NAME as never,
    steps: sourceSteps.map((step) => ({
      id: `step-${String(step.stepIndex)}`,
      taskTemplateId: "template",
      stepIndex: step.stepIndex,
      name: step.name,
      assigneeAgent: step.agentName === null ? null : { name: step.agentName },
      assigneeType: step.agentName === null ? "HUMAN" : "AGENT",
      layer: step.layer,
      approvalGate: step.approvalGate,
      outputKind: step.outputKind,
      attachmentsFromPrevious: step.attachmentsFromPrevious,
      priorOutputKinds: step.priorOutputKinds,
      opensPullRequest: step.opensPullRequest,
      requiresCommit: step.requiresCommit,
      provisionDependencies: step.provisionDependencies,
      baseFromStepIndex: step.baseFromStepIndex,
      spawnPolicy: step.spawnPolicy,
      prompt: step.prompt,
    })),
  } as unknown as CanonicalInstallationRow;

  assert.deepEqual(planCanonicalInstallation([row], sourceMap), [{
    kind: "current",
    templateName: PR_TEMPLATE_NAME,
    projectId: "project",
    rowId: "template",
  }]);
});
