# Task brief — Platform repair: one branch and one PR per chain (spec step ①)

You are step ① (spec) of the nine-step chain. Write a requirements spec; no implementation. Deliver to `docs/specs/platform-chain-branch-and-pr.md`, push, then continue — this step has no approval gate. Do not call `inbox_ask`.

## Why this batch exists

Every nine-step chain this platform runs currently opens **nine sibling branches and up to nine pull requests**, and every step after the fifth points at the wrong tree. The operator has hand-repaired this on three consecutive batches: repointing `targetBranch` by hand, selecting the merge branch by commit count instead of by chain position, and closing eight stray PRs one at a time. Batch 2.5 alone produced nine PRs, four of which could not be closed because they had already been merged.

**The machinery to do this correctly is already built and already tested. One predicate starves it.**

`packages/db/src/workflow.ts:120`:

```js
const chainBranch = task.templateId && task.targetBranch && task.targetBranch !== task.repo.defaultBranch
  ? task.targetBranch
  : null;
```

The comment directly above it states the intent: *"Template steps after the first one inherit the chain's shared feature branch so every step pushes to the same head and the chain lands in one PR; without this the workspace falls back to a per-run branch and each step opens its own."* The guard is `task.templateId`, but chains created through the API carry `chainId` and no `templateId`, so `chainBranch` is always `null` for them, every step falls back to `agentos/<taskId>/run-<n>`, and each opens its own PR.

The PR-reuse half is complete: `packages/runner/src/delivery.ts` already looks for an open PR on the head branch (`gh pr list --head <branch> --state open`), and the runner test *"a chain step reuses the open pull request on its shared head branch"* has been green this whole time. It has been waiting for a shared branch that was never computed.

## Sources of authority

- `docs/BACKLOG-V2.md` — the entries "建链时 ⑥⑦⑧ 的 targetBranch 指向 ① 的 spec 分支" and "一链一 PR". They are one defect; this batch closes both.
- `packages/db/src/workflow.ts` (`enqueueTaskRun`, `activateChainSuccessor`), `packages/runner/src/delivery.ts`, `packages/runner/src/workspace.ts`, `packages/api/src/app.ts` (task creation).
- `packages/api/src/chain.dbtest.ts` — the existing chain semantics tests. They define the behaviour you must not break.

## In scope

### 1. Chain steps share one branch

Widen the guard so chains identified by `chainId` get a shared branch, not only chains identified by `templateId`. Do not simply reuse step ①'s run branch name as the shared name: `agentos/<step-1-task-id>/run-1` is an accident of which task happened to be first, and it reads as one step's branch when it is the chain's. Derive the name from the chain instead — the review recommends `agentos/chain/<chainId prefix>`; choose deliberately and state the rule, including what happens when two chains exist in different projects.

Consequences to spec explicitly:

- Step N bases off the shared branch and pushes back to it, so step ⑥ is automatically on a tree containing step ⑤'s work. **This is what removes the wrong-tree review hazard**, which is currently mitigated only by instructions in the task description and, for the code review step, by luck.
- `targetBranch` on chain steps stops being something a human sets per step. Say what it means afterwards and whether it should still be writable.
- A retried step (`run-2`, `run-3`) must land on the same shared branch, not a new one. Batch 2.5's step ⑤ succeeded on its third run; that case is not hypothetical.

### 2. Not every step opens a pull request

Pure documentation steps (spec, plan, plan review, review, wiki) should push to the shared branch without opening a PR; the chain should end with **one** PR. Put this in the chain data — the backlog entry is explicit that this must be a field such as `opensPullRequest`, and that **grepping step names inside the runner is forbidden**. Specify the default for tasks that are not part of a chain, and what happens when the step that was supposed to open the PR fails and a later step succeeds.

### 3. Do not break template chains

Template-driven chains use this same code path today and work. Every existing test in `packages/api/src/chain.dbtest.ts` must still pass unmodified, and the spec must state which behaviours are load-bearing for templates so the implementation does not "simplify" one of them away.

### 4. Migration and in-flight chains

If this needs a schema field, it needs a migration, and the same standard applies as everywhere else: additive, reversible, with a rollback runbook. Follow the precedent set by `docs/runbooks/batch-2.5-rollback.md` rather than inventing a new format.

**Chains will be in flight when this deploys.** The change takes effect at `enqueueTaskRun` time, which means a chain that started under the old behaviour will have its already-created runs on per-task branches and its not-yet-activated steps on the shared branch. Spec what happens to such a chain — the honest answer may be "the mixed chain is finished by hand and this is only correct for chains started after the restart", but it must be stated, not discovered.

## Explicitly out

- Changing what the nine steps are, their agents, or their models.
- Touching approval-gate semantics. There is a separate known defect where a gate message opened for a human step is never closed (`docs/BACKLOG-V2.md`, "闸门消息永远关不掉") — it is real, it is adjacent, and it is **not yours**. Do not fold it in.
- Workspace provisioning, dependency caching, retry policy.

## Acceptance shape (the spec must make these concrete and checkable)

- A `chainId` chain of N steps produces exactly **one** branch and exactly **one** pull request, proven by a dbtest plus a runner test, not by inspection.
- A retried step pushes to the shared branch.
- Every existing `chain.dbtest.ts` test passes unmodified.
- `npm run build`, full test suite, `npm run typecheck`, `npm run db:drift-check` green.
- The rollback runbook exists and names the exact revert, including the migration if there is one.

## The thing that makes this batch unusual — read it twice

**You are modifying the machinery that is running you.** The chain executing this batch is itself dispatched by `enqueueTaskRun` and delivered by `delivery.ts`. Two consequences:

1. Your changes do not take effect for your own chain: the API is a long-lived process and picks up new code only when the operator rebuilds and restarts it, which is deliberately held. So do not expect your own steps to start sharing a branch, and do not "fix" anything because they did not.
2. A defect here does not fail loudly — it silently mis-delivers every future chain's work. A step that pushes to the wrong branch loses that work as far as the merger is concerned. Weigh a false green here as more expensive than in an ordinary batch, and prefer tests that assert on the branch and PR actually produced over tests that assert the function returned the string you expected.

**Never restart the runner, the API, or any launchd service, and never merge anything.** If you need to observe chain behaviour, write a dbtest against a scratch database built from migrations with fixture rows — never a dump of the live one, and never point a second API process at it.

## Concurrency with other chains

Two other chains are in flight. Batch 1 (Settings + i18n) is mostly `apps/web` but may touch `packages/api/src/app.ts`. The batch 4 fixes chain touches `packages/db/src/usage.ts`, `packages/db/prisma/backfill-session-usage.ts`, and the session ingest path in `packages/api/src/app.ts`. Keep your diff confined to the chain/delivery machinery; at the fixes step, rebase onto the latest `origin/master` before the final push and re-run the gates after rebasing.

## Standing clauses

- Task-creation field is `name`, not `title`. Implementation steps set `maxDurationMin: 240`. Plan steps (②④) use `claude-opus-5:xhigh`; implementation and review steps use `:high`. Never write OPERATOR_TOKEN into any artifact.
