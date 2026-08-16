# Merge gate: Repairs, Batch 2, Files, and Web

This note is a required merge checklist, not a request to change Batch 2 code
on the Repairs branch. A clean textual merge is not sufficient evidence that
the archived-assignee transaction guarantees survived.

## Required order and Batch 2 resolution

1. Land Repairs first.
2. Merge Batch 2 next. Preserve its CAS/idempotency structure, but move the
   archived-assignee pre-check into `activateChainSuccessor`, before
   `enqueueTaskRun`. Restore `assigneeAgent` in the successor load. In the
   savepoint catch, handle `isArchivedAssigneeError` by parking the successor
   in `REVIEW` with its failure reason and activity instead of rethrowing.
3. Do not resolve the `packages/db/src/workflow.ts` conflict by taking Batch
   2's version wholesale. Completion callers must park and commit, while gate
   approve/reject callers must still throw so the Inbox decision rolls back and
   remains retryable.
4. Add archived-assignee guards and regression tests for both new Batch 2 API
   activation sites (`completeRun` and `PATCH status=DONE`) and both scheduler
   `enqueueTaskRun` sites. The completion test must prove the succeeded run,
   session close, and `taskStepOutput` commit even when the successor is parked.

`packages/api/src/app.ts` can merge without a conflict while still introducing
the unsafe Batch 2 activation calls, so reviewers must inspect those call sites
explicitly. `ArchivedAssigneeError` is not a Prisma P2002; a catch that handles
only P2002 will rethrow it and roll back the surrounding completion transaction.

In `packages/inbox/src/index.ts`, combine both changes: remove Batch 2's
`InboxConnectionWindow` and retain Repairs' archived-assignee error toast. Do
not choose one side wholesale.

## Adjacent batch checks

Land the Batch 0 web refactor before porting Repairs' Archived badge, Archive
action, and archived-agent picker filtering to its new components. Land Files
after Repairs as required by the Files plan, preserving every GC fix while
adopting `defaultWorkspaceRoot()`.

Before Files changes the default root from `/tmp/agentos-runs` to
`~/.agentos/runs`, either keep `RUNNER_WORKSPACE_ROOT=/tmp/agentos-runs` during
the rollout or drain/migrate retained and `WAITING_INBOX` workspaces. Otherwise
the old root becomes uncollected and resumed workspaces fail the controlled-root
check.

## PI verification boundary

The recorded `adapterVersion` and wrapper-reported `cliVersion` prove only that
the PI adapter was selected, preflight passed, and a child process spawn was
attempted. The wrapper then exited with a protocol error; a protocol-capable PI
terminal event, AgentOS tool call, resume, and successful completion remain
unverified end to end.
