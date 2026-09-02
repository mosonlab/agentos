import { stepRole, type TemplateStepLike } from "./step-role.js";

/** The two structural positions whose approval state is operator-configurable. */
export type GateSlot = "spec" | "merge";

/**
 * Resolve a template-backed step to its configurable approval slot.
 *
 * Slot identity is structural: the existing StepRole authority normalizes
 * versioned output kinds and is already shared by canonical and legacy
 * template generations. No template metadata or persisted setting participates
 * in this answer.
 */
export const gateSlotOf = (step: TemplateStepLike | null | undefined): GateSlot | null => {
  if (step == null) return null;
  const role = stepRole(step);
  return role === "spec" ? "spec" : role === "readiness" ? "merge" : null;
};
