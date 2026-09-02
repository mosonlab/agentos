/**
 * The dependency-provisioning decision: does this Run install dependencies,
 * and what does a provisioning failure mean.
 *
 * The question has two inputs that only the claim carries — the template
 * step's explicit decision and the repository's policy — and it is answered
 * once, when the claim is admitted, before any workspace, scratch, child
 * environment or adapter work exists. Everything downstream receives the
 * decided value: `provisionWorkspace` gates the materializer on it, and the
 * runner's failure path asks this module to classify a provisioning failure
 * rather than reading the dependency cache's error taxonomy itself.
 */

import type { ClassifiedFailure } from "./adapters/runtime.js";
import { isDependencyProvisioning } from "./api.js";
import { DependencyProvisioningManifestMissingError } from "./dependency-cache.js";

/**
 * What the workspace does about dependencies. A skip carries the evidence line
 * the Run records, so no caller has to know which of the two inputs produced
 * it.
 */
export type DependencyProvisioningDecision =
  | { readonly provision: true }
  | { readonly provision: false; readonly evidence: string };

/**
 * The claim shapes this module refuses. Both are protocol violations: a
 * missing or malformed value cannot be defaulted, because either default
 * silently changes whether a repository's dependencies are installed.
 */
export type DependencyProvisioningRefusal =
  | "template-step-provision-dependencies-missing"
  | "dependency-provisioning-missing";

export type DependencyProvisioningAdmission =
  | { readonly admitted: true; readonly decision: DependencyProvisioningDecision }
  | { readonly admitted: false; readonly condition: DependencyProvisioningRefusal };

/** The two claim fields the decision reads, typed as they arrive over the wire. */
export type DependencyProvisioningClaim = {
  readonly task: { readonly templateStep?: unknown };
  readonly repo?: { readonly dependencyProvisioning?: unknown } | null;
};

export const decideDependencyProvisioning = (
  claim: DependencyProvisioningClaim,
): DependencyProvisioningAdmission => {
  // A template step carries an explicit dependency decision. A missing or
  // malformed value is a protocol violation: no default is safe because it
  // could either strip dependencies from an implementation step or expose a
  // review step to the dependency materializer. A null step is not malformed —
  // it means no step, and the repository policy governs.
  const templateStep = claim.task.templateStep as { provisionDependencies?: unknown } | null | undefined;
  if (templateStep === undefined
    || (templateStep !== null && typeof templateStep.provisionDependencies !== "boolean")) {
    return { admitted: false, condition: "template-step-provision-dependencies-missing" };
  }
  // Dependency provisioning is a required claim contract. A runner build that
  // predates this field must fail closed rather than pick a policy.
  const policy = claim.repo?.dependencyProvisioning;
  if (!isDependencyProvisioning(policy)) return { admitted: false, condition: "dependency-provisioning-missing" };
  if (templateStep?.provisionDependencies === false) {
    return {
      admitted: true,
      decision: {
        provision: false,
        evidence: "Dependency provisioning skipped: TaskTemplateStep.provisionDependencies=false",
      },
    };
  }
  if (policy === "NONE") {
    return {
      admitted: true,
      decision: { provision: false, evidence: "Dependency provisioning skipped: Repo.dependencyProvisioning=NONE" },
    };
  }
  return { admitted: true, decision: { provision: true } };
};

/**
 * The failure class a provisioning failure carries, or null when the error did
 * not come from provisioning and the adapter's own classification applies.
 * NPM_CI without a root manifest is a repository-policy violation, so retrying
 * it on another host would only repeat it.
 */
export const classifyDependencyProvisioningFailure = (error: unknown): ClassifiedFailure | null =>
  error instanceof DependencyProvisioningManifestMissingError
    ? { failureClass: "PROTOCOL_ERROR", retryable: false }
    : null;
