import { legacyGenerationMarkerForTemplateName } from "./canonical-template-transition.js";

export type StepRole =
  | "spec"
  | "plan"
  | "plan-review"
  | "revised-plan"
  | "must-fix"
  | "implementation"
  | "sol-findings"
  | "blind-findings"
  | "fixed-implementation"
  | "documentation"
  | "regression"
  | "readiness"
  | "integrator";

export type TemplateStepLike = {
  outputKind: string;
  taskTemplate?: { name: string } | null;
  taskTemplateName?: string | null;
};

const OUTPUT_KIND_ROLES: Readonly<Record<string, StepRole>> = {
  spec: "spec",
  plan: "plan",
  "plan-review": "plan-review",
  "revised-plan": "revised-plan",
  "must-fix": "must-fix",
  implementation: "implementation",
  "sol-findings": "sol-findings",
  "blind-findings": "blind-findings",
  "fixed-implementation": "fixed-implementation",
  documentation: "documentation",
  "regression-verification": "regression",
  "merge-authorization": "readiness",
  "merge-result": "integrator",
};

const VERSION_SUFFIX = /-(v[1-9]\d*)$/u;

export const stepRole = (step: TemplateStepLike): StepRole | null => {
  const normalizedOutputKind = step.outputKind.replace(VERSION_SUFFIX, "");
  return OUTPUT_KIND_ROLES[normalizedOutputKind] ?? null;
};

/** A retired graph marker takes precedence over an individual output protocol version. */
export const stepGeneration = (step: TemplateStepLike): string => {
  const templateName = step.taskTemplate?.name ?? step.taskTemplateName ?? null;
  const retiredGeneration = templateName === null ? null : legacyGenerationMarkerForTemplateName(templateName);
  if (retiredGeneration !== null) return retiredGeneration;
  return step.outputKind.match(VERSION_SUFFIX)?.[1] ?? "v1";
};
