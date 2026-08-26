import {
  isArchivedAssigneeError,
  isArchivedTaskError,
  isCompoundImplementationAssigneeError,
  isIntegratorStoppedError,
  isMergeConfirmationError,
  isMergeEvidenceError,
  isPinnedBaseCommitError,
} from "@agentos/db";

export type RefusalReason =
  | "invalid-request"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "compound-implementation-assignee"
  | "archived-assignee"
  | "archived-task"
  | "integrator-stopped"
  | "pinned-base-commit"
  | "merge-evidence"
  | "merge-confirmation"
  | "inbox-question-not-found"
  | "approval-gate-decision-invalid"
  | "inbox-choice-mismatch"
  | "inbox-run-not-waiting"
  | "approval-gate-rejection-target-missing";

export type RefusalValue =
  | string
  | number
  | boolean
  | null
  | RefusalValue[]
  | { [key: string]: RefusalValue };

export type RefusalDetail = Readonly<Record<string, RefusalValue> & { error?: never }>;

export type Refusal = {
  reason: RefusalReason;
  message: string;
  detail?: RefusalDetail;
};

export type RefusalResponse = {
  body: Readonly<{ error: string } & Record<string, RefusalValue>>;
  status: 400 | 403 | 404 | 409;
};

const inboxReasonByMessage = {
  "No matching Inbox question": "inbox-question-not-found",
  "Approval gate decision must be approve or reject": "approval-gate-decision-invalid",
  "Decision must match an Inbox choice id": "inbox-choice-mismatch",
  "No matching waiting Inbox question": "inbox-run-not-waiting",
  "Approval gate has no executable previous task to reject to": "approval-gate-rejection-target-missing",
} as const satisfies Readonly<Record<string, RefusalReason>>;

export const refusalResponse = (refusal: Refusal): RefusalResponse => {
  let status: RefusalResponse["status"];
  switch (refusal.reason) {
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
  if (isCompoundImplementationAssigneeError(error)) {
    return {
      reason: "compound-implementation-assignee",
      message: error.message,
      detail: { code: error.code },
    };
  }
  if (isArchivedAssigneeError(error)) return { reason: "archived-assignee", message: error.message };
  if (isArchivedTaskError(error)) return { reason: "archived-task", message: error.message };
  if (isIntegratorStoppedError(error)) return { reason: "integrator-stopped", message: error.message };
  if (isPinnedBaseCommitError(error)) return { reason: "pinned-base-commit", message: error.message };
  if (isMergeEvidenceError(error)) return { reason: "merge-evidence", message: error.message };
  if (isMergeConfirmationError(error)) return { reason: "merge-confirmation", message: error.message };
  if (!(error instanceof Error)) return null;
  const reason = inboxReasonByMessage[error.message as keyof typeof inboxReasonByMessage];
  return reason === undefined ? null : { reason, message: error.message };
};
