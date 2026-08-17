# PLAN — Platform repair: one branch and one pull request per chain

Status: **revision 0** · Author: plan agent (chain step ②) · Date: 2026-08-16
Spec: `docs/specs/platform-chain-branch-and-pr.md` (approved, commit `0f62af2`)
Authority behind the spec: `docs/BACKLOG-V2.md` 「建链时 ⑥⑦⑧ 的 targetBranch 指向
① 的 spec 分支」 and 「一链一 PR」 · the task brief for this batch.

Plan verified against the working tree at commit `0f62af2`. **Every file, line
anchor, schema field and query quoted below was re-read in the source while
writing this plan** — not carried over from the spec, which quotes several line
numbers that have since drifted (§0.4-C7). Reading the code turned up four
things the spec does not know; they are §0.2, and one of them (C1) would have
made the shipped feature dead-lock a chain on its first failed step.

**Nine work items, in dependency order, one commit each, on one branch, landing
as one PR with one migration folder.** Every spec requirement maps to a numbered
work item in §10. §0.2 is where the code contradicts or under-specifies the
spec, §0.3 is the list of deliberate deviations from the spec text and why,
§12 is what this plan is still guessing about.

Planning only. This plan implements nothing.

---

## 0. Approach summary

- **One pure function, one async resolver, four call sites.** `sharedChainBranch`
  (WI-1) is a pure `(projectId, chainId) → string`. `resolveRunBranches` (WI-3)
  is the *only* place that decides a run's `branch` and `targetBranch`; the four
  run-creating paths (`enqueueTaskRun`, `POST /tasks`, retry, reconcile) call it
  instead of each holding a copy of the expression. §12.3 of the spec makes this
  a review checklist item, so it is a structural requirement, not a preference.
- **The template branch is not touched, and the way it is not touched is a
  first-line early return.** `resolveRunBranches` returns today's expression
  verbatim when `task.templateId` is set, before it computes anything, queries
  anything or writes anything. That is what makes S7/R19/R20 a property of one
  `if` rather than of the whole function's care.
- **Schema before code (WI-2), because `opensPullRequest` does not typecheck
  until Prisma is regenerated.** Two additive defaulted columns, one migration
  folder, no backfill, `DROP COLUMN` reversal.
- **The base-branch evidence predicate is `status = SUCCEEDED` *and*
  `pushStatus = SUCCEEDED`, not `pushStatus` alone.** This is the plan's one
  substantive correction to the spec and the reason to read §0.2-C1 before
  writing any code: a *failed* chain-step run whose WIP salvage push succeeded
  records `Run.branch = <shared>` with `pushStatus = SUCCEEDED` while the push
  actually went to `agentos/<taskId>/run-<n>`. Under the spec's predicate as
  written, that run is "evidence" the shared branch exists, the next step clones
  a ref that was never created, and every retry fails the same way — the exact
  E1 case the spec says "must not happen".
- **The runner decides from one field with an explicit `!== false`.** The field
  is required in `ClaimedTask` so an omission in our code is a compile error
  (§7.3); the runtime comparison is against `false` specifically so a *stale API*
  that omits the field keeps today's behaviour instead of silently never opening
  a PR, which §11-E10 names as the expensive failure. No step-name matching
  anywhere (R15).
- **Tests assert on the artifact.** Every acceptance test asserts the `Run.branch`
  / `Run.targetBranch` rows a real API call or a real `activateChainSuccessor`
  produced, or the recorded command list a fake `CommandExecutor` captured —
  never "the function returned the string I expected". The one unit test of the
  pure function (WI-1) exists for the slug/fingerprint edge cases E8/E9 and is
  labelled as edge-case coverage, not as the acceptance bar.

### 0.1 The change in one table

| What | Where | From | To |
|---|---|---|---|
| Derived branch name | new `packages/db/src/chain-branch.ts` | — | `sharedChainBranch({projectId, chainId})` |
| Branch/base decision | `packages/db/src/workflow.ts:117-133` | inline, `templateId`-gated | `resolveRunBranches(tx, task, prior)` |
| First run of an API task | `packages/api/src/app.ts:1682-1698` | no `branch`; `targetBranch: body.targetBranch ?? repo.defaultBranch` | both from the resolver |
| Retry | `packages/api/src/app.ts:1904-1923` | `targetBranch: last.targetBranch, branch: last.branch` | both from the resolver |
| Lost-lease requeue | `packages/api/src/reconcile.ts:160-177` | `targetBranch: run.targetBranch`, no `branch` | resolver for chain steps only (§0.3-D4) |
| PR creation | `packages/runner/src/delivery.ts:75-130` | always creates when none open | suppressed when `opensPullRequest === false` |
| Schema | `packages/db/prisma/schema.prisma` | — | `Task.opensPullRequest`, `TaskTemplateStep.opensPullRequest`, both `Boolean @default(true)` |

### 0.2 Where the code contradicts or under-specifies the spec

These are findings from reading the tree, not restatements of the spec. C1 and
C2 change behaviour the plan must implement; C3–C13 change what the executor
should expect to find.

**C1 — A failed run's WIP salvage records `pushStatus = SUCCEEDED` against the
*shared* branch. The spec's evidence predicate (R8.2) is therefore unsound.**

Chain of anchors, all re-read:

1. `packages/runner/src/delivery.ts:145` — `deliverFailedWorkspace` pushes to
   `agentos/${claim.task.id}/run-${claim.run.runNumber}` (`:164`) and returns
   `{ pushStatus: "SUCCEEDED", pushRemote, headSha, deliveryInstructions }`
   (`:165-170`). **It returns no `branch` field.**
2. `packages/runner/src/runner.ts:262-263` — the completion payload is
   `...gitResult,` then `...(delivery ?? { pushStatus: "NOT_REQUESTED" }),`.
   `gitResult.branch` is `captureWorkspaceResult`'s `git branch --show-current`
   (`workspace.ts:119`), i.e. the workspace branch — the *shared* branch for a
   chain step. The salvage result does not overwrite it.
3. `packages/api/src/app.ts:2762,2765` — the complete route writes
   `branch: body.branch ?? run.branch` and `pushStatus: body.pushStatus`
   verbatim.

So after a failed chain-step run that had trackable changes, the row reads
`branch = agentos/chain/<slug>-<fp>`, `pushStatus = SUCCEEDED` — and nothing was
ever pushed to that ref. The spec's R8.2 test ("some `Run` whose task is in the
same chain has `branch = sharedChainBranch(T)` and `pushStatus = SUCCEEDED`")
matches it. Consequences if implemented as written:

- **S6 becomes unrecoverable.** Step ①'s run-1 fails after the agent wrote a
  file. Salvage pushes to `agentos/<task1>/run-1`, run-1 records the shared
  branch as SUCCEEDED. Step ①'s run-2 now bases on the shared branch,
  `git clone --branch <shared>` fails (`workspace.ts:66`), the run fails during
  provisioning, run-3 does the same, and the chain dies at step ① with no
  operator-visible cause other than "clone failed".
- It is silent in exactly the way §14 warns about: no test that only exercises
  happy paths sees it.

**The fix is one extra predicate, and it is exact rather than heuristic.**
`packages/api/src/app.ts:2744-2749` writes `status = RunStatus.SUCCEEDED` only
when `succeeded`, and `succeeded` (`runner.ts:248`) requires
`executionSucceeded` — which is precisely the condition under which
`deliverFailedWorkspace` does *not* run (`runner.ts:232-236`). Therefore

> `status = SUCCEEDED ∧ pushStatus = SUCCEEDED ∧ branch = X` ⟹ `deliverWorkspace`
> pushed `X` (`delivery.ts:84`, which pushes `workspace.branch`, the same value
> recorded as `Run.branch`).

The evidence query gains `status: RunStatus.SUCCEEDED`. WI-3 implements it,
WI-3's test T3 pins it, and the reasoning above goes in the code as a comment —
without the comment a later reader deletes the predicate as redundant.

**C2 — R11's "or is a per-run branch that a salvage push created" is
unimplementable, and it contradicts R7.** Two independent reasons:

- `Run.branch` never holds the salvage target (C1 step 2). There is no row from
  which the implementation could read that per-run branch, so the clause names a
  value the data layer does not have.
- If it could, honouring it would clone the failed attempt's WIP tree as the
  retry's base while the retry's head is the shared branch — so a successful
  retry pushes the failed attempt's half-finished commits into the chain branch.
  R7 forbids exactly that, in the same spec, and calls it load-bearing.

Resolution: §0.3-D1 drops R8 clause 1 for chain steps entirely.

**C3 — There are no template-step create or patch API routes.** Spec §7.2 lists
"Template step create/patch routes | accept `opensPullRequest` (default `true`)".
Grepping every template route (`app.ts:1271`, `:1276`, `:1283`, `:1312`,
`:1400`, `:1429`, `:1477`, `:1478`, `:1480`, `:570`) finds one mutating route:
`PATCH /task-templates/:templateId` (`app.ts:1283`), which parses
`webhookConfigPatch` and touches webhook configuration only. `TaskTemplateStep`
rows are created in exactly one place in the repo:
`packages/db/prisma/seed.ts:208-212`. So that row of §7.2 has no implementation
target; the column exists and defaults `true`, and setting it per step is a seed
or direct-DB edit. **This batch does not touch the seeded nine-step template**:
its steps already share one branch and therefore already produce one PR through
PR reuse, and changing them would be the template behaviour change §5.7 forbids.

**C4 — `@@unique([chainId, chainIndex])` is global, not per-project**
(`schema.prisma:510`). Spec test 5 / S8 ("two projects, one `chainId`") cannot be
written with `(C, 0)` in both projects — it gets P2002. `chain.dbtest.ts:458-470`
already documents this and works around it by giving the second project's chain
disjoint indices (`11 + offset`). WI-3's test T6 does the same.

**C5 — `packages/db` has no `test` script** (`packages/db/package.json`). The
root `npm test` is `npm run test --workspaces --if-present`, so a unit test
placed in `packages/db` would silently never run. The `sharedChainBranch` unit
test goes in `packages/api/src/chain-branch.test.ts`, which
`packages/api`'s `"test": "node --import tsx --test src/*.test.ts …"` picks up.

**C6 — `chainKey` cannot be imported by `@agentos/db`.** It lives in
`packages/api/src/chain.ts:61` and `@agentos/api` depends on `@agentos/db`, not
the reverse. The key string `` `${projectId}:${chainId}` `` must be written twice.
WI-1 pins the duplication with a test that hashes `chainKey(row)` in the API
package and asserts the fingerprint matches, so the two cannot drift silently.

**C7 — Several line anchors in the spec have drifted.** Corrected, as of
`0f62af2`:

| Spec says | Actually |
|---|---|
| `workflow.ts:117-122` | comment `:117-119`, expression `:120-122`, used at `:132-133` |
| `app.ts:1675-1700` (POST /tasks) | route `:1652-1703`, transaction `:1675-1701`, `run.create` `:1682-1698`, `targetBranch` `:1692` |
| `app.ts:1904` (retry) | `run.create` `:1904-1923`; `targetBranch: last.targetBranch` `:1915`, `branch: last.branch` `:1916` |
| `reconcile.ts:159` | requeue `run.create` `:160-177`; `targetBranch: run.targetBranch` `:171` |
| `delivery.ts:99-104` | `openPullRequest` `:99-105`; `gh pr create` `:109-115` |
| `templates.ts:88-102` | `tx.task.create` `:87-102` |
| `api.ts:17` (`ClaimedTask["task"]`) | `:16-27` |

**C8 — `reconcileDatabaseRuns`'s candidate select omits `branch`**
(`reconcile.ts:94-110`). The requeue cannot even copy the lost run's head today;
any fix must widen the select or load the task. WI-5 loads the task.

**C9 — The retry route does not load `repo`** (`app.ts:1882-1889` includes
`assigneeAgent`, `templateStep`, `runs` only), so it cannot supply
`repo.defaultBranch` to the resolver without widening the include. WI-5 widens it.

**C10 — `POST /tasks` creates the inline run for *any* chain step created with
`scheduleKind = NOW`.** The guard at `app.ts:1680` is
`agent && repo && assigneeType === AGENT && scheduleKind === NOW` — there is no
`chainIndex` predicate, and `scheduleKind` defaults to `NOW` (`app.ts:232`). How
the operator's chain-creation script avoids nine simultaneous runs is not
visible in this repo (§12-G1). The fix does not depend on the answer — every
chain step that gets an inline run must get the shared branch — but the tests
must suppress the inline run deliberately for steps ②③ rather than assuming it
does not happen.

**C11 — Non-chain retry can already base on a ref that was never pushed.**
`workflow.ts:132` and `app.ts:1915` use `prior?.branch` as the base
unconditionally. For a non-chain task whose run-1 never pushed, run-2 clones a
nonexistent `agentos/<taskId>/run-1`. R11's general principle
("`Run.targetBranch` must never name a ref the implementation cannot show
evidence of") would cover it, but R5 and §5.7 require the non-chain and template
paths to be untouched, and §10 puts workspace/retry policy out of scope.
**Left alone deliberately; recorded here so the review step does not read it as
an oversight, and worth a `docs/BACKLOG-V2.md` entry.**

**C12 — `npm run db:migrate` is `prisma migrate dev`** (`packages/db/package.json`),
which needs a shadow database and can offer to *reset* the target when it sees
drift. Pointing it at the live database is the wrong tool. `packages/api/src/testdb.ts:41-46`
already establishes the right one: `prisma migrate deploy`, which is
non-interactive, needs no shadow database, and applies exactly the committed
folders. WI-2 uses `deploy` and hand-writes the migration SQL.

**C13 — `origin/master` is not in this workspace's refs.** `git remote -v` is
`https://github.com/mosonlab/agentos.git`; `git branch -r` lists only
`origin/agentos/cmswjrrz50t5ampyjhpl101mv/run-1`, because the runner clones
`--single-branch` (`workspace.ts:66`). "Rebase onto the latest `origin/master`"
(spec §12.2, §13) needs an explicit `git fetch origin master` first, and the
migration-timestamp check (§13) can only be done after that fetch.

### 0.3 Deliberate deviations from the spec

| # | Spec text | This plan | Why |
|---|---|---|---|
| D1 | R8 clause 1: base = `prior?.branch` for any run | For chain steps, clause 1 is **dropped**; base = shared-with-evidence → `Task.targetBranch` → `repo.defaultBranch`. Template and non-chain paths keep clause 1 verbatim. | C2. The clause is unimplementable as written and contradicts R7. For chain steps it is also redundant: post-change, `prior.branch` *is* the shared branch, so clause 2 gives the same answer in S5, and in S6 clause 2 correctly declines. Mixed chains (§8.2) land on `Task.targetBranch`, which is what §8.2 already says the operator's repair lever is. |
| D2 | R8.2 evidence = `branch = shared ∧ pushStatus = SUCCEEDED` | …`∧ status = SUCCEEDED` | C1. Without it, a failed run's salvage push is mistaken for a push to the shared branch. |
| D3 | §7.2: template step create/patch routes accept `opensPullRequest` | Not implemented | C3. No such route exists. |
| D4 | R6: all four paths produce `Run.branch = sharedChainBranch(...)` via one helper | Reconcile calls the resolver **only when the task is a chain step**; for template and non-chain runs it keeps `targetBranch: run.targetBranch` and no `branch` | The resolver's non-chain answer (`task.targetBranch ?? defaultBranch`) is not byte-identical to reconcile's current copy of the *lost run's* `targetBranch` — they differ if the task's `targetBranch` was edited after the run was created. R5 and §5.7 require no behaviour change off the chain path. R6's requirement (identical `Run.branch` on all four paths for chain steps) still holds. |
| D5 | §7.3: required field so a missing one is a compile error | Required in the type **and** compared with `!== false` at runtime | Both halves of §11-E10. The type catches our own omission; the comparison means a stale API build that omits the field degrades to today's behaviour (opens a PR) rather than to the expensive failure (never opens one). |
| D6 | §12.2 gate list runs `npm run db:migrate` | `prisma migrate deploy` for any real database; the migration SQL is hand-written | C12. |

Nothing else in the spec is changed. A1, A2, A3, A4, A5, A6, A7, A8, A9 are all
adopted as stated.

---

## WI-1 — The derived branch name

**Depends on:** nothing. **Files:**

- new `packages/db/src/chain-branch.ts`
- `packages/db/src/index.ts` (append one `export *`)
- new `packages/api/src/chain-branch.test.ts`

**Change.** A new module, not an addition to `workflow.ts`: it is pure, has no
Prisma dependency, and `workflow.ts` is the hot file of this batch.

```ts
// packages/db/src/chain-branch.ts
import { createHash } from "node:crypto";

/**
 * The single branch every run of every step of one `chainId` chain pushes to.
 *
 * Derived, never stored: a column would be a second source of truth that can
 * disagree with this function, and the very first run of a chain — the one that
 * must create the branch — has no earlier row to read it from.
 *
 * The key is `${projectId}:${chainId}`, the same pair `chainKey`
 * (`packages/api/src/chain.ts`) uses, because that pair is what the platform
 * means by "one chain": `activateChainSuccessor` scopes its successor lookup by
 * both. It is spelled out here rather than imported because `@agentos/api`
 * depends on `@agentos/db` and not the reverse; `chain-branch.test.ts` asserts
 * the two agree.
 *
 * Both halves of the name are load-bearing. The slug is for the operator reading
 * `git branch`; the fingerprint is for correctness, because `chainId` is
 * free-form operator input (`z.string().trim().min(1).max(100)`) that may not be
 * a legal git ref, may collide after slugging, and may be reused by another
 * project — `@@unique([chainId, chainIndex])` does not scope it per project.
 */
export const sharedChainBranch = ({ projectId, chainId }: { projectId: string; chainId: string }): string => {
  const fingerprint = createHash("sha256").update(`${projectId}:${chainId}`).digest("hex").slice(0, 8);
  const slug = chainId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return `agentos/chain/${slug || "chain"}-${fingerprint}`;
};
```

Order matters and is fixed by §5.1: lowercase → replace → strip both ends →
truncate to 24 → strip a trailing `-` the truncation created → substitute
`chain` if empty. The empty check is **after** truncation, not before.

`packages/db/src/index.ts` gains `export * from "./chain-branch.js";` alongside
the three existing re-exports.

**Test** (`packages/api/src/chain-branch.test.ts`, runs under `npm test`; see
§0.2-C5 for why it is not in `packages/db`):

1. Determinism (R3): the same pair twice yields the same string.
2. Ref legality: the result matches `/^agentos\/chain\/[a-z0-9][a-z0-9-]{0,23}-[0-9a-f]{8}$/`
   for the spec's worked example, for a `chainId` full of separators, and for
   `"…"`.
3. E8: `chainId = "…"` yields the literal `chain` slug and still an 8-hex suffix.
4. E9: `"a/b"` and `"a-b"` in one project slug identically and yield **different**
   branches.
5. R2 / S8 at the function level: the same `chainId` in two different
   `projectId`s yields different branches.
6. C6 pin: `createHash("sha256").update(chainKey({ projectId, chainId })).digest("hex").slice(0, 8)`
   — computed in the test from the API package's `chainKey` — equals the
   fingerprint in the returned branch. This is what stops the duplicated key
   string from drifting.

These are edge-case tests of a pure function. The acceptance bar is WI-3's
dbtests, which assert on rows.

**Rollback.** Delete the file and the `export *` line. Nothing imports it until
WI-3.

---

## WI-2 — Schema, migration, and Prisma regeneration

**Depends on:** nothing (may land before or after WI-1; must land before WI-6/WI-7).
**Files:**

- `packages/db/prisma/schema.prisma` (`model TaskTemplateStep` at `:439-458`,
  `model Task` at `:460-520`)
- new `packages/db/prisma/migrations/<timestamp>_chain_opens_pull_request/migration.sql`
- `packages/api/src/migration.dbtest.ts` (append one test)

**Change.** Two columns, both additive, both defaulted, no backfill:

```prisma
model TaskTemplateStep {
  // … after `outputKind`
  opensPullRequest        Boolean      @default(true)
}

model Task {
  // … after `approvalGate`
  opensPullRequest   Boolean          @default(true)
}
```

Migration SQL, hand-written in the house style of
`packages/db/prisma/migrations/20260816180100_tasks_visibility/migration.sql`:

```sql
-- Platform repair — one branch and one PR per chain. Additive only: two
-- defaulted NOT NULL booleans. `ADD COLUMN … DEFAULT true` is metadata-only on
-- PostgreSQL 11+ and rewrites neither table.
--
-- The default is `true` on purpose and is what makes this migration
-- behaviour-preserving: every existing task and template step keeps opening its
-- pull request exactly as before, and a chain creator opts documentation steps
-- *out*. Defaulting to `false` would silently stop PRs for every existing
-- chain-shaped workflow.
--
-- No backfill. Completed documentation steps are not rewritten: they are done,
-- and rewriting them would change what the audit trail says happened.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "opensPullRequest" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "TaskTemplateStep" ADD COLUMN     "opensPullRequest" BOOLEAN NOT NULL DEFAULT true;
```

**Choosing the timestamp — do this, do not guess it.** The latest folder in the
tree is `20260816180100_tasks_visibility`, but the batch-4 fixes chain may land
one on `master` first (spec §13).

```bash
git fetch origin master                                        # C13: not in refs yet
git ls-tree --name-only origin/master packages/db/prisma/migrations/ | tail -5
ls packages/db/prisma/migrations | tail -5
```

Name the folder with a `YYYYMMDDHHMMSS` that sorts strictly after both lists.
`20260817020000_chain_opens_pull_request` is the starting suggestion; if
`master` already carries something later, move past it. Prisma orders by folder
name, so a timestamp that sorts before an already-applied migration makes
`migrate deploy` refuse.

**Applying it.** Do **not** use `npm run db:migrate` (§0.2-C12). Per database:

```bash
npm run db:validate                       # prisma validate, no database needed
npm run db:generate                       # regenerate the client from schema.prisma
# test schema: applied automatically — packages/api/src/testdb.ts runs
#   `prisma migrate deploy` against TEST_DATABASE_URL on the first dbtest
# live database:
cd packages/db && npx dotenv -e ../../.env -- npx prisma migrate deploy
npm run db:drift-check                    # must exit 0; reads DATABASE_URL
```

`db:drift-check` (`packages/db/scripts/check-drift.mjs`) diffs `DATABASE_URL`
against `schema.prisma`, so it only passes once the live database has the
columns. Applying the migration to the live database **before** the restart is
the deploy shape the spec prescribes (§8.1) and is safe: the running API build
does not know the columns and ignores them. **This batch restarts nothing** —
not the API, not the runner, not launchd.

**Test.** Append to `packages/api/src/migration.dbtest.ts`, matching the
`information_schema` style already there (`:16-44`):

```
test("the chain-branch migration installs opensPullRequest on Task and TaskTemplateStep, defaulting to true")
```

asserting, for both tables, that `column_name = 'opensPullRequest'` exists with
`is_nullable = 'NO'` and `column_default = 'true'`. Assert on `column_default`,
not just existence: the default is what makes the migration behaviour-preserving
(A3), and a hand-written SQL file is exactly where that gets dropped.

**Rollback.** Revert the schema hunk, delete the migration folder, and

```sql
ALTER TABLE "Task" DROP COLUMN "opensPullRequest";
ALTER TABLE "TaskTemplateStep" DROP COLUMN "opensPullRequest";
```

Safe in either order; nothing references them and there is no FK. A code-only
rollback (leaving the columns) is also safe — old code ignores them. Delete the
row from `_prisma_migrations` if the folder is removed while the database keeps
the columns, or `migrate deploy` will report the history as diverged.

---

## WI-3 — `resolveRunBranches`, and `enqueueTaskRun` through it

This is the work item the batch turns on. **Depends on:** WI-1. **Files:**

- `packages/db/src/workflow.ts` (`:1-20` imports, `:92-140` `enqueueTaskRun`)
- new `packages/api/src/chain-branch.dbtest.ts`

**Change.** Replace the inline `chainBranch` expression (`:117-122`) and the two
fields that use it (`:132-133`) with one exported resolver, placed immediately
above `enqueueTaskRun`:

```ts
/** The shape `resolveRunBranches` needs. Structural rather than a Prisma payload
 *  type, so the four call sites can pass rows from four differently-shaped
 *  queries — the same reason `packages/api/src/chain.ts` keeps `ChainRow` plain. */
export type RunBranchTask = {
  id: string;
  projectId: string;
  chainId: string | null;
  templateId: string | null;
  targetBranch: string | null;
  repo: { defaultBranch: string };
};

/**
 * Decides a new Run's head (`branch`) and base (`targetBranch`). The only place
 * that decision is made; `enqueueTaskRun`, `POST /tasks`, the retry route and
 * the lost-lease requeue all call this, because four copies of the expression is
 * how step ① ended up on a different branch from steps ②–⑨.
 *
 * Writes at most one TaskActivity row (see the chain branch below), so it takes
 * the caller's transaction.
 */
export const resolveRunBranches = async (
  tx: Tx,
  task: RunBranchTask,
  prior: { branch: string | null } | null,
): Promise<{ branch: string | null; targetBranch: string }> => {
  // Template chains are frozen. This early return is the whole guarantee: the
  // expression below is the pre-existing one, byte for byte, and nothing after
  // this point runs for a template task. `targetBranch !== defaultBranch` is
  // what keeps a template's step ① — whose targetBranch *is* the default
  // (templates.ts:101) — from trying to clone a branch that does not exist yet.
  if (task.templateId) {
    const chainBranch = task.targetBranch && task.targetBranch !== task.repo.defaultBranch
      ? task.targetBranch
      : null;
    return {
      branch: prior?.branch ?? chainBranch,
      targetBranch: prior?.branch ?? task.targetBranch ?? task.repo.defaultBranch,
    };
  }
  if (!task.chainId) {
    return {
      branch: prior?.branch ?? null,
      targetBranch: prior?.branch ?? task.targetBranch ?? task.repo.defaultBranch,
    };
  }

  const shared = sharedChainBranch({ projectId: task.projectId, chainId: task.chainId });
  // "Has any step of this chain actually published the shared branch?"
  //
  // `status: SUCCEEDED` is not redundant with `pushStatus: SUCCEEDED` and must
  // not be removed. A *failed* run whose WIP salvage push succeeded records
  // pushStatus SUCCEEDED with `branch` still set to the workspace branch — the
  // shared branch — while deliverFailedWorkspace actually pushed to
  // `agentos/<taskId>/run-<n>` (delivery.ts:145,164; runner.ts:262-263). Only a
  // run the API marked SUCCEEDED (app.ts:2744-2749, reachable only when
  // executionSucceeded, which is exactly when salvage does not run) is proof
  // that `deliverWorkspace` pushed the branch named in this row.
  //
  // Scoped by (projectId, chainId) and not by chainIndex: that pair is the
  // platform's definition of a chain, so a chainIndex-null row (E1) sharing the
  // chainId counts, which is consistent with it sharing the branch.
  const published = await tx.run.findFirst({
    where: {
      branch: shared,
      pushStatus: PushStatus.SUCCEEDED,
      status: RunStatus.SUCCEEDED,
      task: { projectId: task.projectId, chainId: task.chainId },
    },
    select: { id: true },
  });
  // `prior?.branch` is deliberately not consulted here. Post-change it is always
  // `shared`, so it would give the same answer; pre-change (a chain that spans
  // the restart) it is a per-task branch, and honouring it would quietly keep a
  // mixed chain mixed instead of falling through to the operator's targetBranch,
  // which §8.2 of the spec names as the manual repair lever.
  const targetBranch = published
    ? shared
    : task.targetBranch ?? task.repo.defaultBranch;

  // targetBranch stays writable for chain steps but no longer routes them
  // (R12). Silently ignoring an operator's value is a footgun, so say so once
  // per run — this is how the operator learns hand-repointing is unnecessary.
  if (task.targetBranch && task.targetBranch !== targetBranch) {
    await tx.taskActivity.create({ data: {
      taskId: task.id,
      actorType: "control-plane",
      body: `targetBranch '${task.targetBranch}' is not used for chain steps; this run is based on '${targetBranch}' and pushes to '${shared}'`,
    } });
  }
  return { branch: shared, targetBranch };
};
```

Imports to add at `workflow.ts:1-16`: `PushStatus` from `@prisma/client`
(`RunStatus` is already imported at `:10`) and `sharedChainBranch` from
`./chain-branch.js`.

`enqueueTaskRun` then becomes, at `:117-133`:

```ts
  const branches = await resolveRunBranches(tx, task, prior ?? null);
  return tx.run.create({ data: {
    // …
    targetBranch: branches.targetBranch,
    branch: branches.branch,
    // …
  } });
```

`task` already carries `repo: true` (`:97`) and every other field
`RunBranchTask` needs, so no query change here.

**Two things not to do.** (a) Do not unify the template and chain naming — §5.7
and A2, and the risk is asymmetric: a rename mid-flight strands work on a branch
nobody merges. (b) Do not add a fallback inside `provisionWorkspace` — §10 is
explicit that a missing base ref must fail loudly, and the whole point of
solving this in the data layer is that it is testable without git.

**Tests** — new file `packages/api/src/chain-branch.dbtest.ts`, following
`chain.dbtest.ts`'s harness (`setupTestDb` / `resetTestDb`, the `asOperator`
wrapper at `:357-366`, `createApp(db).request`). `chain.dbtest.ts` itself is
**not modified** (R19); if a change to it ever looks necessary, the change is
wrong. Seed helper: copy `seedExecutableChain`'s shape (`chain.dbtest.ts:16-35`)
but create the chain steps through `POST /projects/:projectId/tasks` where the
test needs the real route, and through `db.task.create` where it needs to
suppress the inline run (§0.2-C10 / §12-G1). Read `repo.defaultBranch` from the
row — never hardcode `master` or `main` (§12-G2).

| # | Test | Asserts |
|---|---|---|
| T1 | *an API-created chain runs on exactly one branch* | Step ① via `POST /tasks` (`chainId`, `chainIndex: 0`, no `targetBranch`), steps ②③ via `db.task.create`. Drive each step: set its run `status: SUCCEEDED, pushStatus: SUCCEEDED`, task `DONE`, call `activateChainSuccessor`. Then `db.run.findMany` over all three tasks → **exactly one distinct `branch`**, equal to a value the test recomputes independently (its own `createHash` over `${projectId}:${chainId}`, not a call to `sharedChainBranch` — a function compared to itself proves nothing). Covers spec tests 1 and 4, S1, R6. |
| T2 | *base branch follows the chain, not the task* | Same chain: ①'s `targetBranch === repo.defaultBranch`; ②'s and ③'s `=== shared`. Covers spec test 2, S4, R8. |
| T3 | *a failed run's salvage push is not evidence that the shared branch exists* | Step ①'s run-1 written as `status: FAILED, pushStatus: SUCCEEDED, branch: <shared>` — precisely what the runner records after a WIP salvage (§0.2-C1). Advance to step ②; assert ②'s `targetBranch === repo.defaultBranch`, **not** `<shared>`. This test is the reason D2 exists; its comment must say so. Covers S6, R11, E1. |
| T4 | *the first step of a chain that has published nothing bases on the default* | Step ① run-1 `status: FAILED, pushStatus: FAILED`; retry; run-2 `targetBranch === repo.defaultBranch` and `branch === shared`. Covers S6. |
| T5 | *two projects sharing one chainId get two branches* | Two projects, same `chainId`, **disjoint `chainIndex` ranges** (§0.2-C4 — `(C,0)` twice is a P2002). Assert the two chains' runs carry different branches and that neither project's evidence query sees the other's runs. Covers spec test 5, S8, R2. |
| T6 | *a template chain still uses `agentos/<chainId>`* | `instantiateTemplate` with no variables → every run's `branch === agentos/<chainId>`, step ①'s `targetBranch === repo.defaultBranch`, later steps' `=== agentos/<chainId>`. Then again with `variables: { branchName: "custom/branch" }` → `branch === "custom/branch"`. Asserts the derived name did **not** leak. Covers spec test 9, S7, R20, and templates.ts `:76`/`:101`/`:110`. |
| T7 | *an operator's targetBranch on a chain step is ignored, and recorded* | Step ⑦-shaped task with `targetBranch = "agentos/<some-task-id>/run-1"`, shared branch already published. Assert base `=== shared` and that exactly one `TaskActivity` row on that task matches `/is not used for chain steps/`. Covers S9, R12, R13. |
| T8 | *a chainId row with a null chainIndex gets the chain's branch* | E1-shaped row, `chainIndex: null`; `POST /tasks/:id/start` or `enqueueTaskRun`; assert `branch === shared` for that `(projectId, chainId)`. Covers R4, S10. |

**T1 carries the composition comment**, verbatim in spirit from spec §12.1, so a
later reader knows why no test asserts a PR count:

> Exactly one PR per chain is proven by composition, not by a test — no test in
> this repo may call GitHub. One branch per chain (this test) × `deliverWorkspace`
> reuses any open PR on that head (`delivery.test.ts`, "a chain step reuses the
> open pull request on its shared head branch") × a step with
> `opensPullRequest = false` never calls `gh pr create` (`delivery.test.ts`)
> ⇒ at most one `gh pr create` per chain, and one open PR per head is a GitHub
> invariant.

**Rollback.** Revert `workflow.ts` to the inline expression and delete
`chain-branch.dbtest.ts`. **Trap, and it is the mirror of §8.2:** a chain that is
mid-flight on a shared branch reverts to per-task branches for its remaining
steps, so step N+1 bases on `targetBranch`/`master` and **will not contain step
N's work**. Drain or park in-flight chains before reverting. The runbook (WI-8)
carries this.

---

## WI-4 — `POST /tasks` gives the first run the chain branch

**Depends on:** WI-3. **Files:** `packages/api/src/app.ts` (`:1675-1701`).

**Change.** Inside the existing transaction, between `created` and the
`tx.run.create`, resolve the branches and use them:

```ts
      if (agent && repo && body.assigneeType === AssigneeType.AGENT && schedule.scheduleKind === ScheduleKind.NOW) {
        const runner = runnerFor(agent.runnerPreference, agent.model);
        // This run is built inline rather than through enqueueTaskRun, so it is
        // the one path a chain fix can miss. Missing it puts step ① on a
        // per-task branch while ②–⑨ share the chain branch — i.e. step ①'s work
        // silently absent from the tree every later step reviews.
        const branches = await resolveRunBranches(tx, { ...created, repo }, null);
        await tx.run.create({
          data: {
            // …
            targetBranch: branches.targetBranch,
            branch: branches.branch,
            // …
          },
        });
      }
```

`created` is the freshly-inserted `Task` row and carries `projectId`, `chainId`,
`templateId`, `targetBranch`; `repo` is already in scope from `:1660`. `prior` is
`null` — run 1 by construction.

The pre-change `targetBranch: body.targetBranch ?? repo.defaultBranch` (`:1692`)
is subsumed: for a non-chain task the resolver returns
`task.targetBranch ?? repo.defaultBranch`, and `created.targetBranch` is
`body.targetBranch` (`taskInput` defaults it to `null` at `:225`, and
`withoutUndefined` keeps `null`). Same value.

Import `resolveRunBranches` from `@agentos/db` alongside the existing
`runnerFor` / `deriveRunConfig` imports.

**Test.** WI-3's T1 already covers the happy path through this route. Add to
`chain-branch.dbtest.ts`:

- *a non-chain task's first run is unchanged*: `POST /tasks` with no `chainId`
  and an explicit `targetBranch` → run 1 has `branch === null` and
  `targetBranch === <the posted value>`; and with no `targetBranch` →
  `targetBranch === repo.defaultBranch`, `branch === null`. This is the
  regression pin for R5/E12 on the path most likely to be broken by the edit.

**Rollback.** Restore the two literal fields. Independent of WI-3's revert only
if WI-3 stays — if `resolveRunBranches` is removed, this must be reverted too.

---

## WI-5 — Retry and lost-lease requeue

**Depends on:** WI-3. **Files:** `packages/api/src/app.ts` (`:1873-1930`),
`packages/api/src/reconcile.ts` (`:87-181`).

**Change A — retry (`POST /tasks/:taskId/retry`).** Widen the include at
`:1882-1889` to add `repo: true` (§0.2-C9), then replace `:1915-1916`:

```ts
      const branches = await resolveRunBranches(tx, task, last);
      const run = await tx.run.create({ data: {
        // …
        targetBranch: branches.targetBranch,
        branch: branches.branch,
        // …
      } });
```

`task.repoId` may be null on this route (`:1910` passes `repoId: task.repoId`),
so `task.repo` may be null. Guard: if `!task.repo`, keep today's
`targetBranch: last.targetBranch, branch: last.branch`. A task with no repo
cannot be a chain step with a branch anyway, and this route already tolerates a
null `repoId`.

For chain steps this changes retry from "inherit whatever run-1 had" to "recompute",
which is what makes S5 correct after a mixed-chain restart and what makes T4's
fallback work. For template and non-chain tasks the resolver's clause-1 branch
returns `prior?.branch` — the same value `last.branch` gave — so behaviour is
unchanged.

**Change B — requeue (`reconcileDatabaseRuns`).** Add `branch: true` to the
candidate select (`:94-110`, §0.2-C8), then before the `run.create` at `:160`:

```ts
        // Chain steps recompute; everything else copies the lost run's base
        // verbatim, because the resolver's non-chain answer reads the *task's*
        // current targetBranch and the lost run's may predate an operator edit.
        const task = await tx.task.findUnique({
          where: { id: run.taskId },
          select: { id: true, projectId: true, chainId: true, templateId: true, targetBranch: true, repo: { select: { defaultBranch: true } } },
        });
        const branches = task?.chainId && !task.templateId && task.repo
          ? await resolveRunBranches(tx, { ...task, repo: task.repo }, null)
          : { branch: run.branch, targetBranch: run.targetBranch };
```

and use `targetBranch: branches.targetBranch, branch: branches.branch` in the
`run.create`. `prior` is `null` deliberately: for chain steps the resolver
ignores it, and passing the lost run would be misleading.

This is deviation D4 — read it before simplifying the conditional away.

**Tests** (in `chain-branch.dbtest.ts`):

| # | Test | Asserts |
|---|---|---|
| T9 | *a retry lands on the shared branch* | Chain of ≥2 steps, shared branch published by step ①. Step ②'s run-1 → `FAILED`; `POST /tasks/:id/retry`; run-2 has `branch === shared` and `targetBranch === shared`. Covers spec test 3, S5, R10. |
| T10 | *a lost-lease requeue keeps the shared branch* | Chain-step run in `RUNNING` with `leaseExpiresAt` in the past and no recent `heartbeatAt`; call `reconcileDatabaseRuns(db, now)`; the requeued run has `branch === shared` and `targetBranch === shared` (published) or `=== repo.defaultBranch` (not published). Covers R6 row 4, E11. |
| T11 | *a non-chain requeue is unchanged* | Non-chain run with `targetBranch: "some/branch"`, `branch: null`, lost lease → requeued run has the same `targetBranch` and `branch === null`. The regression pin for D4. |

**Rollback.** Restore `targetBranch: last.targetBranch, branch: last.branch` and
`targetBranch: run.targetBranch`; the widened `include`/`select` may stay
harmlessly or be reverted with them.

---

## WI-6 — `opensPullRequest` through the API

**Depends on:** WI-2. **Files:** `packages/api/src/app.ts` (`:203-244`),
`packages/api/src/templates.ts` (`:87-102`).

**Change A — one line of Zod buys both routes.** Add to `taskFields`
(`app.ts:203-219`):

```ts
  opensPullRequest: z.boolean(),
```

and to `taskInput` (`:220-242`), alongside the other defaults:

```ts
  opensPullRequest: taskFields.opensPullRequest.default(true),
```

`taskPatch` (`:243`) is `z.object(taskFields).partial()`, so `PATCH /tasks/:id`
accepts the field automatically, and both routes write it through
`withoutUndefined(body)` (`:1677`, `:1815`). `GET /tasks/:id` and `GET /tasks`
return whole task rows, so the field rides along with no route change (§7.2).
A `PATCH` takes effect on the next run created, not on one already queued —
nothing reads the field until delivery.

**Change B — the template copies it onto the task.** In `templates.ts`, inside
`tx.task.create` (`:87-102`), add:

```ts
            opensPullRequest: step.opensPullRequest,
```

Existing template step rows default `true`, so every template chain behaves
exactly as today (§5.7). **Do not add `opensPullRequest` to the seeded nine-step
template** (`packages/db/prisma/seed.ts:194-212`): template chains already share
one branch and therefore already produce one PR through reuse, and changing them
is the behaviour change §5.7 forbids. §7.2's "template step create/patch routes"
row has no target — §0.2-C3.

**Change C — nothing in `apps/web`.** `apps/web/src/components/new-task-panel.tsx:50`
posts a fixed field set and `apps/web/src/lib/types.ts` describes responses
structurally, so an extra field neither breaks the POST (it defaults) nor the
render. Surfacing a checkbox is out of scope (§10, Q1).

**Tests** (in `chain-branch.dbtest.ts`):

| # | Test | Asserts |
|---|---|---|
| T12 | *opensPullRequest defaults to true and round-trips* | `POST /tasks` with no field → row is `true`; with `false` → `false`; `PATCH` flips it; `GET /tasks/:id` returns it. Covers R14, A3. |
| T13 | *an instantiated template copies the step's flag* | Template with step 2 set to `opensPullRequest: false` (written with `db.taskTemplateStep.update`, since no route exists) → the instantiated task 2 is `false` and the others `true`. Covers §7.2 row 4. |

**Rollback.** Remove the two Zod lines and the one `templates.ts` line. The
columns may stay (old code ignores them) — see WI-2 for dropping them.

---

## WI-7 — The runner: push always, create a PR only when told to

**Depends on:** WI-2 (the field must exist on the claimed task row).
**Files:** `packages/runner/src/api.ts` (`:16-27`),
`packages/runner/src/delivery.ts` (`:60-130`, `:132-137`),
`packages/runner/src/delivery.test.ts`.

**Change A — the type.** `ClaimedTask["task"]` gains, **required**:

```ts
    opensPullRequest: boolean;
```

Required and not optional, so a path in our code that forgets it is a compile
error rather than a silent `undefined → falsy → never open a PR` (§7.3, E10).
No query change is needed: the claim route returns the whole task row
(`app.ts:2295`, `:2394`).

**Change B — delivery.** In `deliverWorkspace` (`:75-130`):

```ts
const noPullRequest = (branch: string, remote: string): DeliveryResult => ({
  pushStatus: "SUCCEEDED",
  pushRemote: remote,
  deliveryInstructions: `Branch '${branch}' was pushed. This step does not open a pull request.`,
});
```

and inside the function, immediately after `const remote = …`:

```ts
  // `!== false`, not a truthiness test, and the difference is the whole point.
  // The field is required in ClaimedTask so our own code cannot omit it; the
  // comparison is what makes a *stale API build* that omits it from the claim
  // payload degrade to today's behaviour (open the PR) instead of to the
  // expensive failure (never open one again, silently). No step name, output
  // kind or task name is consulted here or anywhere in this package.
  const opensPullRequest = claim.task.opensPullRequest !== false;
```

Then three edits, all after the push at `:84` (the push is unconditional — a
`false` step still publishes the branch, which is what lets the *next* step
clone it):

1. `:90` — `if (!repo) return opensPullRequest ? manual(...) : noPullRequest(workspace.branch, remote);`
2. `:94` — the `gh --version` catch: same conditional. Both are E4: the message
   must read "does not open a pull request", never "open a pull request
   manually", when the step was never meant to open one.
3. `:106-119` — keep the `openPullRequest()` lookup **before** the flag check, so
   a documentation step running after the implementation step still reports the
   chain's PR on its gate card and in `GET /tasks/:id` (R16, A9). Only creation
   is suppressed:

```ts
    const existing = await openPullRequest();
    if (existing) return { pushStatus: "SUCCEEDED", pushRemote: remote, pullRequestUrl: existing.url, pullRequestNumber: existing.number };
    if (!opensPullRequest) return noPullRequest(workspace.branch, remote);
    await command("gh", ["pr", "create", …]);
```

**Change C — one comment, load-bearing.** On `deliverFailedWorkspace` (`:132-136`),
extend the existing docblock:

```
 * The per-run branch here is deliberate and is now load-bearing: a failed run's
 * half-finished tree must never enter the chain's shared branch, which every
 * later step of the chain clones. Never change this to workspace.branch.
 *
 * Note what this function does *not* control: the completion payload still
 * reports `Run.branch` as the workspace branch (runner.ts), so a salvaged run
 * looks like a successful push to the shared branch in the database. The base-
 * branch resolver in @agentos/db compensates by also requiring the run's
 * status to be SUCCEEDED — see resolveRunBranches.
```

That cross-reference is the only thing that will stop a future reader from
"cleaning up" the `status: SUCCEEDED` predicate in WI-3.

**Tests** (append to `packages/runner/src/delivery.test.ts`; the existing six
tests stay **unmodified**, and the fact that they pass is itself the D5
regression pin — their `claim` fixture at `:9-13` omits `opensPullRequest`, so
they prove an omitted field still opens a PR):

| # | Test | Asserts |
|---|---|---|
| T14 | *a step that does not open pull requests still pushes* | `task: { …, opensPullRequest: false }`, `gh pr list` returns `[]`. Recorded calls contain `git push --set-upstream origin feature/test` and `gh pr list …`, and contain **no** `gh pr create`. `pushStatus === "SUCCEEDED"`. Covers spec test 6, S3, R16. |
| T15 | *…and says so instead of failing* | Same claim: `pullRequestUrl === undefined`, `deliveryInstructions` matches `/Branch 'feature\/test' was pushed/` and `/does not open a pull request/`. Covers spec test 7, R17. |
| T16 | *a late documentation step reports the chain's existing PR* | `opensPullRequest: false`, `gh pr list` returns one PR → `pullRequestNumber === 7`, no `gh pr create`. Covers R16 row 2, A9. |
| T17 | *no gh, no PR by design* | `opensPullRequest: false` and `gh --version` throwing → `deliveryInstructions` matches `/does not open a pull request/` and **not** `/manually/`. Covers E4. |

**Rollback.** Revert `delivery.ts` and the one type line. Note the asymmetry: a
runner rolled back while the API still sets `opensPullRequest = false` on
documentation steps will open a PR per step again — noisy, not destructive.
A runner rolled *forward* against an old API is the E10 case, and D5 makes it
degrade to today's behaviour.

---

## WI-8 — Rollback runbook

**Depends on:** WI-2..WI-7 landing, so the commit list is real. **Files:** new
`docs/runbooks/platform-chain-branch-and-pr-rollback.md`.

Follow `docs/runbooks/batch-2.5-rollback.md`'s shape: deploy order → the traps →
code-only rollback → schema rollback in reverse → what is lost. It must contain,
and a reviewer should check for, all seven:

1. **Deploy order**, matching WI-2: `db:validate` → `db:generate` →
   `prisma migrate deploy` → `db:drift-check` → `npm run build` → *the operator
   restarts the API and the runner at a time of their choosing*. State plainly
   that this batch's runbook restarts nothing and touches no launchd service,
   and that the migration is safe to apply before the restart because the old
   build ignores both columns.
2. **The exact revert**: the commit SHAs of WI-1..WI-7 once they exist, the files
   (`packages/db/src/chain-branch.ts`, `packages/db/src/workflow.ts`,
   `packages/api/src/app.ts`, `packages/api/src/templates.ts`,
   `packages/api/src/reconcile.ts`, `packages/runner/src/api.ts`,
   `packages/runner/src/delivery.ts`), and the migration folder name.
3. **Schema rollback**, exactly the two `DROP COLUMN` statements from WI-2, with
   "safe in either order; nothing references them; a code-only rollback is also
   safe".
4. **The mixed-chain trap, in both directions.** Forward (§8.2): a chain that
   spans the restart is mixed, its already-created runs keep their per-task
   branches, and **it is finished by hand — this batch is only correct for chains
   created after the restart**. Backward: after a code-only rollback, a chain
   mid-flight on a shared branch reverts to per-task branches for its remaining
   steps, so step N+1 will not contain step N's work. Both say: **drain, or park
   the remaining steps in `BACKLOG`, before restarting or rolling back.**
5. **The detection query** for mixed chains, verbatim from spec §8.2 (it uses
   lowercase status literals `('todo','doing','backlog')`, which is correct —
   `TaskStatus` is `@map`-ed to lowercase in `schema.prisma:74-78` and its
   siblings).
6. **The manual PR recovery** (R18, E6), one line:
   `gh pr create --base master --head agentos/chain/<slug>-<fingerprint> --title '<chain name>'`,
   with the note that there is no automatic promotion and why (A4).
7. **The stale-runner note** (E10): a runner binary older than the API omits
   `opensPullRequest` from its handling; D5 makes that degrade to opening a PR,
   which is noisy rather than lossy.

Plus, since it is where an operator will look for it: **how to compute a chain's
branch by hand**, so they can find it without the API —
`printf '%s' "<projectId>:<chainId>" | shasum -a 256 | cut -c1-8` and the slug
rule from §5.1.

**Check.** No test. Reviewed by reading: the seven items above, and
`grep -c OPERATOR_TOKEN docs/runbooks/platform-chain-branch-and-pr-rollback.md`
returns 0.

**Rollback.** Delete the file.

---

## WI-9 — Rebase, gates, and the manual checklist

**Depends on:** everything. **Files:** none (verification only).

```bash
git fetch origin master                 # C13 — not in this workspace's refs
git rebase origin/master
# re-check the migration timestamp still sorts last (WI-2) after the rebase
npm run build
npm test                                # full workspace suite
npm run test:db                         # @agentos/api dbtests — where the chain assertions live
npm run typecheck
npm run db:drift-check                  # must exit 0
```

All five green **after** the rebase, not before — batch 1 and the batch-4 fixes
chain are in flight and both may touch `packages/api/src/app.ts` (spec §13). The
diff must stay inside `workflow.ts`, `chain-branch.ts`, `templates.ts`, the
task-creation / retry / claim regions of `app.ts`, `reconcile.ts`,
`packages/runner/src/{api,delivery}.ts`, the schema + migration, tests, and the
runbook.

Then the §12.3 manual checklist, each with the command that answers it:

| Check | Command | Expected |
|---|---|---|
| The per-run branch pattern survives only where it should | `grep -rn 'run-\${' packages/runner/src` | two hits: `workspace.ts:68` (the fallback) and `delivery.ts:145` (salvage, R7) |
| No step-name / output-kind / task-name matching decides PR creation | `grep -rn 'stepName\|outputKind\|task.name' packages/runner/src` | no hit inside `deliverWorkspace`'s decision path; `pullRequestTitle` (`delivery.ts:67-73`) reads `task.name` for the *title*, which is A5 and is fine |
| The derived function is used, not re-implemented, on all four paths | `grep -rn 'resolveRunBranches\|sharedChainBranch' packages` | `chain-branch.ts` (definition), `workflow.ts` (definition + `enqueueTaskRun`), `app.ts` ×2, `reconcile.ts` ×1, tests |
| `chain.dbtest.ts` is untouched | `git diff origin/master -- packages/api/src/chain.dbtest.ts` | empty (R19) |
| No secret in the diff | `git log -p origin/master..HEAD \| grep -n 'OPERATOR_TOKEN'` | only the test-local literal `"operator-db-token"` in dbtest helpers, never a real value |

**Rollback.** N/A.

---

## 10. Coverage — every spec requirement to a work item

| Spec | Work item |
|---|---|
| R1, R2, R3 branch name / fingerprint / pure function | WI-1 |
| R4, R5 chainIndex-null row; non-chain unaffected | WI-3 (T8), WI-4 (non-chain pin) |
| R6 all four run-creating paths | WI-3 (`enqueueTaskRun`), WI-4 (`POST /tasks`), WI-5 (retry, reconcile) |
| R7 salvage stays on the per-run branch | WI-7 change C (comment); pinned by the unmodified `delivery.test.ts` salvage tests |
| R8 base-branch rule | WI-3 (with D1, D2) |
| R9 step ⑥ automatically on ⑤'s tree; prose retirement recorded | WI-3 (T2 proves it); WI-8 records the retirement note (Q2) |
| R10, R11 retries | WI-5 (T9), WI-3 (T3, T4) |
| R12, R13 `targetBranch` afterwards + the activity row | WI-3 (T7) |
| R14 the new field, default `true` | WI-2, WI-6 (T12) |
| R15 runner decides from the field alone | WI-7; §9 checklist row 2 |
| R16, R17 delivery by flag | WI-7 (T14–T16) |
| R18 no promotion; manual recovery | WI-8 item 6 |
| R19 `chain.dbtest.ts` unmodified | WI-3 (new file), §9 checklist row 4 |
| R20 template chains frozen; the five load-bearing behaviours | WI-3 (early return), WI-6 change B (seed untouched), T6 |
| S1–S10 | T1 (S1), composition comment (S2), T14/T15 (S3), T2 (S4), T9 (S5), T3/T4 (S6), T6 (S7), T5 (S8), T7 (S9), T8 (S10) |
| E1–E12 | T3 (E1), T1 (E2 — a chain whose first step commits nothing still publishes), unmodified push path (E3), T17 (E4), unmodified `--state open` (E5), WI-8 (E6), untouched `parkedReason` (E7), WI-1 tests (E8, E9), WI-7 type + D5 + WI-8 item 7 (E10), T10 (E11), WI-4 pin + T12 (E12) |
| §7.1 schema | WI-2 |
| §7.2 API surface | WI-6 (rows 1,2,3,4,6,7); row 5 has no target — §0.2-C3 / D3 |
| §7.3 runner | WI-7 |
| §7.4 `@agentos/db` | WI-1, WI-3 |
| §7.5 web keeps compiling | WI-6 change C; proven by `npm run build` in WI-9 |
| §8 migration and in-flight chains | WI-2, WI-8 items 1, 4, 5 |
| §9 rollback runbook | WI-8 |
| §12.1 tests 1–9 | T1+T4-of-WI-4 (1), T2 (2), T9 (3), T1 (4), T5 (5), T14/T16 (6), T15 (7), §9 checklist row 4 (8), T6 (9) |
| §12.2 gates | WI-9 |
| §12.3 manual checklist | WI-9 |

Spec §10's out-of-scope list is respected in full: no step/agent/model change, no
approval-gate work (the 「闸门消息永远关不掉」 defect is **not** touched — do not
fold it in), no change inside `provisionWorkspace`, no edit to the operator's
chain-creation script, no web UI, no GitHub write beyond `gh pr create`, no
concurrency work.

---

## 11. Order of operations

WI-1 and WI-2 are independent and may land in either order; everything else is a
chain.

```
WI-1 (pure fn) ─┐
                ├─→ WI-3 (resolver + enqueueTaskRun) ─→ WI-4 (POST /tasks) ─→ WI-5 (retry + reconcile) ─┐
WI-2 (schema) ──┤                                                                                       ├─→ WI-8 (runbook) → WI-9 (rebase + gates)
                └─→ WI-6 (API field + template copy) ─→ WI-7 (runner) ───────────────────────────────────┘
```

Two ordering rules that are not just convenience:

- **WI-2 before WI-6 and WI-7.** `opensPullRequest` does not exist on the Prisma
  client until the schema lands and `db:generate` runs, so those two do not
  compile before it.
- **WI-3 before WI-4 and WI-5.** All three call the same function; landing a
  caller first leaves the tree not compiling.

There is no intermediate state in which a partial merge is *dangerous* — the API
is not restarted by this batch, so none of it takes effect until the operator
rebuilds (spec §14.1). The reason to keep the order anyway is that each commit
should build and test green on its own.

---

## 12. What this plan is guessing

- **G1 — How the operator's chain-creation script stops nine tasks from running
  at once.** `POST /tasks` creates the inline run for any chain step with
  `scheduleKind = NOW` and there is no `chainIndex` guard (§0.2-C10); the script
  is outside this repo. The fix is independent of the answer, but the tests must
  suppress the inline run for steps ②③ deliberately (they use `db.task.create`,
  the same thing `chain.dbtest.ts:16-35` does). If the answer turns out to be
  "the script posts every step with `NOW`", there is a *separate* pre-existing
  defect — nine concurrent runs on one branch, whose second push is rejected as
  non-fast-forward (spec §10) — that this batch does not fix and that a reviewer
  should route to the backlog rather than into this diff.
- **G2 — The repo's default branch.** The spec and the runbook say `master`;
  `schema.prisma:316` defaults `Repo.defaultBranch` to `"main"`. Tests must read
  `repo.defaultBranch` from the row and never hardcode either.
- **G3 — The migration timestamp.** Cannot be fixed until `git fetch origin master`
  shows what the batch-4 chain has landed (§0.2-C13). WI-2 gives the procedure
  rather than the value.
- **G4 — Query cost of the evidence lookup.** `Run` has no index on `branch` or
  `pushStatus` (`schema.prisma:693-700`), so `resolveRunBranches`'s `findFirst`
  is a scan joined to `Task`. At dogfood volume this is microseconds and an
  index is a second migration and a table lock for no measured benefit. If `Run`
  ever grows past ~10⁵ rows, `@@index([branch])` is the fix. Recorded, not done.
- **G5 — Whether `deliverWorkspace`'s PR base should be the chain's base rather
  than `repo.defaultBranch`.** `delivery.ts:111` passes
  `--base claim.repo.defaultBranch` unconditionally. For a chain based on the
  repo default that is correct; for a chain the operator based on some other
  branch via `Task.targetBranch`, the PR would target the default anyway. The
  spec does not mention it and A5 keeps PR shaping out of this batch. **Left
  unchanged**; flagged so the review step can rule on it rather than discover it.
- **G6 — Whether the R13 activity row is too chatty.** It fires once per run for
  any chain step whose `Task.targetBranch` differs from the computed base —
  which, for a chain created by today's script (every step pointed at step ①'s
  branch), is *every step*. That is the intended signal (it is how the operator
  learns to stop repointing), but if it proves noisy the cheap fix is to emit it
  only when `task.targetBranch` is neither the base nor the shared branch.

---

## 13. Open questions

Neither blocks implementation; both are recorded here and in the task activity
log so they are not lost.

- **Q1 (from spec §16).** Should `opensPullRequest` be surfaced in the web task
  form and a template step editor? Out of scope here (§10). Note that a template
  step editor does not exist at all today (§0.2-C3), so "surface it" is really
  "build the route first" — a backlog entry, not a tweak.
- **Q2 (from spec §16).** The "branch self-healing" prose in steps ⑦⑧ of the
  chain-creation script becomes dead weight once one chain runs green on a shared
  branch (R9). Retiring it is a change to the operator's script, not to this repo.

---

## 14. The constraint that applies to whoever executes this plan

Restated from spec §14, because it governs every work item above:

1. **These changes do not take effect for this chain.** The API is long-lived and
   picks up new code only on a rebuild and restart, which is deliberately held.
   The steps of this very chain will keep opening sibling branches and sibling
   PRs while the fix sits in the tree. **Do not "fix" anything because they did**,
   and do not read this chain's own branches as evidence that the batch failed.
2. **A defect here does not fail loudly.** It silently mis-delivers every future
   chain's work — a step that pushes to the wrong branch loses that work as far
   as the merger is concerned. Weigh a false green as more expensive than usual;
   that is why every acceptance test in §10 asserts on a row or a recorded
   command rather than on a returned string.
3. **Never restart the runner, the API, or any launchd service, and never merge
   anything.** To observe chain behaviour, use the dbtests against the dedicated
   test schema (`packages/api/src/testdb.ts`, which refuses a `public` schema).
   Never point a second API process at the live database or at any copy of it: a
   second control plane classifies the live runs as orphans and deletes their
   workspaces, `.git` included, mid-task. That destroyed a workspace on
   2026-08-16.
4. **No artifact, commit message or task output may contain `OPERATOR_TOKEN`'s
   value.** The dbtest helpers set the environment variable to the literal
   `"operator-db-token"`; that is a test fixture and is fine.
