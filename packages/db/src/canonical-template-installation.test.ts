import assert from "node:assert/strict";
import test from "node:test";

import {
  planCanonicalInstallation,
  type CanonicalInstallationRow,
  type CanonicalInstallationSources,
} from "./canonical-template-installation.js";
import {
  LEGACY_TEMPLATE_GENERATIONS,
  type LegacyTemplateGeneration,
  type PersistedTransitionStep,
} from "./canonical-template-transition.js";
import { loadTemplateStepSources, type TemplateStepSource } from "./template-sources.js";

const asPersisted = (steps: readonly TemplateStepSource[]): PersistedTransitionStep[] => steps.map((step) => ({
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
  baseFromStepIndex: step.baseFromStepIndex,
  spawnPolicy: step.spawnPolicy as PersistedTransitionStep["spawnPolicy"],
  prompt: step.prompt,
}));

const generationAsPersisted = (generation: LegacyTemplateGeneration): PersistedTransitionStep[] => (
  generation.shape.map((step, index) => ({
    id: `legacy-step-${String(index + 1)}`,
    taskTemplateId: "template",
    stepIndex: index + 1,
    name: step.name,
    assigneeAgent: step.agentName === null ? null : { name: step.agentName },
    assigneeType: step.assigneeType,
    layer: step.layer,
    approvalGate: step.approvalGate,
    outputKind: step.outputKind,
    attachmentsFromPrevious: step.attachmentsFromPrevious,
    priorOutputKinds: [],
    opensPullRequest: step.opensPullRequest,
    requiresCommit: step.outputKind === "plan" || step.outputKind === "implementation",
    baseFromStepIndex: step.baseFromStepIndex,
    spawnPolicy: step.spawnPolicy,
    prompt: `retired prompt ${String(index + 1)}`,
  }))
);

const row = (steps: readonly PersistedTransitionStep[]): CanonicalInstallationRow => ({
  id: "template",
  projectId: "project",
  name: "direct-engineer-workflow",
  steps,
});

test("installation planning decides successor drift, half migrations, and spawnPolicy without a database", async () => {
  const loaded = await loadTemplateStepSources("direct-engineer-workflow");
  const sources = (steps: readonly TemplateStepSource[]): CanonicalInstallationSources => new Map([
    ["direct-engineer-workflow", steps],
  ]);
  const generation = LEGACY_TEMPLATE_GENERATIONS["direct-engineer-workflow"]
    .find((candidate) => candidate.marker === "pre-adjudication")!;
  const mutableGeneration = generation as LegacyTemplateGeneration & { successorPromptDigest?: string };
  const originalSuccessorDigest = mutableGeneration.successorPromptDigest;

    const halfMigrated = asPersisted(loaded);
    halfMigrated[0] = { ...halfMigrated[0]!, approvalGate: !halfMigrated[0]!.approvalGate };
    const missingRevalidator = asPersisted(loaded);
    missingRevalidator[0] = { ...missingRevalidator[0]!, assigneeAgent: null };
    const spawnPolicy = { mode: "parallel", limit: 2 };
  const sourceWithSpawnPolicy = loaded.map((step, index) => index === 0 ? { ...step, spawnPolicy } : step);

  try {
    mutableGeneration.successorPromptDigest = "0".repeat(64);
    const cases = [
      {
        name: "registered row whose source is not its pinned successor",
        plan: planCanonicalInstallation([row(generationAsPersisted(generation))], sources(loaded)),
        kind: "refused",
        reason: /registered to install prompt generation/u,
      },
      {
        name: "half-migrated current row",
        plan: planCanonicalInstallation([row(halfMigrated)], sources(loaded)),
        kind: "refused",
        reason: /structural drift: step 1/u,
      },
      {
        name: "current row with a named spawnPolicy",
        plan: planCanonicalInstallation([row(asPersisted(sourceWithSpawnPolicy))], sources(sourceWithSpawnPolicy)),
        kind: "current",
      },
      {
        name: "current row with a temporarily missing revalidator Agent",
        plan: planCanonicalInstallation([row(missingRevalidator)], sources(loaded)),
        kind: "current",
      },
    ] as const;

    for (const candidate of cases) {
      assert.equal(candidate.plan.length, 1, candidate.name);
      const action = candidate.plan[0]!;
      assert.equal(action.kind, candidate.kind, candidate.name);
      if (action.kind === "refused" && "reason" in candidate) assert.match(action.reason, candidate.reason, candidate.name);
    }
  } finally {
    if (originalSuccessorDigest === undefined) delete mutableGeneration.successorPromptDigest;
    else mutableGeneration.successorPromptDigest = originalSuccessorDigest;
  }
});
