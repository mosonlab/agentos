import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ArchivedAssigneeError,
  ArchivedTaskError,
  ChainHeldError,
  CompoundImplementationAssigneeError,
  IntegratorStoppedError,
  MergeConfirmationError,
  MergeEvidenceError,
  PinnedBaseCommitError,
  WorkflowRefusalError,
  type WorkflowRefusalReason,
} from "@anneal/db";

import {
  type Refusal,
  type RefusalReason,
  refusalFor,
  refusalResponse,
} from "./refusal.js";

const refusalByReason = {
  "invalid-request": { reason: "invalid-request", message: "invalid" },
  forbidden: { reason: "forbidden", message: "forbidden" },
  "not-found": { reason: "not-found", message: "missing" },
  conflict: { reason: "conflict", message: "conflict" },
  "compound-implementation-assignee": { reason: "compound-implementation-assignee", message: "compound" },
  "archived-assignee": { reason: "archived-assignee", message: "archived assignee" },
  "archived-task": { reason: "archived-task", message: "archived task" },
  "chain-held": { reason: "chain-held", message: "chain held" },
  "integrator-stopped": { reason: "integrator-stopped", message: "integrator stopped" },
  "pinned-base-commit": { reason: "pinned-base-commit", message: "pinned base" },
  "merge-evidence": { reason: "merge-evidence", message: "merge evidence" },
  "merge-confirmation": { reason: "merge-confirmation", message: "merge confirmation" },
  "inbox-question-not-found": { reason: "inbox-question-not-found", message: "missing question" },
  "approval-gate-decision-invalid": { reason: "approval-gate-decision-invalid", message: "invalid decision" },
  "inbox-choice-mismatch": { reason: "inbox-choice-mismatch", message: "choice mismatch" },
  "inbox-run-not-waiting": { reason: "inbox-run-not-waiting", message: "run not waiting" },
  "approval-gate-rejection-target-missing": {
    reason: "approval-gate-rejection-target-missing",
    message: "missing rejection target",
  },
} as const satisfies Record<RefusalReason, Refusal>;

test("every refusal reason has one exhaustive HTTP status", () => {
  const statuses = Object.fromEntries(
    Object.entries(refusalByReason).map(([reason, refusal]) => [reason, refusalResponse(refusal).status]),
  );
  assert.deepEqual(statuses, {
    "invalid-request": 400,
    forbidden: 403,
    "not-found": 404,
    conflict: 409,
    "compound-implementation-assignee": 409,
    "archived-assignee": 409,
    "archived-task": 409,
    "chain-held": 409,
    "integrator-stopped": 409,
    "pinned-base-commit": 409,
    "merge-evidence": 409,
    "merge-confirmation": 409,
    "inbox-question-not-found": 409,
    "approval-gate-decision-invalid": 409,
    "inbox-choice-mismatch": 409,
    "inbox-run-not-waiting": 409,
    "approval-gate-rejection-target-missing": 409,
  });
});

test("all seven refusal error families map through the same module", () => {
  const errors = [
    [new CompoundImplementationAssigneeError(), "compound-implementation-assignee"],
    [new ArchivedAssigneeError("task-1", "Task 1", "agent-1"), "archived-assignee"],
    [new ArchivedTaskError("task-1", "Task 1"), "archived-task"],
    [new ChainHeldError("task-1", "chain-1", 2, 1), "chain-held"],
    [new IntegratorStoppedError("task-1", "target-unresolvable"), "integrator-stopped"],
    [new PinnedBaseCommitError("task-1", 4, "missing output"), "pinned-base-commit"],
    [new MergeEvidenceError("Merge evidence is incomplete"), "merge-evidence"],
    [new MergeConfirmationError("Merge confirmation is incomplete"), "merge-confirmation"],
  ] as const;

  for (const [error, reason] of errors) {
    const refusal = refusalFor(error);
    assert.equal(refusal?.reason, reason);
    assert.equal(refusal && refusalResponse(refusal).status, 409);
  }
});

test("the five error families formerly missed by app.onError never reach its 500 fallback", () => {
  const responseFor = (error: Error) => {
    const refusal = refusalFor(error);
    assert.ok(refusal);
    return refusalResponse(refusal);
  };

  assert.equal(responseFor(new ArchivedTaskError("task-1", "Task 1")).status, 409);
  assert.equal(responseFor(new IntegratorStoppedError("task-1", "target-unresolvable")).status, 409);
  assert.equal(responseFor(new MergeConfirmationError("Merge confirmation is incomplete")).status, 409);
  assert.equal(responseFor(new PinnedBaseCommitError("task-1", 4, "missing output")).status, 409);
  assert.equal(responseFor(new MergeEvidenceError("Merge evidence is incomplete")).status, 409);
});

test("workflow refusals are classified by reason independently of prose", () => {
  const messagesByReason = {
    "invalid-request": "changed configuration wording",
    conflict: "changed concurrency wording",
    "inbox-question-not-found": "changed missing-question wording",
    "approval-gate-decision-invalid": "changed decision wording",
    "inbox-choice-mismatch": "changed choice wording",
    "inbox-run-not-waiting": "changed run-state wording",
    "approval-gate-rejection-target-missing": "changed rejection-target wording",
  } as const satisfies Record<WorkflowRefusalReason, string>;
  for (const [reason, message] of Object.entries(messagesByReason) as Array<[WorkflowRefusalReason, string]>) {
    const refusal = refusalFor(new WorkflowRefusalError(reason, message));
    assert.equal(refusal?.reason, reason);
    assert.equal(refusal?.message, message);
    assert.equal(refusal && refusalResponse(refusal).status, reason === "invalid-request" ? 400 : 409);
  }
  assert.equal(refusalFor(new Error("unclassified")), null);
});

test("refusal detail is preserved beside the public error message", () => {
  assert.deepEqual(refusalResponse({
    reason: "conflict",
    message: "Run suspended for Inbox",
    detail: { code: "WAITING_INBOX" },
  }), {
    body: { error: "Run suspended for Inbox", code: "WAITING_INBOX" },
    status: 409,
  });
});
