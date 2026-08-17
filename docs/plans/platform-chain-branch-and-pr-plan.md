# PLAN — Platform repair: one branch and one pull request per chain

Status: **revision 1** — addresses the consolidated plan review (chain step ③).
Author: plan agent (chain step ④) · Date: 2026-08-16
Spec: `docs/specs/platform-chain-branch-and-pr.md` (approved, commit `0f62af2`)
Revision 0 of this plan: commit `87ca48f`.

Plan verified against the working tree at commit `87ca48f` (spec `0f62af2` plus
revision 0 of this file). **Every file, line anchor, schema field and query
quoted below was re-read in the source**, both when writing revision 0 and again
when writing revision 1 — every review finding was reproduced in the code before
its remedy was planned, and two of them turned out to be worse or differently
caused than the review said (§0.1 rows MF3 and MF6).

**Eleven work items, in dependency order, one commit each for WI-1..WI-9 and
WI-11, on one branch, landing as one PR with one migration folder. WI-10 is a
verification stage and carries no commit.** Every spec requirement maps to a
numbered work item in §10. §0.1 is the review-finding ledger, §0.2 is the change
in one table, §0.3 is where the code contradicts or under-specifies the spec,
§0.4 is the list of deliberate deviations from the spec text, §12 is what this
plan is still guessing about.

Planning only. This plan implements nothing.

---

## 0. Approach summary

- **One pure function, one async resolver, five call sites.** `sharedChainBranch`
  (WI-1) is a pure `(projectId, chainId) → string`. `resolveRunBranches` (WI-3)
  is the *only* place that decides a run's `branch` and `targetBranch`; the
  **five** run-creating paths call it instead of each holding a copy of the
  expression. Revision 0 said four and missed the automatic retry inside the
  completion transaction — see §0.1-MF1, which is the same class of defect this
  whole batch exists to fix.
- **Branch publication is recorded as a fact, not inferred from status fields.**
  A new nullable `Run.pushedBranch` records the ref a run actually pushed, on
  both delivery paths. The base-branch resolver reads that column and nothing
  else. Revision 0 tried to infer publication from `status ∧ pushStatus`; that
  inference is unsound in *two* directions (§0.3-C1 and §0.3-C2) and the second
  one wedges a chain permanently. This is the plan's one substantive addition to
  the spec's schema and §0.4-D2 justifies it against R3/§7.1.
- **The template branch is not touched, and the way it is not touched is a
  first-line early return.** `resolveRunBranches` returns today's expression
  verbatim when `task.templateId` is set, before it computes anything, queries
  anything or writes anything. That is what makes S7/R19/R20 a property of one
  `if` rather than of the whole function's care.
- **Schema before code (WI-2), because the new fields do not typecheck until
  Prisma is regenerated.** Four additive columns, one migration folder, no
  backfill, `DROP COLUMN` reversal.
- **The runner decides from one field with an explicit `!== false`.** The field
  is required in `ClaimedTask` so an omission in our code is a compile error
  (§7.3); the runtime comparison is against `false` specifically so a *stale API*
  that omits the field keeps today's behaviour instead of silently never opening
  a PR, which §11-E10 names as the expensive failure. It is read from the run's
  snapshot, not the live task row, because the spec promises a `PATCH` does not
  change an already-queued run (§0.4-D7). No step-name matching anywhere (R15).
- **Tests assert on the artifact.** Every acceptance test asserts the `Run.branch`
  / `Run.targetBranch` rows a real API call produced — including, now, a real
  `POST /runner/runs/:runId/complete` rather than a hand-written row (§0.1-MF1) —
  or the recorded command list a fake `CommandExecutor` captured. Never "the
  function returned the string I expected". The one unit test of the pure
  function (WI-1) exists for the slug/fingerprint edge cases E8/E9 and is
  labelled as edge-case coverage, not as the acceptance bar.

### 0.1 Review-finding ledger

Every finding from the consolidated plan review, its verification against the
tree, and what revision 1 does about it. **No finding is dropped.** Two are
adopted with a modified remedy, and both modifications are argued here rather
than applied silently.

| # | Finding | Verified? | Resolution |
|---|---|---|---|
| **MF1** | A fifth run creator — the automatic retry inside the completion transaction — is not routed through the resolver | **Confirmed.** `packages/api/src/app.ts:2792-2811`: `if (!succeeded && retryable && run.task && run.runNumber < budgetCeiling)` creates a run with `targetBranch: run.targetBranch` (`:2804`) and **no** `branch`. After the change, a retryable failed chain run yields a successor whose null branch falls back to `agentos/<taskId>/run-<n>` (`workspace.ts:65-69`). | **Adopted in full.** New **WI-6** routes it through `resolveRunBranches`; the inventory everywhere in this plan now says *five* paths; **T13** drives a real failed retryable completion through the route and asserts the automatically created run's `branch` and `targetBranch`; **T14** pins the non-chain path unchanged. T1 and T3 are rewritten to drive real completions rather than mutate rows (spec §12.1 asks for exactly that). |
| **MF2** | Publication evidence is chain-scoped but not repo-scoped | **Confirmed.** `Run.repoId` exists and is indexed (`schema.prisma:630`, `:685`); spec R2 (`spec:157-161`) explicitly allows one chain's steps to sit on different repos and says those refs do not interact; `provisionWorkspace` clones the claim's own `repo.remoteUrl` (`workspace.ts:65-66`). The revision-0 query filtered on branch + `(projectId, chainId)` only. | **Adopted in full.** `RunBranchTask` gains `repoId: string \| null`; the evidence query requires `repoId: task.repoId`; a null `repoId` short-circuits to "no evidence". **T15** is a two-repo/one-chain test proving each remote needs its own successful-push evidence. |
| **MF3** | `status = SUCCEEDED ∧ pushStatus = SUCCEEDED` cannot represent "push succeeded, PR work failed"; and the `false` path can fail a documentation step after its push | **Confirmed, and worse than stated.** `delivery.ts:84` pushes first; the catch at `:120-129` returns `pushStatus: "FAILED"` for any later `gh` error even though the ref now exists. `runner.ts:248` — `const succeeded = executionSucceeded && delivery?.pushStatus !== "FAILED"` — then makes the whole run **FAILED**, and `:249-251` sets `retryable: false` when delivery supplied a `failureClass`. So a `gh pr create` hiccup fails a chain step *non-retryably* after publishing the branch, and revision 0's predicate would then send the next step to `master`, where its push of the already-published shared name is rejected non-fast-forward. Second half also confirmed: `openPullRequest()` is inside that same try (`:107`), so a `gh pr list` failure on an `opensPullRequest = false` step reports "PR creation failed" and fails a step that was never meant to create a PR. | **Adopted in full, via the review's own remedy.** New nullable **`Run.pushedBranch`** records the ref actually pushed, set on *both* delivery paths and in the PR-failure catch (WI-2, WI-9). The resolver's evidence predicate becomes `pushedBranch = shared ∧ repoId = task.repoId` and reads **neither** `status` nor `pushStatus` — including them is what re-creates this bug (§0.3-C2). The `false`-flag catch returns a successful no-PR result. **T16** (resolver: PR failure after a successful push is still evidence), **T25** (runner: `false` step whose `gh pr list` throws still succeeds), **T26** (runner: `pushedBranch` recorded on both paths and in the PR-failure catch). |
| **MF4** | `PATCH opensPullRequest` *does* affect an already queued run, contradicting spec §7.2 | **Confirmed.** The claim route fetches the current task row at claim time (`app.ts:2295`) and returns it verbatim (`app.ts:2393`); `PATCH /tasks/:id` writes non-status fields immediately (`app.ts:1815-1818`). Revision 0's sentence "nothing reads the field until delivery" was simply false. | **Adopted in full, by snapshotting.** New **`Run.opensPullRequest Boolean @default(true)`**, set from the task at each of the five run-creating paths; the runner reads `claim.run.opensPullRequest`, and `opensPullRequest` is deliberately **omitted** from `ClaimedTask["task"]` so reading the live value is a compile error. **T19** is the queued-run regression test. This is §0.4-D7 — a deviation from spec §7.3's field *location*, taken so that spec §7.2's stated contract is actually delivered. Rejecting the PATCH with a 400 was the other option and was declined: spec A6 keeps `targetBranch` writable rather than 400-ing, so a 400 here would cut against the spec's own taste. |
| **MF5** | D3 unilaterally drops an accepted API requirement | **Confirmed.** Spec §7.2 does require it; the only mutating template route is `PATCH /task-templates/:templateId` (`app.ts:1283-1310`, webhook config only), and `TaskTemplateStep` rows are written only by `packages/db/prisma/seed.ts:194-212`. | **Adopted in part; D3 is withdrawn. The part not adopted is named, not dropped.** New **WI-8** adds `PATCH /task-templates/:templateId/steps/:stepId`, bounded to `opensPullRequest` only, with template/step ownership validation and API tests (**T20**), so the accepted field is settable through the API rather than only by direct database access. A template-step **create** route is *not* built: `TaskTemplateStep` requires `stepIndex`, `name`, `assigneeType`, `prompt`, `outputKind`, `approvalGate`, `attachmentsFromPrevious`, `runner`, `spawnPolicy` and an agent (`schema.prisma:439-458`), so "a create route that accepts `opensPullRequest`" is really a whole template-authoring surface that the spec describes nowhere else and that no caller exists for. That half is escalated as **Q3** for the human rather than either silently omitted or invented. |
| **MF6** | The `npm run test:db` gate is not presently a reliable acceptance check | **Confirmed as an observation; the review's mechanism is wrong.** `packages/api/package.json:10` already runs `node --test --test-concurrency=1`, so the "explicitly sequential per-file runner" the review asks for is *already in place* and would fix nothing. The actual mechanism: `TEST_DATABASE_URL` is set nowhere in the repo (there is no `.env`, only `.env.example`), so `packages/api/src/testdb.ts:6-8` falls back to the hardcoded `…/agentos?schema=agentos_test` — **the same schema name for every workspace on this host** — and `resetSchema` does `DROP SCHEMA … CASCADE` on it (`testdb.ts:31-46`). There are currently **five** sibling workspaces under `~/.agentos/runs/`. Two agents running dbtests at once means one drops the schema out from under the other, which is exactly the reported symptom ("`agentos_test.Project`/`TaskTemplate` disappeared"). | **Adopted, with the cheaper and correct remedy.** WI-10 requires the executor to (a) export a **workspace-unique** `TEST_DATABASE_URL` schema before running any dbtest, (b) record a **clean baseline** on the unmodified tree *before* adding any test, and (c) require the full gate green once, without retrying away flakes. No harness rewrite: the isolation problem is a missing environment variable, not a missing feature, and rewriting `testdb.ts` would change the gate for every other in-flight batch. If the baseline is still red on a private schema, that is a **stop-and-report** condition (WI-10) — a red gate cannot prove this plan. Hardening `testdb.ts` to refuse an unset `TEST_DATABASE_URL` is the right permanent fix and is recorded as a backlog item (§13-Q4), not folded into this diff. |
| **MF7** | WI-9 rebases after the runbook records exact SHAs, making them stale | **Confirmed** by reading revision 0 (`:876-895` vs `:930-945` and the graph at `:1005-1015`). | **Adopted in full.** Reordered: **WI-10** (rebase + all gates) runs *before* **WI-11** (the runbook), and WI-11 is the last content-changing commit. Nothing is rebased after it. WI-11 re-runs `build`/`typecheck`/`test` because a doc-only commit cannot break them but the gate report must cover the final tree. |
| **MF8** | The rollback note prescribes deleting a `_prisma_migrations` row while the columns stay installed | **Confirmed** by reading revision 0 (`:417-427`). | **Adopted in full.** WI-2's rollback is rewritten: a **code-only rollback keeps both the columns and the applied migration history/folder** (old code ignores the columns); a **physical rollback** drops the columns *and* uses `prisma migrate resolve --rolled-back <migration>`, the supported procedure, followed by a forward `migrate deploy` proof. Direct ledger mutation is now called out as forbidden. |
| **SF1** | The gate block omits bootstrap and database binding | **Confirmed.** `node_modules/` is absent in a fresh workspace, so `npm run build` exits 127; `packages/db/scripts/check-drift.mjs:3-6` exits 2 without `DATABASE_URL`; and every `db:*` script uses `dotenv -e ../../.env`, but the workspace has only `.env.example`. | **Adopted in full.** WI-10 gains an explicit bootstrap block (`npm ci`), an explicit and credential-safe database binding, and a clear split between the dedicated test schema and any operator-run live migration. |
| **SF2** | "Nine work items, one commit each" cannot hold for WI-9 | **Confirmed** (revision 0 `:15-16` vs `:930-933` "Files: none"). | **Adopted in full.** WI-10 is labelled a **verification stage** that carries no commit; the header sentence now says so. No empty commit is created. |

Two facts found while verifying the above, neither reported by the review, both
of which would have stopped the executor cold:

- **The rebase command in revision 0 does not work in this workspace.**
  `git fetch origin master` leaves no `origin/master` ref, because the runner
  clones `--single-branch` and `remote.origin.fetch` is restricted to the one
  run branch — `git rev-parse --verify origin/master` fails after a successful
  fetch. WI-10 uses an explicit refspec. See §0.3-C13.
- **`master` currently carries no migration later than the local tree's**
  (`20260816180100_tasks_visibility` on both, checked through `FETCH_HEAD`), so
  the suggested timestamp still sorts last *as of now*. G3 still stands as a
  guess because the batch-4 chain may land one before this batch does.

### 0.2 The change in one table

| What | Where | From | To |
|---|---|---|---|
| Derived branch name | new `packages/db/src/chain-branch.ts` | — | `sharedChainBranch({projectId, chainId})` |
| Branch/base decision | `packages/db/src/workflow.ts:117-133` | inline, `templateId`-gated | `resolveRunBranches(tx, task, prior)` |
| First run of an API task | `packages/api/src/app.ts:1682-1698` | no `branch`; `targetBranch: body.targetBranch ?? repo.defaultBranch` | both from the resolver |
| Operator retry | `packages/api/src/app.ts:1904-1923` | `targetBranch: last.targetBranch, branch: last.branch` | both from the resolver |
| **Automatic retry** | `packages/api/src/app.ts:2793-2811` | `targetBranch: run.targetBranch`, no `branch` | resolver for chain steps only (§0.4-D4) |
| Lost-lease requeue | `packages/api/src/reconcile.ts:160-177` | `targetBranch: run.targetBranch`, no `branch` | resolver for chain steps only (§0.4-D4) |
| Publication evidence | new `Run.pushedBranch` | — | the ref a run actually pushed, on both delivery paths |
| PR decision snapshot | new `Run.opensPullRequest` | — | copied from the task at run creation on all five paths |
| PR creation | `packages/runner/src/delivery.ts:75-130` | always creates when none open | suppressed when `claim.run.opensPullRequest === false` |
| Schema | `packages/db/prisma/schema.prisma` | — | `Task.opensPullRequest`, `TaskTemplateStep.opensPullRequest`, `Run.opensPullRequest` (all `Boolean @default(true)`), `Run.pushedBranch String?` |
| Template step field | `packages/api/src/app.ts` | no template-step route exists | `PATCH /task-templates/:id/steps/:stepId`, `opensPullRequest` only |

### 0.3 Where the code contradicts or under-specifies the spec

These are findings from reading the tree, not restatements of the spec. C1–C3
change behaviour the plan must implement; C4–C17 change what the executor should
expect to find.

**C1 — A failed run's WIP salvage records a successful push against the *shared*
branch.** Chain of anchors, all re-read:

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
ever pushed to that ref. The spec's R8.2 predicate as written matches it; step
①'s retry then bases on a ref that does not exist, `git clone --branch` fails
(`workspace.ts:66`), and the chain dies at step ① with no cause visible beyond
"clone failed". It is silent in exactly the way spec §14 warns about.

**C2 — and the symmetric error: a run that *did* publish the branch can be
recorded as a failure.** `delivery.ts:84` pushes first and succeeds; every later
`gh` error is caught at `:120-129` and returned as `pushStatus: "FAILED"`, with
the ref already on the remote. `runner.ts:248` then computes
`succeeded = executionSucceeded && delivery?.pushStatus !== "FAILED"`, so the
**run** is FAILED too, and `:249-251` marks it **non-retryable** because delivery
supplied a `failureClass`. A single `gh pr create` rate-limit therefore:

- fails step ① non-retryably *after* publishing the shared branch, and
- under revision 0's predicate leaves no evidence, so step ② bases on
  `master`, creates a local branch with the already-published shared name, and
  its push is rejected non-fast-forward. The chain is wedged in a way no retry
  clears.

**C1 and C2 together are why revision 1 stops inferring publication from status
fields and records it.** `Run.pushedBranch` is written only after the push
command returns, on both delivery paths, with the ref actually given to `git
push`. The predicate becomes one column comparison plus the repo (C3), and it
reads neither `status` nor `pushStatus` — C2 is precisely the case where both of
those lie. §0.4-D2 argues this against spec R3/§7.1.

*The alternative considered and rejected:* make `Run.branch` truthful (have
salvage report its own branch) and split PR failure out of `pushStatus`. That
needs no new column but changes two existing meanings — what `Run.branch` shows
in the UI and `TaskStepOutput.metadata.branch` (`app.ts:2823`), and whether a PR
failure fails the run at all (`runner.ts:248`). For a batch whose §14 says a
defect fails *silently*, a purely additive column beats redefining two fields
other code already reads.

**C3 — publication evidence must be scoped by repo, not only by chain.** Spec R2
(`spec:157-161`) says two steps of one chain on different repos get the same
branch *name* on each repo and that those refs do not interact.
`provisionWorkspace` clones the claiming run's own `repo.remoteUrl`
(`workspace.ts:65-66`), and `Run.repoId` exists and is indexed
(`schema.prisma:630`, `:685`). Without `repoId` in the query, a push in repo A is
read as evidence for a repo-B step, and that step clones a ref its remote does
not have. The resolver therefore takes `repoId` and filters on it; a task with a
null `repoId` cannot have pushed anything and short-circuits to "no evidence".

**C4 — There are no template-step create or patch API routes.** Grepping every
template route (`app.ts:1271`, `:1276`, `:1283`, `:1312`, `:1400`, `:1429`,
`:1477`, `:1478`, `:1480`, `:570`) finds one mutating route:
`PATCH /task-templates/:templateId` (`app.ts:1283`), which parses
`webhookConfigPatch` and touches webhook configuration only. `TaskTemplateStep`
rows are created in exactly one place in the repo:
`packages/db/prisma/seed.ts:194-212`. WI-8 adds the bounded patch route; the
create half is Q3. **This batch does not touch the seeded nine-step template**:
its steps already share one branch and therefore already produce one PR through
PR reuse, and changing them would be the template behaviour change §5.7 forbids.

**C5 — `@@unique([chainId, chainIndex])` is global, not per-project**
(`schema.prisma:510`). Spec test 5 / S8 ("two projects, one `chainId`") cannot be
written with `(C, 0)` in both projects — it gets P2002. `chain.dbtest.ts:458-470`
already documents this and works around it by giving the second project's chain
disjoint indices (`11 + offset`). T5 does the same.

**C6 — `packages/db` has no `test` script** (`packages/db/package.json`). The
root `npm test` is `npm run test --workspaces --if-present`, so a unit test
placed in `packages/db` would silently never run. The `sharedChainBranch` unit
test goes in `packages/api/src/chain-branch.test.ts`, which `packages/api`'s
`"test": "node --import tsx --test src/*.test.ts …"` picks up.

**C7 — `chainKey` cannot be imported by `@agentos/db`.** It lives in
`packages/api/src/chain.ts:61` and `@agentos/api` depends on `@agentos/db`, not
the reverse. The key string `` `${projectId}:${chainId}` `` must be written twice.
WI-1 pins the duplication with a test that hashes `chainKey(row)` in the API
package and asserts the fingerprint matches, so the two cannot drift silently.

**C8 — Several line anchors in the spec have drifted.** Corrected, as of `0f62af2`:

| Spec says | Actually |
|---|---|
| `workflow.ts:117-122` | comment `:117-119`, expression `:120-122`, used at `:132-133` |
| `app.ts:1675-1700` (POST /tasks) | route `:1652-1703`, transaction `:1675-1701`, `run.create` `:1682-1698`, `targetBranch` `:1692` |
| `app.ts:1904` (retry) | `run.create` `:1904-1923`; `targetBranch: last.targetBranch` `:1915`, `branch: last.branch` `:1916` |
| `reconcile.ts:159` | requeue `run.create` `:160-177`; `targetBranch: run.targetBranch` `:171` |
| `delivery.ts:99-104` | `openPullRequest` `:99-105`; `gh pr create` `:109-115` |
| `templates.ts:88-102` | `tx.task.create` `:87-102` |
| `api.ts:17` (`ClaimedTask["task"]`) | `:16-27` |

**C9 — `reconcileDatabaseRuns`'s candidate select omits `branch`**
(`reconcile.ts:94-110`). The requeue cannot even copy the lost run's head today;
any fix must widen the select or load the task. WI-5 loads the task.

**C10 — The operator retry route does not load `repo`** (`app.ts:1882-1889`
includes `assigneeAgent`, `templateStep`, `runs` only), so it cannot supply
`repo.defaultBranch` to the resolver without widening the include. WI-5 widens it.

**C11 — Neither does the completion route.** `app.ts:2725-2727` loads
`include: { task: { include: { templateStep: true } }, session: true }` — no
`repo`, and the automatic retry at `:2793-2811` therefore has no
`repo.defaultBranch` either. WI-6 widens the include to
`task: { include: { templateStep: true, repo: { select: { defaultBranch: true } } } }`.

**C12 — `POST /tasks` creates the inline run for *any* chain step created with
`scheduleKind = NOW`.** The guard at `app.ts:1680` is
`agent && repo && assigneeType === AGENT && scheduleKind === NOW` — there is no
`chainIndex` predicate, and `scheduleKind` defaults to `NOW` (`app.ts:232`). How
the operator's chain-creation script avoids nine simultaneous runs is not visible
in this repo (§12-G1). The fix does not depend on the answer — every chain step
that gets an inline run must get the shared branch — but the tests must suppress
the inline run deliberately for steps ②③ rather than assuming it does not happen.

**C13 — `origin/master` does not exist in this workspace, and a plain fetch does
not create it.** The clone is `--single-branch` (`workspace.ts:66`), so
`remote.origin.fetch` is `+refs/heads/<this run branch>:refs/remotes/origin/<same>`.
`git fetch origin master` succeeds but writes only `FETCH_HEAD`, and
`git rev-parse --verify origin/master` then fails — so revision 0's
`git rebase origin/master` would abort. **Verified in this workspace.** WI-10
fetches with an explicit refspec:
`git fetch origin master:refs/remotes/origin/master`. As of this revision,
`master` is at `b73a4a4` and its newest migration folder is
`20260816180100_tasks_visibility`, the same as the local tree's.

**C14 — Non-chain retry can already base on a ref that was never pushed.**
`workflow.ts:132` and `app.ts:1915` use `prior?.branch` as the base
unconditionally. For a non-chain task whose run-1 never pushed, run-2 clones a
nonexistent `agentos/<taskId>/run-1`. R11's general principle would cover it, but
R5 and §5.7 require the non-chain and template paths to be untouched, and §10
puts workspace/retry policy out of scope. **Left alone deliberately; recorded so
the review step does not read it as an oversight, and worth a
`docs/BACKLOG-V2.md` entry.**

**C15 — `npm run db:migrate` is `prisma migrate dev`** (`packages/db/package.json`),
which needs a shadow database and can offer to *reset* the target when it sees
drift. Pointing it at the live database is the wrong tool.
`packages/api/src/testdb.ts:41-46` already establishes the right one:
`prisma migrate deploy`, which is non-interactive, needs no shadow database, and
applies exactly the committed folders. WI-2 uses `deploy` and hand-writes the SQL.

**C16 — The dbtest harness has no per-workspace isolation, and this host runs
several workspaces at once.** `TEST_DATABASE_URL` appears in no `.env` (the
workspace has only `.env.example`), so `testdb.ts:6-8` falls back to the
hardcoded `postgresql://…/agentos?schema=agentos_test`, and `resetSchema` does
`DROP SCHEMA IF EXISTS "agentos_test" CASCADE` (`:31-46`). Every workspace on the
machine resolves to that same schema, and five sibling workspaces exist under
`~/.agentos/runs/`. `--test-concurrency=1` (`packages/api/package.json:10`)
serialises files *within one process tree* and does nothing about this. WI-10's
first line is therefore an explicit per-workspace schema. Note also that the
schema lives inside the `agentos` database next to the live `public` schema —
`testdb.ts:12-14` refuses a `public` schema, which is what bounds the blast
radius, and that guard must not be weakened.

**C17 — The claim payload is assembled from live rows.** `app.ts:2295` includes
the whole current `task`, `app.ts:2381` re-reads the run with
`findUniqueOrThrow`, and `:2393-2396` returns `task: candidate.task, …, run`.
Two consequences: (a) a `PATCH` between queueing and claiming changes the queued
run's behaviour, which spec §7.2 says must not happen (§0.4-D7 fixes it); (b)
because the whole `run` row is returned, `Run.opensPullRequest` and
`Run.pushedBranch` ride along with **no claim-route change** once the columns
exist — only the `ClaimedTask` type moves.

### 0.4 Deliberate deviations from the spec

| # | Spec text | This plan | Why |
|---|---|---|---|
| D1 | R8 clause 1: base = `prior?.branch` for any run | For chain steps, clause 1 is **dropped**; base = shared-with-evidence → `Task.targetBranch` → `repo.defaultBranch`. Template and non-chain paths keep clause 1 verbatim. | R11's "or is a per-run branch that a salvage push created" names a value `Run.branch` never holds (C1), and honouring it would push a failed attempt's WIP tree into the chain branch, which R7 forbids in the same spec. For chain steps clause 1 is also redundant: post-change `prior.branch` *is* the shared branch, so clause 2 gives the same answer in S5, and in S6 clause 2 correctly declines. Mixed chains (§8.2) land on `Task.targetBranch`, which is what §8.2 already names as the repair lever. |
| D2 | §7.1: "No new column stores the branch name… it is derived (R3)" | Adds `Run.pushedBranch String?` | C1 + C2. This does **not** store the derived name as a second source of truth: `sharedChainBranch` remains the only thing that *computes* a chain's branch, and nothing reads `pushedBranch` to learn what the branch is called. It records a different fact — *which ref this run actually pushed* — which no existing column expresses and which cannot be recomputed, because it is history. The spec's R8.2 asks for "evidence of a successful push"; every way of inferring that from existing columns is wrong in one direction or the other (C1, C2). |
| D3 | ~~§7.2: template step create/patch routes accept `opensPullRequest`~~ | ~~Not implemented~~ **Withdrawn in revision 1.** The patch route is built (WI-8); the create route is escalated as Q3. | Revision 0 dropped an accepted requirement because no route existed. That was the plan agent overriding the spec, which is not its call. |
| D4 | R6: all run-creating paths produce `Run.branch = sharedChainBranch(...)` via one helper | The **automatic retry** and the **lost-lease requeue** call the resolver *only when the task is a chain step*; for template and non-chain runs they keep `targetBranch: run.targetBranch` and no `branch`, byte for byte | The resolver's non-chain answer (`task.targetBranch ?? defaultBranch`) is not identical to what those two paths copy today — the *lost run's* `targetBranch`, which differs if the task's was edited after the run was created; and today's automatic retry deliberately does not carry `branch` forward at all, unlike the operator retry. R5 and §5.7 require no behaviour change off the chain path. R6's requirement (identical `Run.branch` on every path for chain steps) still holds in full. |
| D5 | §7.3: required field so a missing one is a compile error | Required in the type **and** compared with `!== false` at runtime | Both halves of §11-E10. The type catches our own omission; the comparison means a stale API build that omits the field degrades to today's behaviour (opens a PR) rather than to the expensive failure (never opens one). |
| D6 | §12.2 gate list runs `npm run db:migrate` | `prisma migrate deploy` for any real database; the migration SQL is hand-written | C15. |
| D7 | §7.3: the runner reads `claim.task.opensPullRequest` | The runner reads `claim.run.opensPullRequest`; `ClaimedTask["task"]` deliberately **omits** the field | Spec §7.2 promises a `PATCH` "takes effect on the *next* run created, not on a run already queued", and the claim route reads the live task row (C17), so reading it from `task` breaks the contract the same spec states two subsections earlier. Snapshotting onto the run at creation is the only way to honour §7.2, and omitting the field from the `task` type makes reading the live value a compile error rather than a subtle bug. The decision the runner makes is identical; only where it reads it changes. |
| D8 | §12.2 gates are run as listed | The gates are preceded by a bootstrap block, an explicit `TEST_DATABASE_URL` and an explicit `DATABASE_URL`, and by a recorded clean baseline | SF1 + MF6/C16. The listed commands do not run in a fresh workspace (no `node_modules`, no `.env`) and the dbtest gate is not isolated between workspaces. |

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
 *
 * The name does not depend on the repo. Two steps of one chain on different
 * repos get the same name on each remote, which spec R2 requires; those are
 * different refs and do not interact. Whether a given remote *has* the ref is a
 * separate question, answered by `resolveRunBranches` from `Run.pushedBranch`
 * scoped by `repoId` — never by this function.
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
§0.3-C6 for why it is not in `packages/db`):

1. Determinism (R3): the same pair twice yields the same string.
2. Ref legality: the result matches `/^agentos\/chain\/[a-z0-9][a-z0-9-]{0,23}-[0-9a-f]{8}$/`
   for the spec's worked example, for a `chainId` full of separators, and for `"…"`.
3. E8: `chainId = "…"` yields the literal `chain` slug and still an 8-hex suffix.
4. E9: `"a/b"` and `"a-b"` in one project slug identically and yield **different** branches.
5. R2 / S8 at the function level: the same `chainId` in two different
   `projectId`s yields different branches.
6. C7 pin: `createHash("sha256").update(chainKey({ projectId, chainId })).digest("hex").slice(0, 8)`
   — computed in the test from the API package's `chainKey` — equals the
   fingerprint in the returned branch. This is what stops the duplicated key
   string from drifting.

These are edge-case tests of a pure function. The acceptance bar is WI-3's dbtests.

**Rollback.** Delete the file and the `export *` line. Nothing imports it until WI-3.

---

## WI-2 — Schema, migration, and Prisma regeneration

**Depends on:** nothing (may land before or after WI-1; must land before WI-3
and everything after it — the resolver reads `pushedBranch`).
**Files:**

- `packages/db/prisma/schema.prisma` (`model TaskTemplateStep` `:439-458`,
  `model Task` `:460-520`, `model Run` `:623-700`)
- new `packages/db/prisma/migrations/<timestamp>_chain_branch_and_pr/migration.sql`
- `packages/api/src/migration.dbtest.ts` (append one test)

**Change.** Four columns, all additive, three defaulted, one nullable, no backfill:

```prisma
model TaskTemplateStep {
  // … after `outputKind`
  opensPullRequest        Boolean      @default(true)
}

model Task {
  // … after `approvalGate`
  opensPullRequest   Boolean          @default(true)
}

model Run {
  // … after `branch`
  pushedBranch          String?        // the ref this run actually pushed; see resolveRunBranches
  // … after `workspaceRetained`
  opensPullRequest      Boolean        @default(true)
}
```

Why four and not the spec's two: `Run.pushedBranch` is §0.4-D2 (the sound
publication signal, C1 + C2) and `Run.opensPullRequest` is §0.4-D7 (the snapshot
that makes spec §7.2's "not on a run already queued" true, C17). Both are
additive and defaulted-or-nullable, so the migration stays behaviour-preserving.

Migration SQL, hand-written in the house style of
`packages/db/prisma/migrations/20260816180100_tasks_visibility/migration.sql`:

```sql
-- Platform repair — one branch and one PR per chain. Additive only: three
-- defaulted NOT NULL booleans and one nullable text column. `ADD COLUMN …
-- DEFAULT true` is metadata-only on PostgreSQL 11+ and rewrites no table.
--
-- The boolean default is `true` on purpose and is what makes this migration
-- behaviour-preserving: every existing task, template step and queued run keeps
-- opening its pull request exactly as before, and a chain creator opts
-- documentation steps *out*. Defaulting to `false` would silently stop PRs for
-- every existing chain-shaped workflow, including runs already queued when the
-- migration lands.
--
-- "Run"."pushedBranch" records the ref a run actually pushed. It is NULL for
-- every pre-existing row, which is the conservative answer: no run that
-- completed before this batch counts as evidence that a chain branch exists, so
-- a chain spanning the restart falls back to its Task.targetBranch instead of
-- cloning a ref nothing in this database can vouch for. See §8.2 — such chains
-- are finished by hand.
--
-- No backfill. Completed documentation steps are not rewritten: they are done,
-- and rewriting them would change what the audit trail says happened.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "opensPullRequest" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "TaskTemplateStep" ADD COLUMN     "opensPullRequest" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "opensPullRequest" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pushedBranch" TEXT;
```

**Choosing the timestamp — do this, do not guess it.** The latest folder in the
tree is `20260816180100_tasks_visibility`, and `master` carries nothing later as
of this revision (§0.3-C13), but the batch-4 fixes chain may land one first
(spec §13).

```bash
git fetch origin master:refs/remotes/origin/master        # C13: a plain fetch is not enough
git ls-tree --name-only origin/master packages/db/prisma/migrations/ | tail -5
ls packages/db/prisma/migrations | tail -5
```

Name the folder with a `YYYYMMDDHHMMSS` that sorts strictly after both lists.
`20260817020000_chain_branch_and_pr` is the starting suggestion; if `master`
already carries something later, move past it. Prisma orders by folder name, so
a timestamp that sorts before an already-applied migration makes
`migrate deploy` refuse.

**Applying it.** Do **not** use `npm run db:migrate` (§0.3-C15). Per database:

```bash
npm run db:generate                       # regenerate the client from schema.prisma
cd packages/db && DATABASE_URL="$DATABASE_URL" npx prisma validate
# test schema: applied automatically — packages/api/src/testdb.ts runs
#   `prisma migrate deploy` against TEST_DATABASE_URL on the first dbtest
# live database (operator's call, see WI-10 on where DATABASE_URL comes from):
cd packages/db && npx prisma migrate deploy
npm run db:drift-check                    # must exit 0; reads DATABASE_URL
```

`db:validate`, `db:migrate`, `db:seed` and friends all shell through
`dotenv -e ../../.env`, and **this workspace has no `.env`** (only
`.env.example`) — so bind `DATABASE_URL` explicitly rather than assuming those
scripts work (SF1, §0.4-D8). `db:drift-check`
(`packages/db/scripts/check-drift.mjs:3-6`) exits 2 without it and otherwise
diffs `DATABASE_URL` against `schema.prisma`, so it only passes once the target
database has the columns. Applying the migration to the live database **before**
the restart is the deploy shape the spec prescribes (§8.1) and is safe: the
running API build does not know the columns and ignores them. **This batch
restarts nothing** — not the API, not the runner, not launchd.

**Test.** Append to `packages/api/src/migration.dbtest.ts`, matching the
`information_schema` style already there (`:16-44`):

```
test("the chain-branch migration installs opensPullRequest on Task, TaskTemplateStep and Run, and pushedBranch on Run")
```

— **T27** — asserting that all three `opensPullRequest` columns exist with
`is_nullable = 'NO'` and `column_default = 'true'`, and that `Run.pushedBranch`
exists with `is_nullable = 'YES'`. Assert on `column_default`, not just
existence: the default is what makes the migration behaviour-preserving (A3), and
a hand-written SQL file is exactly where that gets dropped.

**Rollback.** Two shapes, and the difference matters (§0.1-MF8):

- **Code-only rollback (the normal one).** Revert the code commits and **leave
  the four columns and the applied migration in place** — folder committed,
  `_prisma_migrations` row untouched. Old code ignores all four. This is the
  supported state and needs no database work at all.
- **Physical rollback (only if the columns must actually go).** Drop them *and*
  retire the migration through Prisma's own procedure:

  ```sql
  ALTER TABLE "Task"             DROP COLUMN "opensPullRequest";
  ALTER TABLE "TaskTemplateStep" DROP COLUMN "opensPullRequest";
  ALTER TABLE "Run"              DROP COLUMN "opensPullRequest", DROP COLUMN "pushedBranch";
  ```

  ```bash
  cd packages/db && npx prisma migrate resolve --rolled-back 20260817020000_chain_branch_and_pr
  ```

  Then prove the way back: re-apply with `npx prisma migrate deploy` and check
  `npm run db:drift-check` exits 0. The `DROP COLUMN`s are safe in either order;
  nothing references them and there is no FK.

**Never hand-delete a `_prisma_migrations` row.** Revision 0 said to do that when
the folder is removed but the columns stay; it produces a database that tells the
next `migrate deploy` the migration is unapplied, so `deploy` re-runs `ADD COLUMN`
against columns that already exist and fails — and it bypasses the tool's own
history checks. If the folder is gone and the columns are wanted gone too, drop
the columns and use `migrate resolve` as above.

---

## WI-3 — `resolveRunBranches`, and `enqueueTaskRun` through it

This is the work item the batch turns on. **Depends on:** WI-1, WI-2. **Files:**

- `packages/db/src/workflow.ts` (`:1-20` imports, `:92-140` `enqueueTaskRun`)
- new `packages/api/src/chain-branch.dbtest.ts`

**Change.** Replace the inline `chainBranch` expression (`:117-122`) and the two
fields that use it (`:132-133`) with one exported resolver, placed immediately
above `enqueueTaskRun`:

```ts
/** The shape `resolveRunBranches` needs. Structural rather than a Prisma payload
 *  type, so the five call sites can pass rows from five differently-shaped
 *  queries — the same reason `packages/api/src/chain.ts` keeps `ChainRow` plain. */
export type RunBranchTask = {
  id: string;
  projectId: string;
  repoId: string | null;
  chainId: string | null;
  templateId: string | null;
  targetBranch: string | null;
  repo: { defaultBranch: string };
};

/**
 * Decides a new Run's head (`branch`) and base (`targetBranch`). The only place
 * that decision is made; `enqueueTaskRun`, `POST /tasks`, the operator retry
 * route, the automatic retry in the completion transaction and the lost-lease
 * requeue all call this, because five copies of the expression is how step ①
 * ended up on a different branch from steps ②–⑨.
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
  // "Has any step of this chain actually published the shared branch *on this
  // repo*?"
  //
  // Read `pushedBranch` and nothing else. It is written only after `git push`
  // returns, with the ref that was actually given to it, on both delivery paths
  // (delivery.ts). Do not "simplify" this into `branch` + `pushStatus` +
  // `status`: those three lie in both directions, and each direction breaks a
  // chain in a way no retry clears.
  //   - `branch` + `pushStatus`: a *failed* run whose WIP salvage push succeeded
  //     records pushStatus SUCCEEDED with `branch` still set to the workspace
  //     branch — the shared branch — while deliverFailedWorkspace actually
  //     pushed `agentos/<taskId>/run-<n>` (delivery.ts:145,164; runner.ts:262).
  //     The next step would clone a ref nobody created.
  //   - adding `status`/`pushStatus = SUCCEEDED` to compensate: a run that
  //     pushed the branch and then hit any `gh` error is recorded FAILED and
  //     non-retryable (delivery.ts:120-129; runner.ts:248-251) even though the
  //     ref exists. The next step would base on master, recreate the shared
  //     name locally, and be rejected non-fast-forward. Permanently wedged.
  //
  // Scoped by repo (spec R2: the same name on two remotes is two unrelated
  // refs), and by (projectId, chainId) rather than chainIndex — that pair is the
  // platform's definition of a chain, so a chainIndex-null row (E1) sharing the
  // chainId counts, consistent with it sharing the branch.
  const published = task.repoId
    ? await tx.run.findFirst({
      where: {
        pushedBranch: shared,
        repoId: task.repoId,
        task: { projectId: task.projectId, chainId: task.chainId },
      },
      select: { id: true },
    })
    : null;
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

Imports to add at `workflow.ts:1-16`: `sharedChainBranch` from
`./chain-branch.js`. (`PushStatus` is **not** needed — revision 0 imported it for
the predicate that §0.3-C2 retired.)

`enqueueTaskRun` then becomes, at `:117-133`:

```ts
  const branches = await resolveRunBranches(tx, task, prior ?? null);
  return tx.run.create({ data: {
    // …
    targetBranch: branches.targetBranch,
    branch: branches.branch,
    opensPullRequest: task.opensPullRequest,   // snapshot, §0.4-D7
    // …
  } });
```

`task` already carries `repo: true` (`:97`) and every other field
`RunBranchTask` needs, so no query change here.

**Two things not to do.** (a) Do not unify the template and chain naming — §5.7
and A2, and the risk is asymmetric: a rename mid-flight strands work on a branch
nobody merges. (b) Do not add a fallback inside `provisionWorkspace` — §10 is
explicit that a missing base ref must fail loudly, and the whole point of solving
this in the data layer is that it is testable without git.

**Tests** — new file `packages/api/src/chain-branch.dbtest.ts`, following
`chain.dbtest.ts`'s harness (`setupTestDb` / `resetTestDb`, the `asOperator`
wrapper at `:357-366`, `createApp(db).request`). `chain.dbtest.ts` itself is
**not modified** (R19); if a change to it ever looks necessary, the change is
wrong. Seed helper: copy `seedExecutableChain`'s shape (`chain.dbtest.ts:16-35`)
but create the chain steps through `POST /projects/:projectId/tasks` where the
test needs the real route, and through `db.task.create` where it needs to
suppress the inline run (§0.3-C12 / §12-G1). Read `repo.defaultBranch` from the
row — never hardcode `master` or `main` (§12-G2).

**How a step is "driven" in these tests.** Revision 0 advanced the chain by
writing `status`/`pushStatus` onto run rows by hand; the review is right that
this evades the routes under test, and spec §12.1 asks for real
`completeRun`/`activateChainSuccessor` calls. Write one helper —
`completeRunViaRoute(runId, { succeeded, pushedBranch, … })` — that claims the
run through `POST /runner/tasks/claim` and posts a real
`POST /runner/runs/:runId/complete` with a valid `fencingToken`, then let
`activateChainSuccessor` run as it does in production. Only T3, which must
reproduce a payload shape the current runner emits (`branch = shared`,
`pushStatus = SUCCEEDED`, `pushedBranch = <per-run WIP>`), constructs its
completion body by hand — and it still posts it through the route.

| # | Test | Asserts |
|---|---|---|
| T1 | *an API-created chain runs on exactly one branch* | Step ① via `POST /tasks` (`chainId`, `chainIndex: 0`, no `targetBranch`), steps ②③ via `db.task.create`. Drive each step through a **real claim + complete**. Then `db.run.findMany` over all three tasks → **exactly one distinct `branch`**, equal to a value the test recomputes independently (its own `createHash` over `${projectId}:${chainId}`, not a call to `sharedChainBranch` — a function compared to itself proves nothing). Covers spec tests 1 and 4, S1, R6. |
| T2 | *base branch follows the chain, not the task* | Same chain: ①'s `targetBranch === repo.defaultBranch`; ②'s and ③'s `=== shared`. Covers spec test 2, S4, R8. |
| T3 | *a failed run's salvage push is not evidence that the shared branch exists* | Step ①'s run-1 completed through the route as a failure whose payload carries `branch: <shared>`, `pushStatus: SUCCEEDED`, `pushedBranch: agentos/<taskId>/run-1` — precisely what the runner emits after a WIP salvage (§0.3-C1). Advance to step ②; assert ②'s `targetBranch === repo.defaultBranch`, **not** `<shared>`. Its comment must name §0.3-C1 as the reason `pushedBranch` exists. Covers S6, R11, E1. |
| T4 | *the first step of a chain that has published nothing bases on the default* | Step ① run-1 completed as a failure with `pushStatus: FAILED` and no `pushedBranch`; retry; run-2 `targetBranch === repo.defaultBranch` and `branch === shared`. Covers S6. |
| T5 | *two projects sharing one chainId get two branches* | Two projects, same `chainId`, **disjoint `chainIndex` ranges** (§0.3-C5 — `(C,0)` twice is a P2002). Assert the two chains' runs carry different branches and that neither project's evidence query sees the other's runs. Covers spec test 5, S8, R2. |
| T6 | *a template chain still uses `agentos/<chainId>`* | `instantiateTemplate` with no variables → every run's `branch === agentos/<chainId>`, step ①'s `targetBranch === repo.defaultBranch`, later steps' `=== agentos/<chainId>`. Then again with `variables: { branchName: "custom/branch" }` → `branch === "custom/branch"`. Asserts the derived name did **not** leak. Covers spec test 9, S7, R20, and templates.ts `:76`/`:101`/`:110`. |
| T7 | *an operator's targetBranch on a chain step is ignored, and recorded* | Step ⑦-shaped task with `targetBranch = "agentos/<some-task-id>/run-1"`, shared branch already published. Assert base `=== shared` and that exactly one `TaskActivity` row on that task matches `/is not used for chain steps/`. Covers S9, R12, R13. |
| T8 | *a chainId row with a null chainIndex gets the chain's branch* | E1-shaped row, `chainIndex: null`; `POST /tasks/:id/start` or `enqueueTaskRun`; assert `branch === shared` for that `(projectId, chainId)`. Covers R4, S10. |
| **T15** | *two repos in one chain each need their own published branch* | One `chainId`, step ① on repo A, step ② on repo B. Complete ① with `pushedBranch: <shared>` on repo A. Assert ②'s `targetBranch === repoB.defaultBranch` — **not** `<shared>` — and that after a step on repo B publishes, a later repo-B step does get `<shared>`. The §0.1-MF2 regression test; its comment cites spec R2 (`spec:157-161`). |
| **T16** | *a PR failure after a successful push still counts as publication* | Step ①'s run-1 completed through the route with `pushStatus: FAILED`, a `failureClass`, and `pushedBranch: <shared>` — the exact payload `delivery.ts:120-129` produces when the push succeeded and `gh` then failed. The run row is FAILED. Assert step ②'s `targetBranch === <shared>` anyway. The §0.1-MF3 regression test; its comment must say that adding `status`/`pushStatus` to the predicate re-breaks it. |

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
N's work**. Drain or park in-flight chains before reverting. The runbook (WI-11)
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
        // one of the paths a chain fix can miss. Missing it puts step ① on a
        // per-task branch while ②–⑨ share the chain branch — i.e. step ①'s work
        // silently absent from the tree every later step reviews.
        const branches = await resolveRunBranches(tx, { ...created, repo }, null);
        await tx.run.create({
          data: {
            // …
            targetBranch: branches.targetBranch,
            branch: branches.branch,
            opensPullRequest: created.opensPullRequest,
            // …
          },
        });
      }
```

`created` is the freshly-inserted `Task` row and carries `projectId`, `repoId`,
`chainId`, `templateId`, `targetBranch`, `opensPullRequest`; `repo` is already in
scope from `:1660`. `prior` is `null` — run 1 by construction.

The pre-change `targetBranch: body.targetBranch ?? repo.defaultBranch` (`:1692`)
is subsumed: for a non-chain task the resolver returns
`task.targetBranch ?? repo.defaultBranch`, and `created.targetBranch` is
`body.targetBranch` (`taskInput` defaults it to `null` at `:225`, and
`withoutUndefined` keeps `null`). Same value.

Import `resolveRunBranches` from `@agentos/db` alongside the existing
`runnerFor` / `deriveRunConfig` imports.

**Test.** T1 already covers the happy path through this route. Add to
`chain-branch.dbtest.ts`:

| # | Test | Asserts |
|---|---|---|
| T9 | *a non-chain task's first run is unchanged* | `POST /tasks` with no `chainId` and an explicit `targetBranch` → run 1 has `branch === null` and `targetBranch === <the posted value>`; and with no `targetBranch` → `targetBranch === repo.defaultBranch`, `branch === null`. The regression pin for R5/E12 on the path most likely to be broken by the edit. |

**Rollback.** Restore the two literal fields. Independent of WI-3's revert only
if WI-3 stays — if `resolveRunBranches` is removed, this must be reverted too.

---

## WI-5 — Operator retry and lost-lease requeue

**Depends on:** WI-3. **Files:** `packages/api/src/app.ts` (`:1873-1930`),
`packages/api/src/reconcile.ts` (`:87-181`).

**Change A — retry (`POST /tasks/:taskId/retry`).** Widen the include at
`:1882-1889` to add `repo: true` (§0.3-C10), then replace `:1915-1916`:

```ts
      const branches = await resolveRunBranches(tx, task, last);
      const run = await tx.run.create({ data: {
        // …
        targetBranch: branches.targetBranch,
        branch: branches.branch,
        opensPullRequest: task.opensPullRequest,
        // …
      } });
```

`task.repoId` may be null on this route (`:1910` passes `repoId: task.repoId`),
so `task.repo` may be null. Guard: if `!task.repo`, keep today's
`targetBranch: last.targetBranch, branch: last.branch`. A task with no repo
cannot be a chain step with a branch anyway, and this route already tolerates a
null `repoId`.

For chain steps this changes retry from "inherit whatever run-1 had" to
"recompute", which is what makes S5 correct after a mixed-chain restart and what
makes T4's fallback work. For template and non-chain tasks the resolver's
clause-1 branch returns `prior?.branch` — the same value `last.branch` gave — so
behaviour is unchanged.

**Change B — requeue (`reconcileDatabaseRuns`).** Add `branch: true` to the
candidate select (`:94-110`, §0.3-C9), then before the `run.create` at `:160`:

```ts
        // Chain steps recompute; everything else copies the lost run's base
        // verbatim, because the resolver's non-chain answer reads the *task's*
        // current targetBranch and the lost run's may predate an operator edit.
        const task = await tx.task.findUnique({
          where: { id: run.taskId },
          select: {
            id: true, projectId: true, repoId: true, chainId: true, templateId: true,
            targetBranch: true, opensPullRequest: true,
            repo: { select: { defaultBranch: true } },
          },
        });
        const branches = task?.chainId && !task.templateId && task.repo
          ? await resolveRunBranches(tx, { ...task, repo: task.repo }, null)
          : { branch: run.branch, targetBranch: run.targetBranch };
```

and use `targetBranch: branches.targetBranch, branch: branches.branch,
opensPullRequest: task?.opensPullRequest ?? true` in the `run.create`. `prior` is
`null` deliberately: for chain steps the resolver ignores it, and passing the
lost run would be misleading.

This is deviation D4 — read it before simplifying the conditional away.

**Tests** (in `chain-branch.dbtest.ts`):

| # | Test | Asserts |
|---|---|---|
| T10 | *an operator retry lands on the shared branch* | Chain of ≥2 steps, shared branch published by step ①. Step ②'s run-1 → `FAILED`; `POST /tasks/:id/retry`; run-2 has `branch === shared` and `targetBranch === shared`. Covers spec test 3, S5, R10. |
| T11 | *a lost-lease requeue keeps the shared branch* | Chain-step run in `RUNNING` with `leaseExpiresAt` in the past and no recent `heartbeatAt`; call `reconcileDatabaseRuns(db, now)`; the requeued run has `branch === shared` and `targetBranch === shared` (published) or `=== repo.defaultBranch` (not published). Covers R6 row 5, E11. |
| T12 | *a non-chain requeue is unchanged* | Non-chain run with `targetBranch: "some/branch"`, `branch: null`, lost lease → requeued run has the same `targetBranch` and `branch === null`. The regression pin for D4. |

**Rollback.** Restore `targetBranch: last.targetBranch, branch: last.branch` and
`targetBranch: run.targetBranch`; the widened `include`/`select` may stay
harmlessly or be reverted with them.

---

## WI-6 — The automatic retry in the completion transaction

**New in revision 1 — §0.1-MF1.** This is the fifth run-creating path, and it is
the one a chain hits most often in practice: every transient failure of a chain
step goes through it without an operator touching anything. **Depends on:** WI-3.
**Files:** `packages/api/src/app.ts` (`:2721-2727` the include, `:2792-2813` the
retry).

**Change A — load the repo (§0.3-C11).** At `:2725-2727`:

```ts
        include: {
          task: { include: { templateStep: true, repo: { select: { defaultBranch: true } } } },
          session: true,
        },
```

**Change B — route the retry through the resolver, chain steps only (D4).**

```ts
      let retryCreated = false;
      if (!succeeded && retryable && run.task && run.runNumber < budgetCeiling) {
        // The fifth run-creating path. It copies `targetBranch` and has never
        // carried `branch` forward, so before this change an automatic retry of
        // a chain step silently dropped off the chain branch onto
        // `agentos/<taskId>/run-<n>` (workspace.ts:65-69) — the same defect this
        // batch exists to fix, one route further along. D4: only chain steps are
        // rerouted; template and non-chain retries keep today's fields exactly.
        const branches = run.task.chainId && !run.task.templateId && run.task.repo
          ? await resolveRunBranches(tx, { ...run.task, repo: run.task.repo }, null)
          : { branch: null, targetBranch: run.targetBranch };
        await tx.run.create({
          data: {
            // …
            targetBranch: branches.targetBranch,
            branch: branches.branch,
            opensPullRequest: run.task.opensPullRequest,
            // …
          },
        });
        retryCreated = true;
      }
```

Note the non-chain fallback is `{ branch: null, targetBranch: run.targetBranch }`
and **not** `run.branch` — today's code sets no `branch` on this path, unlike the
operator retry route, and D4 is about preserving that asymmetry rather than
tidying it. Tidying it is C14's territory and is out of scope.

`resolveRunBranches` takes the transaction and this call is already inside
`db.$transaction` (`:2723`), so the R13 activity row lands atomically with the
retry.

**Ordering note.** This runs *after* the `tx.run.updateMany` at `:2750-2774` that
writes the completing run's `pushedBranch`, so a chain step whose run-1 published
the branch and then failed for another reason gives its own automatic retry
correct evidence within the same transaction. That is the desired order; do not
move the retry above the close.

**Tests** (in `chain-branch.dbtest.ts`):

| # | Test | Asserts |
|---|---|---|
| **T13** | *an automatic retry of a chain step stays on the shared branch* | Chain step whose run-1 is claimed and then completed through the **real** `POST /runner/runs/:runId/complete` with a retryable failure (`exitCode: 1`, `failureClass: TRANSIENT_PROVIDER`, `retryable: true`) and no `pushedBranch`. Assert a run-2 row exists, `branch === shared`, `targetBranch === repo.defaultBranch` (nothing published) — and, in a second arrangement where step ① published first, `targetBranch === shared`. The §0.1-MF1 acceptance test. |
| **T14** | *an automatic retry of a non-chain task is unchanged* | Same shape, no `chainId`, task `targetBranch = "some/branch"` → run-2 has `targetBranch === run1.targetBranch` and `branch === null`. The D4 pin for this path. |

**Rollback.** Restore `targetBranch: run.targetBranch` and drop the resolver call
and the widened include.

---

## WI-7 — `opensPullRequest` through the task API

**Depends on:** WI-2 (and, for the run snapshot, on WI-3..WI-6 having added the
field to each `run.create`). **Files:** `packages/api/src/app.ts` (`:203-244`),
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

**A `PATCH` takes effect on the next run created, and this is now true rather
than merely asserted.** Revision 0 claimed "nothing reads the field until
delivery"; the claim route reads the live task row (§0.3-C17), so a patch between
queueing and claiming *did* change a queued run. The snapshot column
`Run.opensPullRequest` (WI-2), written at each of the five run-creating paths
(WI-3..WI-6) and read by the runner from `claim.run` (WI-9), is what delivers
spec §7.2's contract. **T19** is its regression test.

**Change B — the template copies it onto the task.** In `templates.ts`, inside
`tx.task.create` (`:87-102`), add:

```ts
            opensPullRequest: step.opensPullRequest,
```

Existing template step rows default `true`, so every template chain behaves
exactly as today (§5.7). **Do not add `opensPullRequest` to the seeded nine-step
template** (`packages/db/prisma/seed.ts:194-212`): template chains already share
one branch and therefore already produce one PR through reuse, and changing them
is the behaviour change §5.7 forbids.

**Change C — nothing in `apps/web`.** `apps/web/src/components/new-task-panel.tsx:50`
posts a fixed field set and `apps/web/src/lib/types.ts` describes responses
structurally, so an extra field neither breaks the POST (it defaults) nor the
render. Surfacing a checkbox is out of scope (§10, Q1).

**Tests** (in `chain-branch.dbtest.ts`):

| # | Test | Asserts |
|---|---|---|
| T17 | *opensPullRequest defaults to true and round-trips* | `POST /tasks` with no field → row is `true`; with `false` → `false`; `PATCH` flips it; `GET /tasks/:id` returns it. Covers R14, A3. |
| T18 | *an instantiated template copies the step's flag* | Template with step 2 set to `opensPullRequest: false` → the instantiated task 2 is `false` and the others `true`. Covers §7.2 row 4. |
| **T19** | *a PATCH does not change an already-queued run* | `POST /tasks` with `opensPullRequest: true` → run 1 queued with the snapshot `true`. `PATCH /tasks/:id { opensPullRequest: false }`. Then claim the run and assert the **claim payload's `run.opensPullRequest` is still `true`** while `GET /tasks/:id` reports `false`; and that the *next* run created for that task is `false`. The §0.1-MF4 regression test; it must assert on the claim payload, because that is where the old behaviour leaked. |

**Rollback.** Remove the two Zod lines and the one `templates.ts` line. The
columns may stay (old code ignores them) — see WI-2.

---

## WI-8 — The template-step patch route

**New in revision 1 — §0.1-MF5, and it withdraws revision 0's D3.** Spec §7.2
requires the field to be settable on a template step through the API. No such
route exists (§0.3-C4), so revision 0 declared the requirement unimplementable
and dropped it; that is the spec's call to make, not the plan's. **Depends on:**
WI-2. **Files:** `packages/api/src/app.ts` (beside the template routes at
`:1276-1311`), `packages/api/src/chain-branch.dbtest.ts`.

**Change.** One bounded route, deliberately narrower than a general step editor:

```ts
  // Bounded on purpose: `opensPullRequest` only. A general template-step editor
  // is a whole authoring surface (stepIndex, name, assigneeType, prompt,
  // outputKind, approvalGate, attachmentsFromPrevious, runner, spawnPolicy,
  // agent) that this batch's spec does not describe and no caller wants yet —
  // see Q3. Widening this route is a separate decision, not a follow-on edit.
  const templateStepPatch = z.object({ opensPullRequest: z.boolean() });
  app.patch("/task-templates/:templateId/steps/:stepId", async (context) => {
    const templateId = id.parse(context.req.param("templateId"));
    const stepId = id.parse(context.req.param("stepId"));
    const body = await readJson(context.req.raw, templateStepPatch);
    // Ownership is checked, not assumed: the step id alone would let a caller
    // patch another template's step through any templateId that happens to exist.
    const step = await db.taskTemplateStep.findFirst({ where: { id: stepId, taskTemplateId: templateId } });
    if (!step) return context.json({ error: "Template step not found" }, 404);
    return context.json(await db.taskTemplateStep.update({
      where: { id: stepId },
      data: { opensPullRequest: body.opensPullRequest },
    }));
  });
```

Place it directly after `GET /task-templates/:templateId` (`:1276-1282`) so the
template routes stay together. Authentication needs no change and no allowlist
edit: `isPublic` (`app.ts:441-443`) is deny-by-default — everything except `/`,
`/health`, `OPTIONS` and `POST /hooks/templates/:id` requires the operator token
— so this route is behind operator auth the moment it exists. Do not add it to
`isPublic`.

Existing rows default `true` (WI-2), so this route changes nothing until an
operator calls it, and the seeded nine-step template is not touched (WI-7
change B).

**Tests** (in `chain-branch.dbtest.ts`):

| # | Test | Asserts |
|---|---|---|
| **T20** | *a template step's PR flag is settable through the API* | Instantiate-ready template; `PATCH /task-templates/:id/steps/:stepId { opensPullRequest: false }` → 200 and the row is `false`; a subsequent `POST …/instantiate` produces that step's task with `false` (composes with T18). Then: a `stepId` belonging to a *different* template → **404**, and a non-boolean body → **400**. |

**Rollback.** Delete the route, the schema and the test. Nothing depends on it;
the column stays and keeps defaulting to `true`.

---

## WI-9 — The runner: push always, record what was pushed, create a PR only when told to

**Depends on:** WI-2 (the columns must exist on the claimed run row).
**Files:** `packages/runner/src/api.ts` (`:16-27`, the `run` shape at `:41+`),
`packages/runner/src/delivery.ts` (`:8-17`, `:60-130`, `:132-137`),
`packages/api/src/app.ts` (`completionInput` at `:276-301`, the run update at
`:2750-2774`), `packages/runner/src/delivery.test.ts`.

**Change A — the types.** `ClaimedTask["run"]` gains, **required**:

```ts
    opensPullRequest: boolean;
```

and `ClaimedTask["task"]` deliberately does **not**. Required so a path in our
code that forgets it is a compile error rather than a silent
`undefined → falsy → never open a PR` (§7.3, E10); on `run` rather than `task`
per §0.4-D7, so that reading the live, patchable value is a compile error too. No
query change is needed: the claim route returns the whole run row
(`app.ts:2381`, `:2396`) and the whole task row.

`DeliveryResult` (`delivery.ts:8-17`) gains `pushedBranch?: string`.

**Change B — record the ref that was actually pushed.** This is the §0.1-MF3 fix
and it is the load-bearing half of this work item. In `deliverWorkspace`, every
return path that follows a successful `git push` carries
`pushedBranch: workspace.branch` — the `manual()` helper, the `gh --version`
failure, the reuse-existing-PR return, the created-PR returns, the new
`noPullRequest()` helper, **and the catch at `:120-129`**. The only returns
without it are the push-failure return at `:87` and, in
`deliverFailedWorkspace`, its own catch. `deliverFailedWorkspace`'s success
return carries `pushedBranch: branch` — the per-run WIP branch it actually
pushed, *not* `workspace.branch`.

Give `manual()` and `noPullRequest()` a `pushedBranch` argument rather than
threading it at each call site, so a future return path cannot forget it:

```ts
const noPullRequest = (branch: string, remote: string): DeliveryResult => ({
  pushStatus: "SUCCEEDED",
  pushRemote: remote,
  pushedBranch: branch,
  deliveryInstructions: `Branch '${branch}' was pushed. This step does not open a pull request.`,
});
```

`completionInput` (`app.ts:276-301`) gains
`pushedBranch: z.string().nullable().optional()`, and the run update
(`:2750-2774`) gains `pushedBranch: body.pushedBranch ?? null`. The payload
already flows: `runner.ts:262-263` spreads `...(delivery ?? …)` into
`completeRun`.

**Change C — the flag.** In `deliverWorkspace`, immediately after
`const remote = …`:

```ts
  // `!== false`, not a truthiness test, and the difference is the whole point.
  // The field is required in ClaimedTask so our own code cannot omit it; the
  // comparison is what makes a *stale API build* that omits it from the claim
  // payload degrade to today's behaviour (open the PR) instead of to the
  // expensive failure (never open one again, silently). Read from `run`, not
  // `task`: the run carries the snapshot taken when it was created, so an
  // operator's PATCH cannot change a run that is already queued (spec §7.2).
  // No step name, output kind or task name is consulted here or anywhere in
  // this package.
  const opensPullRequest = claim.run.opensPullRequest !== false;
```

Then, all after the push at `:84` (the push is unconditional — a `false` step
still publishes the branch, which is what lets the *next* step clone it):

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
    if (existing) return { pushStatus: "SUCCEEDED", pushRemote: remote, pushedBranch: workspace.branch, pullRequestUrl: existing.url, pullRequestNumber: existing.number };
    if (!opensPullRequest) return noPullRequest(workspace.branch, remote);
    await command("gh", ["pr", "create", …]);
```

4. `:120-129` — the catch. Two changes, both §0.1-MF3:

```ts
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // The push at :84 already succeeded, so the branch exists on the remote no
    // matter what `gh` did. Report that fact (`pushedBranch`) on both paths, or
    // the chain's next step bases on the default branch and its push of the
    // already-published shared name is rejected non-fast-forward.
    //
    // For a step that was never meant to open a PR, a failed `gh pr list` is
    // not a delivery failure at all — everything this step owed the chain is
    // already on the remote. Reporting FAILED here would fail a documentation
    // step *after* its push, and `runner.ts:248-251` would mark it
    // non-retryable.
    if (!opensPullRequest) return noPullRequest(workspace.branch, remote);
    return {
      pushStatus: "FAILED",
      pushRemote: remote,
      pushedBranch: workspace.branch,
      pushError: message,
      deliveryInstructions: `Branch '${workspace.branch}' was pushed, but PR creation failed. Run gh pr create manually.`,
      failureClass: failureClassFor(message),
    };
  }
```

The `true` path keeps reporting `pushStatus: "FAILED"` exactly as today —
whether a PR-creation failure should fail the run at all is a real question, and
it is **not** this batch's (spec §10; recorded as §12-G7). All this batch changes
is that the failure no longer erases the fact that the branch was published.

**Change D — one comment, load-bearing.** On `deliverFailedWorkspace` (`:132-136`),
extend the existing docblock:

```
 * The per-run branch here is deliberate and is now load-bearing: a failed run's
 * half-finished tree must never enter the chain's shared branch, which every
 * later step of the chain clones. Never change this to workspace.branch.
 *
 * Note what this function does *not* control: the completion payload still
 * reports `Run.branch` as the workspace branch (runner.ts:262-263), so a
 * salvaged run still *looks* like a push to the shared branch in that column.
 * `pushedBranch` below is the column that tells the truth, and it is the only
 * one @agentos/db's resolveRunBranches trusts. Keep them in sync: whatever ref
 * is handed to `git push` is the ref reported as `pushedBranch`.
```

**Tests** (append to `packages/runner/src/delivery.test.ts`; the existing six
tests stay **unmodified**, and the fact that they pass is itself the D5
regression pin — their `claim` fixture at `:9-13` omits `opensPullRequest`, so
they prove an omitted field still opens a PR):

| # | Test | Asserts |
|---|---|---|
| T21 | *a step that does not open pull requests still pushes* | `run: { …, opensPullRequest: false }`, `gh pr list` returns `[]`. Recorded calls contain `git push --set-upstream origin feature/test` and `gh pr list …`, and contain **no** `gh pr create`. `pushStatus === "SUCCEEDED"`. Covers spec test 6, S3, R16. |
| T22 | *…and says so instead of failing* | Same claim: `pullRequestUrl === undefined`, `deliveryInstructions` matches `/Branch 'feature\/test' was pushed/` and `/does not open a pull request/`. Covers spec test 7, R17. |
| T23 | *a late documentation step reports the chain's existing PR* | `opensPullRequest: false`, `gh pr list` returns one PR → `pullRequestNumber === 7`, no `gh pr create`. Covers R16 row 2, A9. |
| T24 | *no gh, no PR by design* | `opensPullRequest: false` and `gh --version` throwing → `deliveryInstructions` matches `/does not open a pull request/` and **not** `/manually/`. Covers E4. |
| **T25** | *a failed PR lookup does not fail a step that opens no PR* | `opensPullRequest: false` and `gh pr list` **throwing** → `pushStatus === "SUCCEEDED"`, no `failureClass`, `deliveryInstructions` matches `/does not open a pull request/`. The §0.1-MF3 second-half regression test. |
| **T26** | *what was pushed is recorded on every path that pushed* | Four cases: (a) success with a created PR → `pushedBranch === "feature/test"`; (b) `gh pr create` **throwing** → `pushStatus === "FAILED"` **and** `pushedBranch === "feature/test"`; (c) `git push` throwing → `pushedBranch === undefined`; (d) `deliverFailedWorkspace` on a dirty tree → `pushedBranch === "agentos/<taskId>/run-<n>"`, **not** `workspace.branch`. (b) and (d) are the two failure directions of §0.3-C1/C2 and their comments must say so. |

**Rollback.** Revert `delivery.ts`, the type lines and the `completionInput`
field. Note the asymmetry: a runner rolled back while the API still sets
`opensPullRequest = false` on documentation steps will open a PR per step again —
noisy, not destructive. A runner rolled *forward* against an old API is the E10
case, and D5 makes it degrade to today's behaviour. A runner that does not send
`pushedBranch` leaves the column null, so no run counts as evidence and every
chain step bases on its `Task.targetBranch` — degraded but safe, and visible in
the R13 activity rows.

---

## WI-10 — Bootstrap, rebase, and the gates *(verification stage — no commit)*

**Depends on:** WI-1..WI-9. **Files:** none. This stage produces a gate report,
not a commit (§0.1-SF2); no empty commit is created to preserve a count.
It runs **before** the runbook (§0.1-MF7) so that the SHAs WI-11 records are the
ones that ship.

**Step 1 — bootstrap and bind (§0.1-SF1, §0.4-D8).** None of the gate commands
run in a fresh workspace as-is: `node_modules/` is absent, so `npm run build`
exits 127 with `tsc: command not found`, and there is no `.env`, so every
`dotenv -e ../../.env` script and `check-drift.mjs` (which exits 2 without
`DATABASE_URL`) fails.

```bash
npm ci
# A schema this workspace owns. testdb.ts drops and recreates whatever schema
# this names (testdb.ts:31-46) and every workspace on this host otherwise
# resolves to the same `agentos_test` — see §0.3-C16. Five sibling workspaces
# exist right now; sharing the schema is what turns the dbtest gate red.
export TEST_DATABASE_URL='postgresql://agentos:agentos@localhost:5432/agentos?schema=agentos_test_chainbranch'
```

`DATABASE_URL` is needed only by `db:drift-check` and only against a database
that has the migration. Point it at the **same test schema**, not at the live
database: drift-check is a schema comparison and the test schema is a faithful
`migrate deploy` of the committed folders. Applying this migration to the live
database is the operator's step in the deploy runbook (WI-11 item 1), not this
plan's.

```bash
export DATABASE_URL="$TEST_DATABASE_URL"
```

Never write either URL, or any token, into a committed file, a commit message or
a task output.

**Step 2 — record a clean baseline before adding anything (§0.1-MF6).** On the
tree as it stands *before* this batch's test files exist:

```bash
npm run test:db 2>&1 | tail -20
```

Record pass/fail counts in the gate report. If this is red on a schema nobody
else shares, **stop and report** — a red baseline means the gate cannot prove
this plan, and the right move is to say so, not to add tests to it or to retry
until it passes. Do not "retry away" a flake: a flake that clears on the second
run is still an unproven gate, and this batch's §14 says a defect here fails
silently.

**Step 3 — rebase.** A plain `git fetch origin master` leaves no `origin/master`
in this workspace (§0.3-C13, verified) — the clone is single-branch — so:

```bash
git fetch origin master:refs/remotes/origin/master
git rebase origin/master
```

Then re-check that the migration folder name still sorts strictly after
`git ls-tree --name-only origin/master packages/db/prisma/migrations/ | tail -5`
(WI-2); rename the folder if the batch-4 chain landed one later.

**Step 4 — the five gates, all after the rebase**, because batch 1 and the
batch-4 fixes chain are in flight and both may touch `packages/api/src/app.ts`
(spec §13):

```bash
npm run build
npm test                 # full workspace suite, incl. WI-1 and WI-9 unit tests
npm run test:db          # @agentos/api dbtests — where the chain assertions live
npm run typecheck
npm run db:drift-check   # must exit 0
```

`npm run test:db` is required green **once, on the final tree, without retries**.

The diff must stay inside `workflow.ts`, `chain-branch.ts`, `templates.ts`, the
task-creation / retry / completion / claim regions of `app.ts`, `reconcile.ts`,
`packages/runner/src/{api,delivery}.ts`, the schema + migration, tests, and the
runbook.

Then the §12.3 manual checklist, each with the command that answers it:

| Check | Command | Expected |
|---|---|---|
| The per-run branch pattern survives only where it should | `grep -rn 'run-\${' packages/runner/src` | two hits: `workspace.ts:68` (the fallback) and `delivery.ts:145` (salvage, R7) |
| No step-name / output-kind / task-name matching decides PR creation | `grep -rn 'stepName\|outputKind\|task\.name' packages/runner/src` | no hit inside `deliverWorkspace`'s decision path; `pullRequestTitle` (`delivery.ts:67-73`) reads `task.name` for the *title*, which is A5 and is fine |
| The runner reads the snapshot, never the live task | `grep -rn 'opensPullRequest' packages/runner/src` | `api.ts` (on `run`), `delivery.ts` (`claim.run.opensPullRequest`), tests. **No `claim.task.opensPullRequest` anywhere** — D7 |
| The derived function is used, not re-implemented, on all five paths | `grep -rn 'resolveRunBranches\|sharedChainBranch' packages` | `chain-branch.ts` (definition), `workflow.ts` (definition + `enqueueTaskRun`), `app.ts` ×3 (POST /tasks, retry, completion), `reconcile.ts` ×1, tests |
| Publication is read from one column only | `grep -rn 'pushedBranch' packages` | `schema.prisma`, migration, `workflow.ts` (the only *read*), `delivery.ts`, `app.ts` (`completionInput` + the run update), tests |
| `chain.dbtest.ts` is untouched | `git diff origin/master -- packages/api/src/chain.dbtest.ts` | empty (R19) |
| No secret in the diff | `git log -p origin/master..HEAD \| grep -n 'OPERATOR_TOKEN'` | only the test-local literal `"operator-db-token"` in dbtest helpers, never a real value |

**Rollback.** N/A.

---

## WI-11 — Rollback runbook *(the last content-changing commit)*

**Depends on:** WI-10, so the commit list is post-rebase and final (§0.1-MF7).
**Files:** new `docs/runbooks/platform-chain-branch-and-pr-rollback.md`.

Follow `docs/runbooks/batch-2.5-rollback.md`'s shape: deploy order → the traps →
code-only rollback → schema rollback in reverse → what is lost. It must contain,
and a reviewer should check for, all eight:

1. **Deploy order**, matching WI-2: `db:generate` → `prisma validate` →
   `prisma migrate deploy` → `db:drift-check` → `npm run build` → *the operator
   restarts the API and the runner at a time of their choosing*. State plainly
   that this batch's runbook restarts nothing and touches no launchd service,
   and that the migration is safe to apply before the restart because the old
   build ignores all four columns. Name where `DATABASE_URL` comes from for the
   live apply; **do not print its value**.
2. **The exact revert**: the post-rebase commit SHAs of WI-1..WI-9 and this
   commit, the files (`packages/db/src/chain-branch.ts`,
   `packages/db/src/workflow.ts`, `packages/api/src/app.ts`,
   `packages/api/src/templates.ts`, `packages/api/src/reconcile.ts`,
   `packages/runner/src/api.ts`, `packages/runner/src/delivery.ts`), and the
   migration folder name.
3. **Schema rollback**, both shapes from WI-2 and the difference between them:
   code-only keeps the columns **and** the applied migration history; physical
   drops the columns **and** runs `prisma migrate resolve --rolled-back`, then
   proves the way forward with `migrate deploy` + `db:drift-check`.
   **State explicitly that hand-deleting a `_prisma_migrations` row is not a
   rollback procedure** and why (§0.1-MF8).
4. **The mixed-chain trap, in both directions.** Forward (§8.2): a chain that
   spans the restart is mixed, its already-created runs keep their per-task
   branches, and **it is finished by hand — this batch is only correct for chains
   created after the restart**. Backward: after a code-only rollback, a chain
   mid-flight on a shared branch reverts to per-task branches for its remaining
   steps, so step N+1 will not contain step N's work. Both say: **drain, or park
   the remaining steps in `BACKLOG`, before restarting or rolling back.**
5. **The detection query** for mixed chains, verbatim from spec §8.2 (it uses
   lowercase status literals `('todo','doing','backlog')`, which is correct —
   `TaskStatus` is `@map`-ed to lowercase in `schema.prisma:74-78`).
6. **The manual PR recovery** (R18, E6), one line:
   `gh pr create --base master --head agentos/chain/<slug>-<fingerprint> --title '<chain name>'`,
   with the note that there is no automatic promotion and why (A4).
7. **The stale-runner note** (E10, and now also §0.1-MF3): a runner binary older
   than the API omits `opensPullRequest`, which D5 degrades to opening a PR —
   noisy, not lossy; and it omits `pushedBranch`, so no run registers as
   publication evidence and every chain step bases on its `Task.targetBranch`.
   The visible symptom of the second is an R13 activity row on every step;
   the fix is to rebuild the runner, not to edit branches by hand.
8. **What a wedged chain looks like and how to unwedge it.** Symptom: a step
   fails during provisioning with a clone error naming
   `agentos/chain/<slug>-<fp>`, or a push rejected non-fast-forward on that ref.
   Cause and lever: check `SELECT id, "branch", "pushedBranch", "pushStatus", status FROM "Run" WHERE "taskId" = …`
   — if `pushedBranch` is null everywhere, nothing published and the operator's
   `Task.targetBranch` is the base being used; set it to a ref that exists.

Plus, since it is where an operator will look for it: **how to compute a chain's
branch by hand**, so they can find it without the API —
`printf '%s' "<projectId>:<chainId>" | shasum -a 256 | cut -c1-8` and the slug
rule from §5.1.

**Check.** No test. Reviewed by reading: the eight items above, and
`grep -c OPERATOR_TOKEN docs/runbooks/platform-chain-branch-and-pr-rollback.md`
returns 0. Because this is a documentation-only commit it cannot break the
gates, but re-run `npm run build`, `npm test` and `npm run typecheck` after it so
the recorded gate result describes the tree that actually ships. **Do not rebase
after this commit** — that is what made revision 0's SHAs stale.

**Rollback.** Delete the file.

---

## 10. Coverage — every spec requirement to a work item

| Spec | Work item |
|---|---|
| R1, R2, R3 branch name / fingerprint / pure function | WI-1 |
| R4, R5 chainIndex-null row; non-chain unaffected | WI-3 (T8), WI-4 (T9) |
| R6 all run-creating paths (five, not four) | WI-3 (`enqueueTaskRun`), WI-4 (`POST /tasks`), WI-5 (operator retry, reconcile), **WI-6 (automatic retry)** |
| R7 salvage stays on the per-run branch | WI-9 change D (comment) + `pushedBranch`; pinned by T26(d) and the unmodified `delivery.test.ts` salvage tests |
| R8 base-branch rule | WI-3 (with D1, D2) |
| R9 step ⑥ automatically on ⑤'s tree; prose retirement recorded | WI-3 (T2 proves it); WI-11 records the retirement note (Q2) |
| R10, R11 retries | WI-5 (T10), WI-6 (T13), WI-3 (T3, T4, T16) |
| R12, R13 `targetBranch` afterwards + the activity row | WI-3 (T7) |
| R14 the new field, default `true` | WI-2, WI-7 (T17) |
| R15 runner decides from the field alone | WI-9; §WI-10 checklist rows 2 and 3 |
| R16, R17 delivery by flag | WI-9 (T21–T23, T25) |
| R18 no promotion; manual recovery | WI-11 item 6 |
| R19 `chain.dbtest.ts` unmodified | WI-3 (new file), WI-10 checklist row 6 |
| R20 template chains frozen; the five load-bearing behaviours | WI-3 (early return), WI-7 change B (seed untouched), T6 |
| S1–S10 | T1 (S1), composition comment (S2), T21/T22 (S3), T2 (S4), T10 (S5), T3/T4 (S6), T6 (S7), T5 (S8), T7 (S9), T8 (S10) |
| E1–E12 | T3 (E1), T1 (E2), unmodified push path (E3), T24 (E4), unmodified `--state open` (E5), WI-11 (E6), untouched `parkedReason` (E7), WI-1 tests (E8, E9), WI-9 type + D5 + WI-11 item 7 (E10), T11 (E11), T9 + T17 (E12) |
| §7.1 schema | WI-2 (plus D2, D7 columns) |
| §7.2 API surface | WI-7 (rows 1,2,3,4,6,7), **WI-8 (row 5)**, T19 (the PATCH-timing clause) |
| §7.3 runner | WI-9 (field on `run` per D7) |
| §7.4 `@agentos/db` | WI-1, WI-3 |
| §7.5 web keeps compiling | WI-7 change C; proven by `npm run build` in WI-10 |
| §8 migration and in-flight chains | WI-2, WI-11 items 1, 4, 5 |
| §9 rollback runbook | WI-11 |
| §12.1 tests 1–9 | T1 (1, 4), T2 (2), T10 (3), T5 (5), T21/T23 (6), T22 (7), WI-10 checklist row 6 (8), T6 (9) |
| §12.2 gates | WI-10 |
| §12.3 manual checklist | WI-10 |

Spec §10's out-of-scope list is respected in full: no step/agent/model change, no
approval-gate work (the 「闸门消息永远关不掉」 defect is **not** touched — do not
fold it in), no change inside `provisionWorkspace`, no edit to the operator's
chain-creation script, no web UI, no GitHub write beyond `gh pr create`, no
concurrency work. WI-8 is the one surface added since revision 0, and it is added
because the spec requires it, not because the plan wants it (§0.1-MF5).

---

## 11. Order of operations

WI-1 and WI-2 are independent of each other; everything else depends on WI-2,
because all four new columns must exist before any code names them.

```
WI-1 (pure fn) ─┐
                ├─→ WI-3 (resolver + enqueueTaskRun) ─→ WI-4 (POST /tasks) ─→ WI-5 (retries) ─→ WI-6 (auto-retry) ─┐
WI-2 (schema) ──┤                                                                                                  ├─→ WI-10 (rebase + gates) ─→ WI-11 (runbook)
                └─→ WI-7 (task API + template copy) ─→ WI-8 (template-step route) ─→ WI-9 (runner) ────────────────┘
```

Four ordering rules that are not just convenience:

- **WI-2 before everything else.** None of `opensPullRequest` or `pushedBranch`
  exists on the Prisma client until the schema lands and `db:generate` runs, so
  nothing downstream compiles before it.
- **WI-3 before WI-4, WI-5 and WI-6.** All four call the same function; landing a
  caller first leaves the tree not compiling.
- **WI-9 needs WI-2 only**, but it is placed after WI-7/WI-8 so the API side of
  `opensPullRequest` is complete before the runner starts reading it — a
  reviewer bisecting the branch then never sees a commit where the runner
  suppresses PRs based on a field nothing sets.
- **WI-10 before WI-11**, and nothing rebased after WI-11 (§0.1-MF7).

There is no intermediate state in which a partial merge is *dangerous* — the API
is not restarted by this batch, so none of it takes effect until the operator
rebuilds (spec §14.1). The reason to keep the order anyway is that each commit
should build and test green on its own.

---

## 12. What this plan is guessing

- **G1 — How the operator's chain-creation script stops nine tasks from running
  at once.** `POST /tasks` creates the inline run for any chain step with
  `scheduleKind = NOW` and there is no `chainIndex` guard (§0.3-C12); the script
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
- **G3 — The migration timestamp.** `master` is at `b73a4a4` and carries nothing
  later than `20260816180100_tasks_visibility` as of this revision, so the
  suggested `20260817020000_chain_branch_and_pr` sorts last *today*; the batch-4
  chain may land one before this batch does. WI-2 gives the procedure, and
  WI-10 step 3 re-checks it after the rebase.
- **G4 — Query cost of the evidence lookup.** The `findFirst` on `pushedBranch`
  is a scan joined to `Task`; `Run` has no index on `pushedBranch`
  (`schema.prisma:693-700`), though `@@index([repoId])` narrows it. At dogfood
  volume this is microseconds and an index is another migration and a lock for no
  measured benefit. If `Run` ever grows past ~10⁵ rows, `@@index([pushedBranch])`
  is the fix. Recorded, not done.
- **G5 — Whether `deliverWorkspace`'s PR base should be the chain's base rather
  than `repo.defaultBranch`.** `delivery.ts:111` passes
  `--base claim.repo.defaultBranch` unconditionally. For a chain based on the
  repo default that is correct; for a chain the operator based on some other
  branch via `Task.targetBranch`, the PR would target the default anyway. The
  spec does not mention it and A5 keeps PR shaping out of this batch. **Left
  unchanged.** Revision 0 flagged this for the review step to rule on; the review
  did not rule on it, so it stays flagged and unchanged rather than being
  resolved by the plan agent's own judgement.
- **G6 — Whether the R13 activity row is too chatty.** It fires once per run for
  any chain step whose `Task.targetBranch` differs from the computed base —
  which, for a chain created by today's script (every step pointed at step ①'s
  branch), is *every step*. That is the intended signal (it is how the operator
  learns to stop repointing), but if it proves noisy the cheap fix is to emit it
  only when `task.targetBranch` is neither the base nor the shared branch.
- **G7 — Whether a PR-creation failure should fail the run at all.** It does
  today (`runner.ts:248`), non-retryably (`:249-251`), even though the branch is
  already published. This batch stops that from *also* losing the publication
  fact (§0.1-MF3) but does not change the outcome, because failure classification
  is not in this spec. Worth a backlog entry: "a delivered branch with no PR is
  a warning, not a failed run".

---

## 13. Open questions

None blocks implementation; all are recorded here and in the task activity log
so they are not lost.

- **Q1 (from spec §16).** Should `opensPullRequest` be surfaced in the web task
  form and a template step editor? Out of scope here (§10). WI-8 now gives the
  template side an API to call, so the web half is a real option rather than
  "build the route first".
- **Q2 (from spec §16).** The "branch self-healing" prose in steps ⑦⑧ of the
  chain-creation script becomes dead weight once one chain runs green on a shared
  branch (R9). Retiring it is a change to the operator's script, not to this repo.
- **Q3 (new, from §0.1-MF5).** Spec §7.2 names template step **create** routes as
  well as patch. None exists, and a create route means a full authoring surface
  (`stepIndex`, `name`, `assigneeType`, `prompt`, `outputKind`, `approvalGate`,
  `attachmentsFromPrevious`, `runner`, `spawnPolicy`, agent) with no caller today
  — template steps are written only by the seed (§0.3-C4). WI-8 delivers the
  patch half so the accepted field is API-settable; **the create half is
  deliberately not built and is put to the human**: either accept that template
  authoring stays a seed/DB operation for now, or scope a template-editor batch.
  The plan does not decide this on the spec's behalf, and it does not silently
  drop it the way revision 0's D3 did.
- **Q4 (new, from §0.1-MF6 / §0.3-C16).** `packages/api/src/testdb.ts` defaults
  `TEST_DATABASE_URL` to a schema name shared by every workspace on the host and
  then drops it. WI-10 works around this with an environment variable, which is
  enough for this batch. The permanent fix — refuse to run without an explicit
  `TEST_DATABASE_URL`, or derive the schema from the workspace — is a change to
  shared test infrastructure that would land in every in-flight batch at once,
  so it belongs in `docs/BACKLOG-V2.md`, not in this diff.

---

## 14. The constraint that applies to whoever executes this plan

Restated from spec §14, because it governs every work item above:

1. **These changes do not take effect for this chain.** The API is long-lived and
   picks up new code only on a rebuild and restart, which is deliberately held.
   The steps of this very chain will keep opening sibling branches and sibling
   PRs while the fix sits in the tree. **Do not "fix" anything because they did**,
   and do not read this chain's own branches as evidence that the batch failed.
   (This plan's own revision step had to `git fetch` the previous step's branch
   to read the file it was revising — that is the defect, working as designed.)
2. **A defect here does not fail loudly.** It silently mis-delivers every future
   chain's work — a step that pushes to the wrong branch loses that work as far
   as the merger is concerned. Weigh a false green as more expensive than usual;
   that is why every acceptance test in §10 asserts on a row or a recorded
   command rather than on a returned string, and why WI-10 forbids retrying a
   red gate until it passes.
3. **Never restart the runner, the API, or any launchd service, and never merge
   anything.** To observe chain behaviour, use the dbtests against a
   workspace-private test schema (WI-10 step 1; `testdb.ts` refuses a `public`
   schema). Never point a second API process at the live database or at any copy
   of it: a second control plane classifies the live runs as orphans and deletes
   their workspaces, `.git` included, mid-task. That destroyed a workspace on
   2026-08-16.
4. **No artifact, commit message or task output may contain `OPERATOR_TOKEN`'s
   value**, or a database URL with credentials in it. The dbtest helpers set the
   environment variable to the literal `"operator-db-token"`; that is a test
   fixture and is fine.
