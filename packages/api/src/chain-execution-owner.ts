import { isIntegratorStep, isMergeReadinessStep } from "@anneal/db";

export type ChainExecutionOwner = "agent" | "human" | "control-plane" | "merge-executor";

type ChainExecutionSubject = {
  assigneeType: string;
  templateStep: {
    stepIndex: number;
    outputKind: string;
    taskTemplate?: { name: string } | null;
  } | null;
};

/**
 * Presentation truth for a chain row. Persisted assignee identity remains the
 * scheduling contract, but the server-owned readiness worker and the isolated
 * merge executor are the operators an observer needs to see.
 */
export const chainExecutionOwner = (subject: ChainExecutionSubject): ChainExecutionOwner => {
  if (isMergeReadinessStep(subject.templateStep)) return "control-plane";
  if (isIntegratorStep(subject.templateStep)) return "merge-executor";
  return subject.assigneeType === "HUMAN" ? "human" : "agent";
};

/**
 * The same rule for a template step, which has no task row yet. The staffing
 * surface must agree with the chain rows the graph will produce, so both sides
 * answer from one predicate rather than from a step's name or output kind.
 */
export const templateStepExecutionOwner = (step: {
  stepIndex: number;
  outputKind: string;
  assigneeType: string;
}): ChainExecutionOwner => chainExecutionOwner({
  assigneeType: step.assigneeType,
  templateStep: { stepIndex: step.stepIndex, outputKind: step.outputKind },
});
