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
