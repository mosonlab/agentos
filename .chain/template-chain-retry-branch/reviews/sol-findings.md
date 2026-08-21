# Sol code review findings

## Review authority

- implementation_range: `00b94f9861861d19c5bdc78b57cb5949d82bd730...482e0b1aaa217539c3492e6bdea8c3ece60f43aa`
- Base and head both resolve to commits; checkout HEAD was the delivered head before review.
- Governing specification: `.chain/template-chain-retry-branch/spec.md`
- Revised plan: none; this is a direct chain.
- Reviewed the complete integrated diff and resulting tree, not only the final hunk.

## Verdict

- P0: 0
- P1: 1
- P2: 0

### SOL-001 — P1 — A per-run fallback can remain the template chain head

Location: `packages/api/src/app.ts:4155-4158` (trigger), `packages/db/src/workflow.ts:241-255,359-364` (branch selection), `packages/runner/src/workspace.ts:159-160` and `packages/api/src/app.ts:3559-3574` (fallback persistence).

Governing specification:

> An automatic retry of a template chain step runs on the chain branch, so a
> step that succeeds on retry publishes where its successor will clone.

> Automated test: a template chain step whose run fails retryably gets an
> automatic retry whose `branch` is the chain branch (not null), and a
> subsequent successful publication lands on the chain branch name.

Problem: the automatic-retry path passes the failed `run` as `prior`, and the template branch resolver prefers `prior.branch` without proving that it is the logical template chain branch. A valid single-step template has no sibling task from which `templateChainBranch` can recover the template head: instantiation rejects only zero-step templates, while the first task stores the repository default as `targetBranch`. Its initial Run can therefore have `branch: null`; workspace provisioning selects `agentos/<taskId>/run-<n>`, and the runner start route persists that fallback to `Run.branch`. If that Run fails retryably, the changed path creates the next Run on the per-run fallback rather than the chain branch. The same self-perpetuating state is reachable for a retry created before this fix and started before or after deployment.

Evidence:

- `packages/api/src/app.ts:4158` passes the database `run` directly for every template retry.
- `packages/db/src/workflow.ts:362` returns `prior?.branch ?? chainBranch`.
- `packages/db/src/workflow.ts:241-255` can return no `chainBranch` for the first task of a single-step template because there is no non-default sibling target.
- `packages/runner/src/workspace.ts:160` creates the per-run fallback when the queued Run branch is null, and `packages/api/src/app.ts:3573` writes that fallback back to the Run before completion.
- The added regression at `packages/api/src/chain-branch.dbtest.ts:674-707` creates a two-step template and begins with a Run whose branch was already recoverable from the second task, so it cannot falsify this case.

Consequence: the retry can succeed and publish to a per-run branch instead of the required template chain branch. For a multi-step upgrade-state chain, its successor still clones the template chain branch, preserving the stranded-chain failure the feature is required to remove.

Fix direction: resolve and validate the logical template chain head independently of the failed Run's workspace branch; use the failed Run only for publication/base evidence. Add a regression that instantiates a one-step template, drives a null-branch Run through workspace/start fallback persistence, fails it retryably, and asserts the next Run and its successful publication use the template chain branch. Also cover an already-created null-branch retry as an upgrade-state case.

## Harness candidate adjudication

- Standards `STD-001`: accepted as `SOL-001` and raised from P2 to P1 because the trigger exists in a valid post-fix single-step template, not only during upgrade.
- Standards `STD-002`: rejected. The feature specification explicitly requires template automatic retries to resolve both `branch` and `targetBranch` through `resolveRunBranches`; it does not require retaining the old template retry's `run.targetBranch` snapshot, and the operator retry named as the correct analogue already uses the current Task row through the same resolver.
- Specification axis: no candidate findings.
- Fowler smell families: no separate reportable smell judgement.

## Evidence and commands

- Authority and diff: `git cat-file -t <base>`, `git cat-file -t <head>`, `git diff --find-renames --find-copies --unified=100 <base>...<head>`, and adjacent-call-site inspection with `rg`/`nl`.
- Standards harness: `codex exec review -m gpt-5.6-sol -c model_reasoning_effort=high -c service_tier="standard" "Review the changes from <base> to <head>. Standards axis only. ..." </dev/null > /tmp/cmt2fq6r806tgmp4562926l11-standards.log 2>&1 &`
- Specification harness: `codex exec review -m gpt-5.6-sol -c model_reasoning_effort=high -c service_tier="standard" "Review the changes from <base> to <head>. Specification axis only. ... [full specification verbatim]" </dev/null > /tmp/cmt2fq6r806tgmp4562926l11-spec.log 2>&1 &`
- Fresh-checkout prerequisites: `npm install`; `npm run build -w @agentos/db`.
- Narrow regression, with isolated roots and disposable PostgreSQL: `RUNNER_WORKSPACE_ROOT=/tmp/agentos-review-cmt2fq6r8-root/workspaces CONTROL_PLANE_STATE_DIR=/tmp/agentos-review-cmt2fq6r8-root/state FILES_ROOT=/tmp/agentos-review-cmt2fq6r8-root/files AGENTOS_ALLOW_SCRATCH_DATABASES=1 TEST_DATABASE_URL='postgresql://agentos:review-scratch-fixture-password-000000@127.0.0.1:50255/agentos_review?schema=review_cmt2fq6r8' TEST_DATABASE_MAINTENANCE_URL='postgresql://agentos:review-scratch-fixture-password-000000@127.0.0.1:50255/postgres' DATABASE_URL='postgresql://agentos:review-scratch-fixture-password-000000@127.0.0.1:50255/agentos_review?schema=review_cmt2fq6r8' npm run test:db -w @agentos/api -- src/chain-branch.dbtest.ts` — PASS, 29/29.
- Specification harness exact-head gate after removing session credentials: `scripts/merge-gate.sh --expect-head 482e0b1aaa217539c3492e6bdea8c3ece60f43aa --master 00b94f9861861d19c5bdc78b57cb5949d82bd730` — `MERGE GATE: PASS 482e0b1aaa217539c3492e6bdea8c3ece60f43aa`.
- The first narrow-regression attempt did not enter tests because dependencies were absent (`tsc: command not found`); the listed fresh-checkout prerequisites were installed before the passing rerun.
- The specification harness's first gate attempt failed only because `AGENTOS_SESSION_TOKEN` leaked into gate-worker fixtures; it reran with credential variables removed and produced the exact-head PASS above.
