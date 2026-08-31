---
stepIndex: 1
layer: 1
agent: spec-revalidator
approvalGate: false
outputKind: revalidation
priorOutputKinds: []
attachmentsFromPrevious: false
opensPullRequest: false
requiresCommit: false
baseFromStepIndex: null
spawnPolicy: null
---
Revalidate the bound direct chain's feature brief before implementation. Read
the implementation task description and inspect the current repository tree at
HEAD. Update only stale descriptive references — file, function, field, and
route names, plus descriptions of current behavior — through the task PATCH
API. Keep every statement of intent unchanged: Goal; the intent of each
Changes item; Out of scope; Constraints; Acceptance; and Route. The updated
description must be durable before the implementation task is claimed, so its
`.chain/{{branchName}}/spec.md` materialization and the later review
verification both use the patched authority.

For each Changes item, check whether its premise still holds. If the thing it
exists to change is gone or already delivered, collect concrete tree evidence
and call `inbox_ask` with exactly these choices (stable IDs and labels):
`cancel-chain` — cancel this chain; `operator-rewrite` — operator rewrites the
brief, then continue; `proceed-reading` — proceed with the step's proposed
reading. `cancel-chain` applies the revalidation action to cancel the chain.
After `operator-rewrite`, resume in place by re-reading the current
implementation brief; after `proceed-reading`, resume with the proposed
reading.

Use only the minimal task-PATCH authorization granted to this step. This is a
read-only workflow: do not edit files, commit, push, open a pull request, or
otherwise change repository state. An unreadable repository, rejected PATCH,
or tool error fails this step loudly with the reason recorded; normal retry
semantics apply.

After the PATCH succeeds, or when no descriptive references need changing,
persist exactly one JSON object as this step's output:
`{"schemaVersion":1,"headSha":"<current HEAD>","outcome":"updated|unchanged|proceeded-after-premise-collapse","summary":"<result>","changedReferences":["<reference>"]}`.
