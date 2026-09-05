import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalStepAdoptions,
  canonicalStepDrift,
  type CanonicalStepAdoption,
} from "./canonical-step-adoption.js";
import {
  LEGACY_ALL_PRIOR_OUTPUTS,
  loadAllTemplateStepSources,
  type CanonicalTemplateName,
  type PersistedTemplateStepStructure,
  type TemplateStepSource,
} from "./template-sources.js";

const sources = await loadAllTemplateStepSources();

const sourceStep = (templateName: CanonicalTemplateName, stepIndex: number): TemplateStepSource => {
  const step = sources.get(templateName)!.find((candidate) => candidate.stepIndex === stepIndex);
  assert.ok(step, `${templateName} must declare step ${stepIndex}`);
  return step;
};

/** A persisted row that matches its source exactly; each case drifts one column. */
const asPersisted = (source: TemplateStepSource): PersistedTemplateStepStructure => ({
  name: source.name,
  assigneeAgent: source.agentName === null ? null : { name: source.agentName },
  assigneeType: source.agentName === null ? "HUMAN" : "AGENT",
  layer: source.layer,
  approvalGate: source.approvalGate,
  optional: source.optional,
  outputKind: source.outputKind,
  attachmentsFromPrevious: source.attachmentsFromPrevious,
  priorOutputKinds: source.priorOutputKinds,
  opensPullRequest: source.opensPullRequest,
  requiresCommit: source.requiresCommit,
  provisionDependencies: source.provisionDependencies,
  baseFromStepIndex: source.baseFromStepIndex,
  spawnPolicy: source.spawnPolicy as PersistedTemplateStepStructure["spawnPolicy"],
});

const onlyAdoption = (
  templateName: CanonicalTemplateName,
  actual: PersistedTemplateStepStructure,
  source: TemplateStepSource,
): CanonicalStepAdoption => {
  const adoptions = canonicalStepAdoptions(templateName, actual, source);
  assert.equal(adoptions.length, 1, `expected exactly one adoption, found ${adoptions.map(({ difference }) => difference).join(", ")}`);
  assert.deepEqual(canonicalStepDrift(templateName, actual, source, "adopt"), []);
  return adoptions[0]!;
};

const refuses = (
  templateName: CanonicalTemplateName,
  actual: PersistedTemplateStepStructure,
  source: TemplateStepSource,
  difference: string,
): void => {
  assert.deepEqual(canonicalStepAdoptions(templateName, actual, source), []);
  assert.deepEqual(canonicalStepDrift(templateName, actual, source, "adopt"), [difference]);
};

test("a step that matches its source offers no adoption and no drift", () => {
  for (const [templateName, steps] of sources) {
    for (const source of steps) {
      assert.deepEqual(canonicalStepAdoptions(templateName, asPersisted(source), source), [], `${templateName}:${source.stepIndex}`);
      assert.deepEqual(canonicalStepDrift(templateName, asPersisted(source), source, "adopt"), [], `${templateName}:${source.stepIndex}`);
      assert.deepEqual(canonicalStepDrift(templateName, asPersisted(source), source, "refuse-all"), [], `${templateName}:${source.stepIndex}`);
    }
  }
});

test("every step adopts the Agent its source binds, whoever it binds now", () => {
  // Staffing a chain differently is a staffing profile, applied to the Task;
  // the template row always states the canonical default. So this is not a
  // roster of retired roles at named steps: any binding, and an unbound row,
  // adopts the source binding at every canonical step.
  for (const [templateName, steps] of sources) {
    for (const source of steps) {
      if (source.agentName === null) continue;
      for (const bound of [{ name: "some-other-agent" }, { name: "renamed", canonicalRole: "some-other-agent" }, null]) {
        const actual = { ...asPersisted(source), assigneeAgent: bound };
        assert.deepEqual(onlyAdoption(templateName, actual, source), {
          difference: "agent",
          counter: "adoptedAssignees",
          // A Task instantiated from this step keeps the assignee it was
          // created with, so moving the template row does not mutate work in
          // flight and a referenced step is not refused.
          refusesReferencedStep: false,
          write: { kind: "bind-agent", agentName: source.agentName },
        }, `${templateName}:${source.stepIndex}`);
      }
    }
  }
});

test("the Agent is identified by canonical role, not by its editable name", () => {
  const source = sourceStep("direct-engineer-workflow", 1);
  assert.notEqual(source.agentName, null);
  // An operator-renamed Agent still binds the canonical role, so there is
  // nothing to adopt and nothing to refuse.
  const renamed = {
    ...asPersisted(source),
    assigneeAgent: { name: "operator's own label", canonicalRole: source.agentName! },
  };
  assert.deepEqual(canonicalStepAdoptions("direct-engineer-workflow", renamed, source), []);
  assert.deepEqual(canonicalStepDrift("direct-engineer-workflow", renamed, source, "adopt"), []);
  assert.deepEqual(canonicalStepDrift("direct-engineer-workflow", renamed, source, "refuse-all"), []);
});

test("the merge authorization steps adopt their canonical name from the retired one", () => {
  for (const [templateName, stepIndex] of [
    ["compound-engineer-workflow", 11],
    ["direct-engineer-workflow", 7],
  ] as const) {
    const source = sourceStep(templateName, stepIndex);
    assert.equal(source.name, "Merge authorization");
    assert.deepEqual(onlyAdoption(templateName, { ...asPersisted(source), name: "Merge readiness" }, source), {
      difference: "name",
      counter: "renamedSteps",
      refusesReferencedStep: true,
      write: { kind: "set-columns", data: { name: "Merge authorization" } },
    });
    refuses(templateName, { ...asPersisted(source), name: "Some other name" }, source, "name");
  }
});

test("a Merge readiness name on any other step is drift, not a rename adoption", () => {
  const source = sourceStep("direct-engineer-workflow", 5);
  refuses("direct-engineer-workflow", { ...asPersisted(source), name: "Merge readiness" }, source, "name");
});

test("the fix steps adopt their canonical step base from an absent one", () => {
  for (const [templateName, stepIndex, base] of [
    ["compound-engineer-workflow", 6, 5],
    ["direct-engineer-workflow", 3, 2],
  ] as const) {
    const source = sourceStep(templateName, stepIndex);
    assert.equal(source.baseFromStepIndex, base);
    assert.deepEqual(onlyAdoption(templateName, { ...asPersisted(source), baseFromStepIndex: null }, source), {
      difference: "baseFromStepIndex",
      counter: "adoptedStepBases",
      refusesReferencedStep: true,
      write: { kind: "set-columns", data: { baseFromStepIndex: base } },
    });
    refuses(templateName, { ...asPersisted(source), baseFromStepIndex: 1 }, source, "baseFromStepIndex");
  }
});

test("an absent step base on any other step is drift, not a base adoption", () => {
  const source = sourceStep("compound-engineer-workflow", 7);
  assert.notEqual(source.baseFromStepIndex, null);
  refuses("compound-engineer-workflow", { ...asPersisted(source), baseFromStepIndex: null }, source, "baseFromStepIndex");
});

test("every canonical review step adopts the canonical absence of dependency provisioning", () => {
  const reviewSteps = [
    ["compound-engineer-workflow", 6], ["compound-engineer-workflow", 7],
    ["direct-engineer-workflow", 3], ["direct-engineer-workflow", 4],
    ["pr-engineer-workflow", 2], ["pr-engineer-workflow", 3],
  ] as const;
  for (const [templateName, stepIndex] of reviewSteps) {
    const source = sourceStep(templateName, stepIndex);
    assert.equal(source.provisionDependencies, false);
    assert.deepEqual(onlyAdoption(templateName, { ...asPersisted(source), provisionDependencies: true }, source), {
      difference: "provisionDependencies",
      counter: "adoptedDependencyProvisioning",
      refusesReferencedStep: false,
      write: { kind: "set-columns", data: { provisionDependencies: false } },
    });
  }

  const reviewIdentities = new Set(reviewSteps.map(([templateName, stepIndex]) => `${templateName}:${stepIndex}`));
  for (const [templateName, steps] of sources) {
    for (const source of steps) {
      if (reviewIdentities.has(`${templateName}:${source.stepIndex}`)) continue;
      assert.equal(source.provisionDependencies, true, `${templateName}:${source.stepIndex}`);
      refuses(templateName, { ...asPersisted(source), provisionDependencies: false }, source, "provisionDependencies");
    }
  }
});

test("the two canonical blind reviews adopt the optional flag from the additive default", () => {
  for (const [templateName, stepIndex] of [
    ["compound-engineer-workflow", 7],
    ["direct-engineer-workflow", 4],
  ] as const) {
    const source = sourceStep(templateName, stepIndex);
    assert.equal(source.optional, true);
    assert.deepEqual(onlyAdoption(templateName, { ...asPersisted(source), optional: false }, source), {
      difference: "optional",
      counter: "adoptedOptionalSteps",
      refusesReferencedStep: false,
      write: { kind: "set-columns", data: { optional: true } },
    });
  }

  const required = sourceStep("pr-engineer-workflow", 3);
  assert.equal(required.optional, false);
  refuses("pr-engineer-workflow", { ...asPersisted(required), optional: true }, required, "optional");
});

test("the retired all-output handoff marker is adopted wherever it survives", () => {
  for (const [templateName, steps] of sources) {
    for (const source of steps) {
      const actual = { ...asPersisted(source), priorOutputKinds: [LEGACY_ALL_PRIOR_OUTPUTS] };
      assert.deepEqual(onlyAdoption(templateName, actual, source), {
        difference: "priorOutputKinds",
        counter: "adoptedPriorOutputDeclarations",
        refusesReferencedStep: false,
        write: { kind: "set-columns", data: { priorOutputKinds: source.priorOutputKinds } },
      });
      refuses(templateName, { ...asPersisted(source), priorOutputKinds: ["drifted-output"] }, source, "priorOutputKinds");
    }
  }
});

test("refuse-all reports the differences adopt forgives, and offers nothing to write", () => {
  const source = sourceStep("direct-engineer-workflow", 3);
  const actual = {
    ...asPersisted(source),
    provisionDependencies: true,
    baseFromStepIndex: null,
    priorOutputKinds: [LEGACY_ALL_PRIOR_OUTPUTS],
  };
  assert.deepEqual(canonicalStepDrift("direct-engineer-workflow", actual, source, "adopt"), []);
  assert.deepEqual(
    canonicalStepDrift("direct-engineer-workflow", actual, source, "refuse-all").sort(),
    ["baseFromStepIndex", "priorOutputKinds", "provisionDependencies"],
  );
});

test("a refused difference alongside an adoptable one leaves the refusal standing", () => {
  const source = sourceStep("direct-engineer-workflow", 3);
  const actual = { ...asPersisted(source), provisionDependencies: true, outputKind: "drifted-output" };
  assert.deepEqual(canonicalStepDrift("direct-engineer-workflow", actual, source, "adopt"), ["outputKind"]);
  assert.deepEqual(
    canonicalStepAdoptions("direct-engineer-workflow", actual, source).map(({ difference }) => difference),
    ["provisionDependencies"],
  );
});
