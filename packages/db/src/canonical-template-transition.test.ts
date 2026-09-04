import assert from "node:assert/strict";
import test from "node:test";

import { PR_TEMPLATE_NAME } from "./agent-contract.js";
import {
  canonicalStepOrdinals,
  canonicalTemplateIdentity,
  LEGACY_TEMPLATE_GENERATIONS,
  legacyGenerationMatches,
  legacyTemplateName,
  matchedLegacyGeneration,
  successorPromptDrift,
  templatePromptGenerationDigest,
  templateRolloverBlockerCount,
  type CanonicalTemplateRegistryName,
  type PersistedTransitionStep,
} from "./canonical-template-transition.js";
import { loadAllTemplateStepSources, type TemplateStepSource } from "./template-sources.js";

test("parked and not-yet-started legacy chains may roll over intact", () => {
  assert.equal(templateRolloverBlockerCount([
    { chainId: "parked", activeRunCount: 0 },
    { chainId: "parked", activeRunCount: 0 },
    { chainId: "not-started", activeRunCount: 0 },
  ]), 0);
});

test("active Runs and unfinished work without a chain identity block rollover", () => {
  assert.equal(templateRolloverBlockerCount([
    { chainId: "active", activeRunCount: 1 },
    { chainId: "quiescent", activeRunCount: 0 },
    { chainId: null, activeRunCount: 0 },
  ]), 2);
});

const asPersisted = (steps: readonly TemplateStepSource[]): PersistedTransitionStep[] =>
  steps.map((step) => ({
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

const generationOf = (templateName: CanonicalTemplateRegistryName, marker: string) => {
  const generation = LEGACY_TEMPLATE_GENERATIONS[templateName]?.find((candidate) => candidate.marker === marker);
  assert.ok(generation, `${templateName} must register ${marker}`);
  return generation;
};

const persistedGeneration = (
  generation: ReturnType<typeof generationOf>,
  provisionDependencies: unknown,
): PersistedTransitionStep[] => generation.shape.map((step, index) => ({
  id: `legacy-${String(index + 1)}`,
  taskTemplateId: "template",
  stepIndex: index + 1,
  name: step.name,
  assigneeAgent: step.agentName === null ? null : { name: step.agentName },
  assigneeType: step.assigneeType,
  layer: step.layer,
  approvalGate: step.approvalGate,
  optional: false,
  outputKind: step.outputKind,
  attachmentsFromPrevious: step.attachmentsFromPrevious,
  priorOutputKinds: [],
  opensPullRequest: step.opensPullRequest,
  requiresCommit: step.outputKind === "plan" || step.outputKind === "implementation",
  provisionDependencies,
  baseFromStepIndex: step.baseFromStepIndex,
  spawnPolicy: step.spawnPolicy,
  prompt: "retired",
})) as unknown as PersistedTransitionStep[];

const PROMPT_ROLLOVER_TEMPLATES = ["direct-engineer-workflow", "compound-engineer-workflow"] as const;

test("canonical identity parses current names and every registered generation", () => {
  for (const [canonicalName, generations] of Object.entries(LEGACY_TEMPLATE_GENERATIONS)) {
    assert.deepEqual(canonicalTemplateIdentity(canonicalName), { canonicalName, generation: null });
    for (const generation of generations) {
      assert.deepEqual(
        canonicalTemplateIdentity(legacyTemplateName(canonicalName, generation.marker, "template-row")),
        { canonicalName, generation: generation.marker },
      );
    }
  }
  assert.equal(canonicalTemplateIdentity("compound-engineer-workflow-legacy-pre-zero-gate-"), null);
  assert.equal(canonicalTemplateIdentity("unregistered-workflow"), null);
});

test("registered generations require an explicit true dependency-provisioning value", () => {
  const generation = generationOf("direct-engineer-workflow", "pre-adjudication");
  assert.equal(legacyGenerationMatches(generation, persistedGeneration(generation, true)), true);
  for (const value of [false, undefined, "true"]) {
    assert.equal(
      legacyGenerationMatches(generation, persistedGeneration(generation, value)),
      false,
      `historical field ${String(value)} must not match`,
    );
  }
});

test("every registered compound generation derives its repair Step ordinals", () => {
  for (const generation of LEGACY_TEMPLATE_GENERATIONS["compound-engineer-workflow"]) {
    const ordinals = canonicalStepOrdinals("compound-engineer-workflow", generation.marker);
    assert.ok(ordinals, generation.marker);
    assert.equal(ordinals.documentation, generation.shape.findIndex((step) => step.outputKind === "documentation") + 1);
    assert.equal(
      ordinals.regression,
      generation.shape.findIndex((step) => step.outputKind.startsWith("regression-verification")) + 1,
    );
  }
  assert.deepEqual(
    canonicalStepOrdinals("compound-engineer-workflow", "pre-narrow-regression-lease"),
    { spec: 1, plan: 2, "plan-review": 3, "revised-plan": 4, implementation: 5,
      "sol-findings": 6, "blind-findings": 7, "fixed-implementation": 8,
      documentation: 9, regression: 10, readiness: 11, integrator: 12 },
  );
  for (const marker of ["pre-blind-review-retirement", "pre-regression-step-split"] as const) {
    const ordinals = canonicalStepOrdinals("compound-engineer-workflow", marker);
    assert.equal(ordinals?.documentation, 9, marker);
    assert.equal(ordinals?.regression, 10, marker);
  }
});

test("a prompt generation is decided by step index and text, not by array order", () => {
  const forward = [{ stepIndex: 1, prompt: "one" }, { stepIndex: 2, prompt: "two" }];
  const reversed = [{ stepIndex: 2, prompt: "two" }, { stepIndex: 1, prompt: "one" }];
  assert.equal(templatePromptGenerationDigest(forward), templatePromptGenerationDigest(reversed));

  // Moving a prompt between two steps is a different generation, even though
  // the set of prompt bodies is unchanged.
  const swapped = [{ stepIndex: 1, prompt: "two" }, { stepIndex: 2, prompt: "one" }];
  assert.notEqual(templatePromptGenerationDigest(forward), templatePromptGenerationDigest(swapped));
});

test("a structure-identical generation is decided by its prompt digest alone", () => {
  // The predicate, exercised directly on a synthetic pair: same shape, one
  // registered prompt generation. This is the case a shape can never express.
  const shape = [{
    name: "Implementation",
    agentName: "senior-dev",
    assigneeType: "AGENT",
    approvalGate: false,
    outputKind: "implementation",
    attachmentsFromPrevious: false,
    opensPullRequest: true,
    baseFromStepIndex: null,
    layer: 1,
    spawnPolicy: null,
  }] as const;
  const stepsWith = (prompt: string): PersistedTransitionStep[] => [{
    id: "step-1", taskTemplateId: "template", stepIndex: 1, name: "Implementation",
    assigneeAgent: { name: "senior-dev" }, assigneeType: "AGENT", layer: 1,
    approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false,
    optional: false,
    priorOutputKinds: [],
    opensPullRequest: true, requiresCommit: true, provisionDependencies: true,
    baseFromStepIndex: null, spawnPolicy: null, prompt,
  }];
  const outgoing = stepsWith("the retired instruction");
  const successor = stepsWith("the replacement instruction");
  const generation = {
    marker: "synthetic",
    shape: shape as never,
    promptDigest: templatePromptGenerationDigest(outgoing),
  };

  assert.equal(legacyGenerationMatches(generation, outgoing), true, "the retired generation is recognised");
  assert.equal(
    legacyGenerationMatches(generation, [{ ...outgoing[0]!, requiresCommit: false }]),
    false,
    "a mismatched commit contract is not the registered generation",
  );
  assert.equal(legacyGenerationMatches(generation, successor), false, "its successor is not, so it cannot re-roll");

  // Without a digest the same entry would swallow both, which is the infinite
  // rollover a prompt-only transition used to be unable to avoid.
  assert.equal(legacyGenerationMatches({ marker: "synthetic", shape: shape as never }, successor), true);
});

test("the regression step split is registered as a prompt-only rollover that cannot re-roll", async () => {
  // The upgrade this mechanism was extended for: the deployed graph and the
  // source graph have identical structure, so a graph still referenced by
  // instantiated tasks has to be recognised through its prompts or the deploy
  // stops at canonical sync.
  const sources = await loadAllTemplateStepSources();
  for (const templateName of PROMPT_ROLLOVER_TEMPLATES) {
    const generation = generationOf(templateName, "pre-regression-step-split");
    assert.ok(generation.promptDigest, `${templateName} prompt-only generation must carry a digest`);

    const current = sources.get(templateName);
    assert.ok(current, `${templateName} must load from source`);
    const successor = asPersisted(current);

    // The explicit dependency-provisioning field makes the review rows
    // structurally different from every pre-field generation, so neither
    // current source graph can match the retired shape by fallback.
    assert.equal(
      legacyGenerationMatches({ marker: generation.marker, shape: generation.shape }, successor),
      false,
      `${templateName} rollover shape expectation`,
    );
    // But not the generation, because the prompts moved on.
    assert.notEqual(templatePromptGenerationDigest(successor), generation.promptDigest);
    assert.equal(
      matchedLegacyGeneration(templateName, successor),
      null,
      `${templateName} must not roll its own successor over again`,
    );
  }
});

test("an unregistered prompt edit matches nothing, so sync refuses instead of rolling", async () => {
  // Expressibility, not automation: nothing derives a rollover from drift.
  const sources = await loadAllTemplateStepSources();
  for (const templateName of PROMPT_ROLLOVER_TEMPLATES) {
    const current = sources.get(templateName);
    assert.ok(current);
    const edited = asPersisted(current).map((step) => ({ ...step, prompt: `${step.prompt}\n\nunregistered edit` }));
    assert.equal(matchedLegacyGeneration(templateName, edited), null);
  }
});

test("a rollover refuses a source that is not the successor it was registered to install", async () => {
  // The gap a single digest leaves: the outgoing row still matches, so the
  // rename would fire, but the tree now holds prompts nobody registered. That
  // edit would be installed on the registered transition's authority.
  const sources = await loadAllTemplateStepSources();
  for (const templateName of PROMPT_ROLLOVER_TEMPLATES) {
    const current = sources.get(templateName);
    assert.ok(current);

    // The source as registered: no drift.
    assert.equal(successorPromptDrift(templateName, "pre-runner-provided-regression-tooling", current), null);

    // The same rollover, with the prompts edited again after registration.
    const driftedSource = current.map((step) => (
      step.stepIndex === current[0]!.stepIndex ? { ...step, prompt: `${step.prompt}\n\nlater edit` } : step
    ));
    const refusal = successorPromptDrift(templateName, "pre-runner-provided-regression-tooling", driftedSource);
    assert.ok(refusal, `${templateName} must refuse an unregistered successor`);
    assert.match(refusal, /registered to install prompt generation/u);

    // The outgoing row is unaffected by that edit and still matches, which is
    // exactly why the successor has to be checked separately.
    const generation = generationOf(templateName, "pre-runner-provided-regression-tooling");
    assert.ok(generation.successorPromptDigest);
    assert.notEqual(generation.promptDigest, generation.successorPromptDigest);
  }
});

test("bound direct revalidation is a registered structural rollover", async () => {
  const current = (await loadAllTemplateStepSources()).get("direct-engineer-workflow");
  assert.ok(current);
  const generation = generationOf("direct-engineer-workflow", "pre-revalidate-step");
  assert.equal(generation.shape.length, 7);
  assert.deepEqual(canonicalStepOrdinals("direct-engineer-workflow", null), {
    revalidation: 1,
    implementation: 2,
    "sol-findings": 3,
    "blind-findings": 4,
    "fixed-implementation": 5,
    regression: 6,
    readiness: 7,
    integrator: 8,
  });
  assert.equal(generation.successorStepOrdinals?.implementation, 2);
  assert.equal(
    matchedLegacyGeneration("direct-engineer-workflow", generation.shape.map((step, index) => ({
      id: `legacy-${String(index + 1)}`,
      taskTemplateId: "template",
      stepIndex: index + 1,
      name: step.name,
      assigneeAgent: step.agentName === null ? null : { name: step.agentName },
      assigneeType: step.assigneeType,
      layer: step.layer,
      approvalGate: step.approvalGate,
      optional: false,
      outputKind: step.outputKind,
      attachmentsFromPrevious: step.attachmentsFromPrevious,
      opensPullRequest: step.opensPullRequest,
      requiresCommit: step.outputKind === "plan" || step.outputKind === "implementation",
      provisionDependencies: true,
      baseFromStepIndex: step.baseFromStepIndex,
      spawnPolicy: step.spawnPolicy,
      priorOutputKinds: [],
      prompt: "retired",
    }))),
    "pre-revalidate-step",
  );
  assert.equal(matchedLegacyGeneration("direct-engineer-workflow", asPersisted(current)), null);
});

test("the pull-request workflow has a registered prompt-only generation and current ordinals", async () => {
  const sources = await loadAllTemplateStepSources();
  const current = sources.get(PR_TEMPLATE_NAME);
  assert.ok(current);
  const generation = generationOf(PR_TEMPLATE_NAME, "pre-pr-handover-quality");
  assert.equal(generation.promptDigest, "93a72d354876a6c26020e8638b6c365fb15e4ca4a400a2d6ca80084994f249d6");
  assert.equal(generation.successorPromptDigest, "1c1169bf0586f6bb71f4ed34b3eb6b166828802a9b24c6b07844b2f526b5f8a8");
  assert.equal(generation.shape.length, 4);
  assert.deepEqual(
    generation.shape,
    current.map(({ name, agentName, approvalGate, outputKind, attachmentsFromPrevious, opensPullRequest, baseFromStepIndex, layer, spawnPolicy }) => ({
      name,
      agentName,
      assigneeType: agentName === null ? "HUMAN" : "AGENT",
      approvalGate,
      outputKind,
      attachmentsFromPrevious,
      opensPullRequest,
      baseFromStepIndex,
      layer,
      spawnPolicy,
    })),
  );
  assert.equal(templatePromptGenerationDigest(current), generation.successorPromptDigest);
  assert.equal(matchedLegacyGeneration(PR_TEMPLATE_NAME, asPersisted(current)), null);
  assert.deepEqual(canonicalStepOrdinals(PR_TEMPLATE_NAME, null), {
    implementation: 1,
    "sol-findings": 2,
    "blind-findings": 3,
    "fixed-implementation": 4,
  });
  const reviewedGeneration = generationOf(PR_TEMPLATE_NAME, "pre-pr-head-tree-check");
  assert.equal(reviewedGeneration.promptDigest, "805b9e911be94c84e451cdbf4d1cdb93ab10031c031c6854947f56d306fb1906");
  assert.equal(reviewedGeneration.successorPromptDigest, templatePromptGenerationDigest(current));
  assert.deepEqual(reviewedGeneration.shape, generation.shape);
});

test("the internal npm scope rename is a registered prompt-only rollover", async () => {
  const sources = await loadAllTemplateStepSources();
  const retiredDigests = {
    "compound-engineer-workflow": "79845a3badc75200d30ac22cb4fb10c6efa38308c31156e7b15f4c8475e9f7ff",
  } as const;

  for (const templateName of ["compound-engineer-workflow"] as const) {
    const current = sources.get(templateName);
    assert.ok(current);
    const generation = generationOf(templateName, "pre-internal-npm-scope-rename");
    assert.equal(generation.promptDigest, retiredDigests[templateName]);
    assert.equal(templatePromptGenerationDigest(current), generation.successorPromptDigest);
    assert.notEqual(generation.promptDigest, generation.successorPromptDigest);
    assert.equal(matchedLegacyGeneration(templateName, asPersisted(current)), null);
  }
});

test("the product rename is a registered prompt-only rollover in both templates", async () => {
  const sources = await loadAllTemplateStepSources();
  const retiredDigests = {
    "direct-engineer-workflow": "0aa379a51d722ec9b8b5d91bc6158d9dd9a1f5d380b50695613d5aece9afda46",
    "compound-engineer-workflow": "606f9b5a667781cde3400d114cc7f2ebf00bada6995eee07a7019b63e7dd8424",
  } as const;

  for (const templateName of PROMPT_ROLLOVER_TEMPLATES) {
    const current = sources.get(templateName);
    assert.ok(current);
    const generation = generationOf(templateName, "pre-product-rename-anneal");
    assert.equal(generation.promptDigest, retiredDigests[templateName]);
    assert.equal(templatePromptGenerationDigest(current), generation.successorPromptDigest);
    assert.notEqual(generation.promptDigest, generation.successorPromptDigest);
    // The retired generation carries the current shape, so only the digest
    // tells it apart from the graph that replaced it.
    assert.equal(matchedLegacyGeneration(templateName, asPersisted(current)), null);
  }
});

test("runner-provided Regression tooling is a registered prompt-only rollover in both templates", async () => {
  const sources = await loadAllTemplateStepSources();
  const retiredDigests = {
    "direct-engineer-workflow": "c0ec5acb70b82b85bc3f3aff5840029a303d31e6098b7171a2bef35f105f3371",
    "compound-engineer-workflow": "27d552a220439bc091956173bc5ee12e5e7158b160fb015443a68f2e744e85d8",
  } as const;

  for (const templateName of PROMPT_ROLLOVER_TEMPLATES) {
    const current = sources.get(templateName);
    assert.ok(current);
    const generation = generationOf(templateName, "pre-runner-provided-regression-tooling");
    assert.equal(generation.promptDigest, retiredDigests[templateName]);
    assert.equal(templatePromptGenerationDigest(current), generation.successorPromptDigest);
    assert.notEqual(generation.promptDigest, generation.successorPromptDigest);
    assert.equal(matchedLegacyGeneration(templateName, asPersisted(current)), null);
  }
});

test("optional review omission is a registered prompt-only rollover in both templates", async () => {
  const sources = await loadAllTemplateStepSources();
  const retiredDigests = {
    "direct-engineer-workflow": "e8fdf5533275e85e33b0cf812db9474b00214de2401e4c97bb6eb0732f864df8",
    "compound-engineer-workflow": "c3b3bb4692bda266e5afd81bb6ad258f58bd1eed14240f272338e0f44fa5e97e",
  } as const;

  for (const templateName of PROMPT_ROLLOVER_TEMPLATES) {
    const current = sources.get(templateName);
    assert.ok(current);
    const generation = generationOf(templateName, "pre-optional-review-omission");
    assert.equal(generation.promptDigest, retiredDigests[templateName]);
    assert.equal(templatePromptGenerationDigest(current), generation.successorPromptDigest);
    assert.notEqual(generation.promptDigest, generation.successorPromptDigest);
    // The retired generation is the one runner-provided tooling rolled to.
    assert.equal(generationOf(templateName, "pre-runner-provided-regression-tooling").successorPromptDigest, generation.successorPromptDigest);
    assert.equal(matchedLegacyGeneration(templateName, asPersisted(current)), null);
    // The deployed rows carry the outgoing prompts on the current shape: no
    // optional steps, and the review steps opting out of dependency
    // provisioning as the source does.
    assert.equal(
      legacyGenerationMatches(
        { marker: generation.marker, shape: generation.shape },
        asPersisted(current).map((step) => ({ ...step, optional: false })),
      ),
      true,
    );
  }
});

test("every prompt-only generation can roll straight to the current source", async () => {
  const sources = await loadAllTemplateStepSources();
  const markers = {
    "direct-engineer-workflow": [
      "pre-blind-review-retirement",
      "pre-platform-spec-materialization",
      "pre-regression-step-split",
      "pre-internal-npm-scope-rename",
      "pre-product-rename-anneal",
      "pre-runner-provided-regression-tooling",
      "pre-optional-review-omission",
    ],
    "compound-engineer-workflow": [
      "pre-regression-step-split",
      "pre-internal-npm-scope-rename",
      "pre-product-rename-anneal",
      "pre-runner-provided-regression-tooling",
      "pre-optional-review-omission",
    ],
  } as const;
  for (const templateName of PROMPT_ROLLOVER_TEMPLATES) {
    const current = sources.get(templateName);
    assert.ok(current);
    for (const marker of markers[templateName]) {
      assert.equal(successorPromptDrift(templateName, marker, current), null, `${templateName}:${marker}`);
    }
  }
});

test("a structural generation pins no successor and is unaffected", () => {
  const sources: { stepIndex: number; prompt: string }[] = [{ stepIndex: 1, prompt: "anything" }];
  assert.equal(successorPromptDrift("direct-engineer-workflow", "pre-adjudication", sources), null);
});
