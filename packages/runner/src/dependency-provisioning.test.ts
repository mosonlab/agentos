import assert from "node:assert/strict";
import test from "node:test";

import { DependencyProvisioningManifestMissingError } from "./dependency-cache.js";
import {
  classifyDependencyProvisioningFailure,
  decideDependencyProvisioning,
  type DependencyProvisioningAdmission,
} from "./dependency-provisioning.js";

const claimOf = (templateStep: unknown, dependencyProvisioning: unknown): Parameters<
  typeof decideDependencyProvisioning
>[0] => ({ task: { templateStep }, repo: { dependencyProvisioning } });

const step = (provisionDependencies: unknown): Record<string, unknown> => ({
  name: "Implementation",
  outputKind: "result",
  provisionDependencies,
  taskTemplate: { name: "implementation-workflow" },
});

const REFUSED_TEMPLATE_STEP: DependencyProvisioningAdmission = {
  admitted: false,
  condition: "template-step-provision-dependencies-missing",
};
const REFUSED_POLICY: DependencyProvisioningAdmission = {
  admitted: false,
  condition: "dependency-provisioning-missing",
};
const PROVISION: DependencyProvisioningAdmission = { admitted: true, decision: { provision: true } };
const SKIP_TEMPLATE_STEP: DependencyProvisioningAdmission = {
  admitted: true,
  decision: {
    provision: false,
    evidence: "Dependency provisioning skipped: TaskTemplateStep.provisionDependencies=false",
  },
};
const SKIP_POLICY: DependencyProvisioningAdmission = {
  admitted: true,
  decision: { provision: false, evidence: "Dependency provisioning skipped: Repo.dependencyProvisioning=NONE" },
};

// The template step's explicit decision by the repository's policy. The
// refusals come first: a claim shape the runner cannot read is not a policy
// question, and no default is safe for either input.
const TABLE: Array<{ name: string; templateStep: unknown; policy: unknown; expected: DependencyProvisioningAdmission }> = [
  { name: "an absent template step field", templateStep: undefined, policy: "NPM_CI", expected: REFUSED_TEMPLATE_STEP },
  { name: "an absent step decision", templateStep: step(undefined), policy: "NPM_CI", expected: REFUSED_TEMPLATE_STEP },
  { name: "a non-boolean step decision", templateStep: step("yes"), policy: "NPM_CI", expected: REFUSED_TEMPLATE_STEP },
  // The template step is read first, so a claim that is malformed in both
  // inputs is refused for the step, not for the policy.
  { name: "both inputs malformed", templateStep: step("yes"), policy: undefined, expected: REFUSED_TEMPLATE_STEP },
  { name: "an absent policy", templateStep: null, policy: undefined, expected: REFUSED_POLICY },
  { name: "an unknown policy", templateStep: null, policy: "PYTHON", expected: REFUSED_POLICY },
  { name: "a non-string policy", templateStep: step(true), policy: 1, expected: REFUSED_POLICY },
  { name: "NPM_CI under a step that opts in", templateStep: step(true), policy: "NPM_CI", expected: PROVISION },
  // No step means no opt-out, so the repository policy governs on its own.
  { name: "NPM_CI under no template step", templateStep: null, policy: "NPM_CI", expected: PROVISION },
  { name: "NPM_CI under a step that opts out", templateStep: step(false), policy: "NPM_CI", expected: SKIP_TEMPLATE_STEP },
  // Both say skip: the step is the more specific answer and owns the evidence.
  { name: "NONE under a step that opts out", templateStep: step(false), policy: "NONE", expected: SKIP_TEMPLATE_STEP },
  { name: "NONE under a step that opts in", templateStep: step(true), policy: "NONE", expected: SKIP_POLICY },
  { name: "NONE under no template step", templateStep: null, policy: "NONE", expected: SKIP_POLICY },
];

for (const { name, templateStep, policy, expected } of TABLE) {
  test(`the dependency decision for ${name}`, () => {
    assert.deepEqual(decideDependencyProvisioning(claimOf(templateStep, policy)), expected);
  });
}

test("a claim with no repository at all is refused rather than defaulted", () => {
  assert.deepEqual(
    decideDependencyProvisioning({ task: { templateStep: null } }),
    REFUSED_POLICY,
  );
});

test("a missing NPM_CI manifest is a non-retryable protocol failure", () => {
  assert.deepEqual(
    classifyDependencyProvisioningFailure(new DependencyProvisioningManifestMissingError()),
    { failureClass: "PROTOCOL_ERROR", retryable: false },
  );
});

test("any other failure is left to the adapter to classify", () => {
  assert.equal(classifyDependencyProvisioningFailure(new Error("git failed (128)")), null);
  assert.equal(classifyDependencyProvisioningFailure("not an error"), null);
});
