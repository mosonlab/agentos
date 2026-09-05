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
import {
  loadAllTemplateStepSources,
  loadTemplateStepSources,
  type CanonicalTemplateName,
  type TemplateStepSource,
} from "./template-sources.js";

const asPersisted = (steps: readonly TemplateStepSource[]): PersistedTransitionStep[] => steps.map((step) => ({
  id: `step-${String(step.stepIndex)}`,
  taskTemplateId: "template",
  stepIndex: step.stepIndex,
  name: step.name,
  assigneeAgent: step.agentName === null ? null : { name: step.agentName },
  assigneeType: step.agentName === null ? "HUMAN" : "AGENT",
  layer: step.layer,
  approvalGate: step.approvalGate,
  optional: step.optional,
  outputKind: step.outputKind,
  attachmentsFromPrevious: step.attachmentsFromPrevious,
  priorOutputKinds: step.priorOutputKinds,
  opensPullRequest: step.opensPullRequest,
  requiresCommit: step.requiresCommit,
  provisionDependencies: step.provisionDependencies,
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
    // A retired shape states no binding; whatever staffed the row, the
    // fingerprint does not read it.
    assigneeAgent: step.assigneeType === "AGENT" ? { name: "some-staffed-agent" } : null,
    assigneeType: step.assigneeType,
    layer: step.layer,
    approvalGate: step.approvalGate,
    optional: false,
    outputKind: step.outputKind,
    attachmentsFromPrevious: step.attachmentsFromPrevious,
    priorOutputKinds: [],
    opensPullRequest: step.opensPullRequest,
    requiresCommit: step.outputKind === "plan" || step.outputKind === "implementation",
    provisionDependencies: true,
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

test("installation planning decides source generation drift, half migrations, and spawnPolicy without a database", async () => {
  const loaded = await loadTemplateStepSources("direct-engineer-workflow");
  const sources = (steps: readonly TemplateStepSource[]): CanonicalInstallationSources => new Map([
    ["direct-engineer-workflow", steps],
  ]);
  const generation = LEGACY_TEMPLATE_GENERATIONS["direct-engineer-workflow"]
    .find((candidate) => candidate.marker === "pre-adjudication")!;

  const halfMigrated = asPersisted(loaded);
  halfMigrated[0] = { ...halfMigrated[0]!, approvalGate: !halfMigrated[0]!.approvalGate };
  const missingRevalidator = asPersisted(loaded);
  missingRevalidator[0] = { ...missingRevalidator[0]!, assigneeAgent: null };
  const restaffed = asPersisted(loaded);
  restaffed[1] = { ...restaffed[1]!, assigneeAgent: { name: "some-other-agent" } };
  const spawnPolicy = { mode: "parallel", limit: 2 };
  const sourceWithSpawnPolicy = loaded.map((step, index) => index === 0 ? { ...step, spawnPolicy } : step);
  // Prompts edited after the rollover was registered: the retired row still
  // matches, so only the pinned source generation can refuse this.
  const editedSource = loaded.map((step, index) => (
    index === 0 ? { ...step, prompt: `${step.prompt}\n\nunregistered edit` } : step
  ));

  const cases = [
    {
      name: "registered row whose source is not the pinned generation",
      plan: planCanonicalInstallation([row(generationAsPersisted(generation))], sources(editedSource)),
      kind: "refused",
      reason: /registered to install prompt generation/u,
    },
    {
      name: "registered row whose source is the pinned generation",
      plan: planCanonicalInstallation([row(generationAsPersisted(generation))], sources(loaded)),
      kind: "rollover",
    },
    {
      name: "half-migrated current row",
      plan: planCanonicalInstallation([row(halfMigrated)], sources(loaded)),
      kind: "refused",
      reason: /Template direct-engineer-workflow \(template\), direct-engineer-workflow step 1 \(step-1\) differs from the canonical source in approvalGate/u,
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
    {
      // The binding is the canonical default, and sync adopts it at every
      // step, so a row staffed with another Agent is current, not drift.
      name: "current row staffed away from its canonical default",
      plan: planCanonicalInstallation([row(restaffed)], sources(loaded)),
      kind: "current",
    },
  ] as const;

  for (const candidate of cases) {
    assert.equal(candidate.plan.length, 1, candidate.name);
    const action = candidate.plan[0]!;
    assert.equal(action.kind, candidate.kind, candidate.name);
    if (action.kind === "refused" && "reason" in candidate) assert.match(action.reason, candidate.reason, candidate.name);
  }
});

test("a deployed current graph is installed as current, never planned for rollover", async () => {
  // The installer matches retired generations before it checks the current
  // graph, so an entry that still matched the deployed graph would plan a
  // rollover on every sync -- and refuse the deploy outright as soon as one
  // task on that template had an active Run.
  const sources = await loadAllTemplateStepSources();
  for (const [templateName, steps] of sources) {
    const deployed: CanonicalInstallationRow = {
      id: `${templateName}-row`,
      projectId: "project",
      name: templateName as CanonicalTemplateName,
      steps: asPersisted(steps),
    };
    assert.deepEqual(planCanonicalInstallation([deployed], new Map([[templateName, steps]])), [{
      kind: "current",
      templateName,
      projectId: "project",
      rowId: deployed.id,
    }], templateName);
  }
});

test("current installation adopts review provisioning and the optional-step additive default", async () => {
  const sources = await loadTemplateStepSources("direct-engineer-workflow");
  const sourceMap: CanonicalInstallationSources = new Map([
    ["direct-engineer-workflow", sources],
  ]);
  const allTrue = asPersisted(sources).map((step) => ({ ...step, provisionDependencies: true }));
  assert.deepEqual(planCanonicalInstallation([row(allTrue)], sourceMap), [{
    kind: "current",
    templateName: "direct-engineer-workflow",
    projectId: "project",
    rowId: "template",
  }]);

  const migrationDefaults = allTrue.map((step) => ({ ...step, optional: false }));
  assert.deepEqual(planCanonicalInstallation([row(migrationDefaults)], sourceMap), [{
    kind: "current",
    templateName: "direct-engineer-workflow",
    projectId: "project",
    rowId: "template",
  }]);

  const requiredStepOptional = allTrue.map((step) => step.stepIndex === 3
    ? { ...step, optional: true }
    : step);
  const optionalRefusal = planCanonicalInstallation([row(requiredStepOptional)], sourceMap);
  assert.equal(optionalRefusal[0]?.kind, "refused");
  assert.match(optionalRefusal[0]?.kind === "refused" ? optionalRefusal[0].reason : "", /optional/u);

  const nonReviewFalse = allTrue.map((step) => step.stepIndex === 2
    ? { ...step, provisionDependencies: false }
    : step);
  const refused = planCanonicalInstallation([row(nonReviewFalse)], sourceMap);
  assert.equal(refused[0]?.kind, "refused");
  assert.match(
    refused[0]?.kind === "refused" ? refused[0].reason : "",
    /provisionDependencies/u,
  );

  const missingReviewValue = allTrue.map((step) => step.stepIndex === 3
    ? ({ ...step, provisionDependencies: undefined } as unknown as PersistedTransitionStep)
    : step);
  const missing = planCanonicalInstallation([row(missingReviewValue)], sourceMap);
  assert.equal(missing[0]?.kind, "refused");
  assert.match(
    missing[0]?.kind === "refused" ? missing[0].reason : "",
    /provisionDependencies/u,
  );
});

test("first installation is refused when the source tree is not the pinned generation", async () => {
  const loaded = await loadTemplateStepSources("direct-engineer-workflow");
  const editedSource = loaded.map((step, index) => (
    index === 0 ? { ...step, prompt: `${step.prompt}\n\nunregistered edit` } : step
  ));
  const sources = (steps: readonly TemplateStepSource[]): CanonicalInstallationSources => new Map([
    ["direct-engineer-workflow", steps],
  ]);

  assert.deepEqual(planCanonicalInstallation([], sources(loaded), ["project"]), [{
    kind: "create",
    templateName: "direct-engineer-workflow",
    projectId: "project",
  }]);

  const refusal = planCanonicalInstallation([], sources(editedSource), ["project"]);
  assert.equal(refusal.length, 1);
  assert.equal(refusal[0]?.kind, "refused");
  assert.equal(refusal[0]?.kind === "refused" ? refusal[0].rowId : "unset", null);
  assert.match(
    refusal[0]?.kind === "refused" ? refusal[0].reason : "",
    /registered to install prompt generation/u,
  );
});
