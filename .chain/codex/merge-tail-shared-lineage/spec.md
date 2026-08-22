## Problem

A template-chain step receives platform-pinned `run.pullRequestBase`, but the current runner prompt calls that base the integration line and instructs every agent to fetch and refresh against it. On a published shared branch this can be misread as authority to rebase or rewrite predecessor history, violating the repository's append-only handoff contract. Draft PR #58 identified the defect, but its branch belongs to another concurrent goal and must remain untouched.

## Scope and change points

Implement independently from current `main` on this chain's own branch. Change only the smallest necessary runner prompt contract and focused tests:

1. In `packages/runner/src/adapters.ts`, state that `run.pullRequestBase` is authority for comparison and merge authorization, not authority to rewrite the checked-out branch.
2. For template-chain tasks, state that the checked-out starting commit is append-only handoff state; final HEAD must descend from it and remain fast-forward publishable. Fetch the pinned base for comparison only unless the step is explicitly designated for integration or merge. Conflicting task-authored instructions are a workflow error.
3. In `packages/runner/src/adapters.test.ts`, update the existing pinned-base assertion and add focused coverage for the template-chain append-only contract.
4. Do not change, rebase, reset, force-push, or otherwise write draft PR #58's branch `codex/guard-shared-chain-lineage`; this chain must use only `codex/merge-tail-shared-lineage`.
5. Do not introduce service-tier changes or unrelated cleanup.

## Acceptance criteria

- The ordinary prompt no longer tells all tasks to `fetch and refresh` the pinned base.
- Template-chain prompts explicitly preserve the starting commit as append-only shared lineage and fail closed on contradictory task text.
- Non-template task behavior remains limited to comparison and merge-authorization authority.
- Focused runner tests, typecheck/lint as relevant, `git diff --check`, public snapshot scan, and the repository's exact-head merge gate pass.
- Delivery remains append-only and uses the official mechanical merge tail; no direct main push, no direct GitHub merge, and no database writes.

## Non-goals

- No rewrite of existing published branches.
- No modification of PR #58 or PR #36 branches.
- No broader runner architecture or service-tier policy change.
