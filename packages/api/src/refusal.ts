import {
  isArchivedAssigneeError,
  isArchivedTaskError,
  isChainHeldError,
  isCompoundImplementationAssigneeError,
  isIntegratorStoppedError,
  isMergeConfirmationError,
  isMergeEvidenceError,
  isPinnedBaseCommitError,
  isWorkflowRefusalError,
  type WorkflowRefusalReason,
} from "@anneal/db";

import {
  isTemplateInstantiationRefusal,
  type TemplateInstantiationRefusalCode,
} from "./template-errors.js";

export type RefusalReason =
  | WorkflowRefusalReason
  | "forbidden"
  | "not-found"
  | "compound-implementation-assignee"
  | "archived-assignee"
  | "archived-task"
  | "chain-held"
  | "integrator-stopped"
  | "pinned-base-commit"
  | "merge-evidence"
  | "merge-confirmation";

export type RefusalValue =
  | string
  | number
  | boolean
  | null
  | RefusalValue[]
  | { [key: string]: RefusalValue };

export type RefusalDetail = Readonly<Record<string, RefusalValue> & { error?: never }>;

export type Refusal = {
  reason: RefusalReason | TemplateInstantiationRefusalCode;
  message: string;
  detail?: RefusalDetail;
};

export type RefusalResponse = {
  body: Readonly<{ error: string } & Record<string, RefusalValue>>;
  status: 400 | 403 | 404 | 409;
};

export const refusalResponse = (refusal: Refusal): RefusalResponse => {
  let status: RefusalResponse["status"];
  switch (refusal.reason) {
    case "after_task_already_bound":
    case "after_task_already_done":
    case "after_task_archived":
    case "after_task_not_chained":
    case "after_task_not_found":
    case "after_task_not_terminal":
    case "dispatch_conflicts_with_auto_start":
    case "implementation_route_agent_renamed":
    case "implementation_route_conflicts_with_step_override":
    case "implementation_route_malformed":
    case "implementation_route_unknown_agent":
    case "repo_not_found":
    case "step_override_agent_archived":
    case "step_override_agent_not_found":
    case "step_override_compound_implementation":
    case "step_override_integrator_binding":
    case "step_override_invalid_key":
    case "step_override_missing_repo_grant":
    case "step_override_step_not_agent":
    case "step_override_too_many":
    case "step_override_unknown_step":
    case "template_agent_repo_grant_missing":
    case "template_base_reference_missing":
    case "template_base_reference_not_earlier":
    case "template_branch_invalid":
    case "template_compound_implementation_assignee_invalid":
    case "template_first_step_not_agent":
    case "template_has_no_instantiable_steps":
    case "template_has_no_steps":
    case "template_integrator_binding_invalid":
    case "template_not_found":
    case "template_step_agent_archived":
    case "template_step_agent_missing":
    case "template_variables_missing":
    case "template_variables_unknown":
    case "invalid-request":
      status = 400;
      break;
    case "forbidden":
      status = 403;
      break;
    case "not-found":
      status = 404;
      break;
    case "conflict":
    case "compound-implementation-assignee":
    case "archived-assignee":
    case "archived-task":
    case "chain-held":
    case "integrator-stopped":
    case "pinned-base-commit":
    case "merge-evidence":
    case "merge-confirmation":
    case "inbox-question-not-found":
    case "approval-gate-decision-invalid":
    case "inbox-choice-mismatch":
    case "inbox-run-not-waiting":
    case "approval-gate-rejection-target-missing":
      status = 409;
      break;
    default: {
      const unhandled: never = refusal.reason;
      return unhandled;
    }
  }
  return {
    body: refusal.detail === undefined
      ? { error: refusal.message }
      : { error: refusal.message, ...refusal.detail },
    status,
  };
};

export const refusalFor = (error: unknown): Refusal | null => {
  if (isTemplateInstantiationRefusal(error)) {
    return {
      reason: error.code,
      message: error.message,
      detail: { code: error.code },
    };
  }
  if (isWorkflowRefusalError(error)) return { reason: error.reason, message: error.message };
  if (isCompoundImplementationAssigneeError(error)) {
    return {
      reason: "compound-implementation-assignee",
      message: error.message,
      detail: { code: error.code },
    };
  }
  if (isArchivedAssigneeError(error)) return { reason: "archived-assignee", message: error.message };
  if (isArchivedTaskError(error)) return { reason: "archived-task", message: error.message };
  if (isChainHeldError(error)) {
    return {
      reason: "chain-held",
      message: error.message,
      detail: {
        chainId: error.chainId,
        taskLayer: error.taskLayer,
        heldLayer: error.heldLayer,
      },
    };
  }
  if (isIntegratorStoppedError(error)) return { reason: "integrator-stopped", message: error.message };
  if (isPinnedBaseCommitError(error)) return { reason: "pinned-base-commit", message: error.message };
  if (isMergeEvidenceError(error)) return { reason: "merge-evidence", message: error.message };
  if (isMergeConfirmationError(error)) return { reason: "merge-confirmation", message: error.message };
  return null;
};
