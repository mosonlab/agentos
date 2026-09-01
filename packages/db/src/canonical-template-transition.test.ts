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
    outputKind: step.outputKind,
    attachmentsFromPrevious: step.attachmentsFromPrevious,
    priorOutputKinds: step.priorOutputKinds,
    opensPullRequest: step.opensPullRequest,
    requiresCommit: step.requiresCommit,
    baseFromStepIndex: step.baseFromStepIndex,
    spawnPolicy: step.spawnPolicy as PersistedTransitionStep["spawnPolicy"],
    prompt: step.prompt,
  }));

const generationOf = (templateName: CanonicalTemplateRegistryName, marker: string) => {
  const generation = LEGACY_TEMPLATE_GENERATIONS[templateName]?.find((candidate) => candidate.marker === marker);
  assert.ok(generation, `${templateName} must register ${marker}`);
  return generation;
};

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
    priorOutputKinds: [],
    opensPullRequest: true, requiresCommit: true, baseFromStepIndex: null, spawnPolicy: null, prompt,
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

    // Compound remains structure-identical. Direct's later revalidation
    // rollover intentionally changed its shape, but the old prompt generation
    // must still target the current source digest.
    assert.equal(
      legacyGenerationMatches({ marker: generation.marker, shape: generation.shape }, successor),
      templateName === "compound-engineer-workflow",
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
    assert.equal(successorPromptDrift(templateName, "pre-regression-step-split", current), null);

    // The same rollover, with the prompts edited again after registration.
    const driftedSource = current.map((step) => (
      step.stepIndex === current[0]!.stepIndex ? { ...step, prompt: `${step.prompt}\n\nlater edit` } : step
    ));
    const refusal = successorPromptDrift(templateName, "pre-regression-step-split", driftedSource);
    assert.ok(refusal, `${templateName} must refuse an unregistered successor`);
    assert.match(refusal, /registered to install prompt generation/u);

    // The outgoing row is unaffected by that edit and still matches, which is
    // exactly why the successor has to be checked separately.
    const generation = generationOf(templateName, "pre-regression-step-split");
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
      outputKind: step.outputKind,
      attachmentsFromPrevious: step.attachmentsFromPrevious,
      opensPullRequest: step.opensPullRequest,
      requiresCommit: step.outputKind === "plan" || step.outputKind === "implementation",
      baseFromStepIndex: step.baseFromStepIndex,
      spawnPolicy: step.spawnPolicy,
      priorOutputKinds: [],
      prompt: "retired",
    }))),
    "pre-revalidate-step",
  );
  assert.equal(matchedLegacyGeneration("direct-engineer-workflow", asPersisted(current)), null);
});

test("the pull-request workflow has current ordinals without a retired generation", () => {
  assert.deepEqual(LEGACY_TEMPLATE_GENERATIONS[PR_TEMPLATE_NAME], []);
  assert.deepEqual(canonicalStepOrdinals(PR_TEMPLATE_NAME, null), {
    implementation: 1,
    "sol-findings": 2,
    "blind-findings": 3,
    "fixed-implementation": 4,
  });
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

test("every prompt-only generation can roll straight to the current source", async () => {
  const sources = await loadAllTemplateStepSources();
  const markers = {
    "direct-engineer-workflow": [
      "pre-blind-review-retirement",
      "pre-platform-spec-materialization",
      "pre-regression-step-split",
      "pre-internal-npm-scope-rename",
      "pre-product-rename-anneal",
    ],
    "compound-engineer-workflow": [
      "pre-regression-step-split",
      "pre-internal-npm-scope-rename",
      "pre-product-rename-anneal",
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
