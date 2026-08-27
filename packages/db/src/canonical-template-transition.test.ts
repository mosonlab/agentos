import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_TEMPLATE_GENERATIONS,
  legacyGenerationMatches,
  matchedLegacyGeneration,
  successorPromptDrift,
  templatePromptGenerationDigest,
  templateRolloverBlockerCount,
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
    name: step.outputKind,
    assigneeAgent: step.agentName === null ? null : { name: step.agentName },
    assigneeType: step.agentName === null ? "HUMAN" : "AGENT",
    layer: step.layer,
    approvalGate: step.approvalGate,
    outputKind: step.outputKind,
    attachmentsFromPrevious: step.attachmentsFromPrevious,
    priorOutputKinds: step.priorOutputKinds,
    opensPullRequest: step.opensPullRequest,
    baseFromStepIndex: step.baseFromStepIndex,
    spawnPolicy: step.spawnPolicy as PersistedTransitionStep["spawnPolicy"],
    prompt: step.prompt,
  }));

const generationOf = (templateName: string, marker: string) => {
  const generation = LEGACY_TEMPLATE_GENERATIONS[templateName]?.find((candidate) => candidate.marker === marker);
  assert.ok(generation, `${templateName} must register ${marker}`);
  return generation;
};

const PROMPT_ROLLOVER_TEMPLATES = ["direct-engineer-workflow", "compound-engineer-workflow"] as const;

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
  const shape = [["senior-dev", "AGENT", false, "implementation", false, true, null, 1]] as const;
  const stepsWith = (prompt: string): PersistedTransitionStep[] => [{
    id: "step-1", taskTemplateId: "template", stepIndex: 1, name: "implementation",
    assigneeAgent: { name: "senior-dev" }, assigneeType: "AGENT", layer: 1,
    approvalGate: false, outputKind: "implementation", attachmentsFromPrevious: false,
    priorOutputKinds: [],
    opensPullRequest: true, baseFromStepIndex: null, spawnPolicy: null, prompt,
  }];
  const outgoing = stepsWith("the retired instruction");
  const successor = stepsWith("the replacement instruction");
  const generation = {
    marker: "synthetic",
    shape: shape as never,
    promptDigest: templatePromptGenerationDigest(outgoing),
  };

  assert.equal(legacyGenerationMatches(generation, outgoing), true, "the retired generation is recognised");
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

    // Registered as structure-identical: the successor still matches the shape.
    assert.equal(
      legacyGenerationMatches({ marker: generation.marker, shape: generation.shape }, successor),
      true,
      `${templateName} rollover must be structure-identical`,
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

test("a structural generation pins no successor and is unaffected", () => {
  const sources: { stepIndex: number; prompt: string }[] = [{ stepIndex: 1, prompt: "anything" }];
  assert.equal(successorPromptDrift("direct-engineer-workflow", "pre-adjudication", sources), null);
});
