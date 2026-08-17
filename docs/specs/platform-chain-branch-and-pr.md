# Platform repair SPEC — one branch and one pull request per chain

Status: spec (step ① of the nine-step chain, no approval gate)
Author: spec agent, 2026-08-16
Scope authority: the task brief for this batch · `docs/BACKLOG-V2.md` entries
「建链时 ⑥⑦⑧ 的 targetBranch 指向 ① 的 spec 分支」 and 「一链一 PR」 (they are
one defect; this batch closes both) · `packages/db/src/workflow.ts`,
`packages/api/src/templates.ts`, `packages/runner/src/delivery.ts`,
`packages/runner/src/workspace.ts`, `packages/api/src/app.ts` ·
`packages/api/src/chain.dbtest.ts` (existing chain semantics — binding)

---

## 1. Problem and audience

The audience is the single operator (Leo) who runs this platform on itself, and
every agent that executes a chain step.

A nine-step chain created through the API today produces **nine sibling branches
and up to nine pull requests**. Every step after the first bases its workspace on
whatever `targetBranch` a human wrote at chain-creation time and pushes to its
own per-run branch `agentos/<taskId>/run-<n>`. Two consequences, both observed:

1. **Wrong-tree review.** Step ⑥ (code review) clones the branch named in its
   `targetBranch` — in practice step ①'s spec branch — which does not contain
   step ⑤'s implementation. It reviews an empty tree. Steps ⑦⑧ survive because
   the task brief carries a hand-written "branch self-healing" instruction;
   ⑥ has no such instruction, and batch 2.5's ⑥ found the right commit
   (`run-3 @ 267ac80`) by following prose in its brief. That is luck, not design.
2. **PR spam.** Batch 2.5 alone opened nine PRs, four of which could not be
   closed because they had already been merged. Four chains produced 32 PRs.
   The operator has hand-repaired this on three consecutive batches: repointing
   `targetBranch`, picking the merge branch by commit count instead of by chain
   position, closing stray PRs one at a time.

**The machinery already exists and is already tested. One predicate starves it.**

`packages/db/src/workflow.ts:117-122`:

```js
// Template steps after the first one inherit the chain's shared feature branch
// so every step pushes to the same head and the chain lands in one PR; without
// this the workspace falls back to a per-run branch and each step opens its own.
const chainBranch = task.templateId && task.targetBranch && task.targetBranch !== task.repo.defaultBranch
  ? task.targetBranch
  : null;
```

The guard is `task.templateId`. Chains created through `POST /tasks` carry
`chainId` + `chainIndex` and **no** `templateId`, so `chainBranch` is always
`null` for them and `provisionWorkspace` falls back to
`agentos/<taskId>/run-<n>` (`packages/runner/src/workspace.ts:68`).

The PR-reuse half is complete: `deliverWorkspace` looks for an open PR on the
head branch before creating one (`gh pr list --head <branch> --state open`,
`packages/runner/src/delivery.ts:99-104`) and the runner test *"a chain step
reuses the open pull request on its shared head branch"*
(`packages/runner/src/delivery.test.ts:40`) has been green the whole time. It has
been waiting for a shared branch that was never computed.

This batch computes that branch for `chainId` chains, and adds the one piece of
chain data that decides which step opens the pull request.

---

## 2. Goal

For a chain of N steps identified by `(projectId, chainId)`:

- **exactly one branch** carries the whole chain's work, and every step's
  workspace is based on a tree that contains every prior step's work;
- **exactly one pull request** exists for the chain when it ends;
- neither outcome depends on prose in a task description, on the operator
  repointing `targetBranch`, or on the runner knowing what a step is named.

Template-driven chains, which already achieve this, must be **bit-for-bit
unchanged**.

---

## 3. Definitions

**Chain identity.** A chain is the set of tasks sharing `(projectId, chainId)`.
This is already the platform's definition: `activateChainSuccessor` scopes its
successor lookup by `projectId` *and* `chainId`
(`packages/db/src/workflow.ts:242`), and `chainKey()`
(`packages/api/src/chain.ts:61`) is literally `` `${projectId}:${chainId}` ``.
Two projects may hold the same `chainId` string and are two different chains
(`chain.dbtest.ts` E2 asserts this).

**Chain step.** A task with a non-null `chainId`. `chainIndex` may be null; such
a row is its own 1/1 chain and never joins another (`chain.dbtest.ts` E1) — see
§5.1 R4 for its branch.

**Shared chain branch.** The single git branch, defined in §5.1, that every run
of every step of one chain pushes to.

**Base branch.** What `provisionWorkspace` clones (`git clone --branch <base>`),
i.e. `Run.targetBranch`. Distinct from **head branch** (`Run.branch`), which is
what the workspace works on and what `deliverWorkspace` pushes.

---

## 4. Scope summary

| | In scope |
|---|---|
| 1 | `chainId` chains get a shared branch derived from the chain (§5.1), computed on every path that creates a run for a chain step (§5.2) |
| 2 | A base-branch rule that guarantees step N is on a tree containing step N-1's work (§5.3) |
| 3 | Retries land on the shared branch (§5.4) |
| 4 | New chain data `opensPullRequest`; pure-documentation steps push without opening a PR (§5.6) |
| 5 | Additive, reversible migration + rollback runbook (§8, §9) |
| 6 | Template chains provably unchanged (§5.7) |

Out of scope: §10.

---

## 5. Required behaviour

### 5.1 The shared branch name

**R1.** For a task with `chainId != null` and `templateId == null`, the shared
chain branch is:

```
agentos/chain/<slug>-<fingerprint>
```

where, given `key = `${projectId}:${chainId}`` (the existing `chainKey`):

- `fingerprint` = first **8** lowercase hex characters of `sha256(key)`;
- `slug` = `chainId` lowercased, with every character outside `[a-z0-9]`
  replaced by `-`, runs of `-` collapsed to one, leading/trailing `-` stripped,
  then truncated to **24** characters and any resulting trailing `-` stripped.
  If the result is empty, `slug` is the literal `chain`.

Example: `chainId = "38948720-9d1e-4f0e-8b76-1c2a3d4e5f60"` in project
`cmsw…` → `agentos/chain/38948720-9d1e-4f0e-8b76-1a2b3c4d` (the 24-character
slug `38948720-9d1e-4f0e-8b76`, then the fingerprint).

**Why derived and not "step ①'s run branch".** `agentos/<step-1-task-id>/run-1`
is an accident of which task happened to be created first, it reads as one
step's branch when it is the chain's, and it is unavailable to the very first
run (which is the one that must create it). Deriving from the chain makes the
name a pure function of chain identity: any code, any test, and the operator can
compute it without reading a Run row.

**Why the fingerprint.** `chainId` is operator-supplied
(`z.string().trim().min(1).max(100)`, `app.ts:236`) and may contain characters
that are not legal in a git ref, may collide after slugging, and — per E2 —
may be reused by another project. Hashing `(projectId, chainId)` makes the
branch unique exactly where the platform considers the chains different, and
sanitising makes it a legal ref. Both halves are needed: the slug is for humans,
the fingerprint is for correctness.

**R2.** Two chains in different projects that share a `chainId` get different
branches (different `projectId` → different fingerprint), even when both target
the same repo. Two chain steps in the same chain but on different repos get the
same branch name on each repo; those are different refs in different
repositories and do not interact.

**R3.** The name is deterministic and side-effect-free: same
`(projectId, chainId)` always yields the same string. It is never read back from
a Run row to be recomputed. Implementations must expose it as one exported pure
function in `@agentos/db` (name suggestion: `sharedChainBranch({projectId,
chainId})`) so the API, the enqueue path and the tests all agree by construction.

**R4.** A task with `chainId != null` **and `chainIndex == null`** is its own
1/1 chain (E1). It still gets the shared branch from R1 — which for a 1/1 chain
is simply a stable branch name for that one task. No special case.

**R5.** A task with `chainId == null` is unaffected: `Run.branch` stays null at
enqueue and the runner keeps using `agentos/<taskId>/run-<n>`.

### 5.2 Every path that creates a run for a chain step must set the head branch

**R6.** The following code paths create `Run` rows and must all produce
`Run.branch = sharedChainBranch(...)` for a chain step:

| Path | File | Today |
|---|---|---|
| Chain successor activation, scheduler, operator "Start now" | `enqueueTaskRun`, `packages/db/src/workflow.ts:92` | sets `branch` from `chainBranch`, `templateId`-gated |
| **First run of an API-created task** | `POST /tasks`, `packages/api/src/app.ts:1675-1700` | **builds the Run inline and never sets `branch`** |
| Operator retry | `POST /tasks/:id/retry`, `app.ts:1904` | `branch: last.branch` — inherits, correct once the first run is right |
| Lost-lease requeue | `reconcileDatabaseRuns`, `packages/api/src/reconcile.ts:159` | copies `targetBranch` but **not** `branch` |

The `POST /tasks` and reconcile paths are the reason a partial fix would be
worse than none: fixing only `workflow.ts` leaves step ① of an API chain on
`agentos/<taskId>/run-1` while ②–⑨ share the chain branch, i.e. step ①'s work is
silently absent from the chain's tree. **All four paths are in scope.**

The plan step should prefer collapsing these onto one helper over four copies of
the same expression; the spec requires only that the resulting `Run.branch` is
identical on all four.

**R7.** `deliverFailedWorkspace` (`delivery.ts:137`) keeps pushing salvage
commits to `agentos/<taskId>/run-<n>`, **not** to the shared branch. A failed
run's half-finished tree must never enter the chain's branch. This is existing
behaviour and is now load-bearing; state it in a code comment.

### 5.3 Base branch: step N starts from a tree containing step N-1's work

**R8.** For a run being created for task T (chain step, `templateId == null`),
`Run.targetBranch` is the first of these that applies:

1. the previous run's `branch` for the same task, if any — retry semantics,
   unchanged from today (`prior?.branch`);
2. `sharedChainBranch(T)` — **if** the shared branch is known to exist on the
   remote, defined as: some `Run` whose task is in the same chain
   (`projectId` + `chainId`) has `branch = sharedChainBranch(T)` and
   `pushStatus = SUCCEEDED`;
3. `T.targetBranch`, if set;
4. `T.repo.defaultBranch`.

**Why rule 2 is conditional on a successful push.** `provisionWorkspace` runs
`git clone --branch <base> --single-branch`, which **fails** if the ref does not
exist. The first step of a chain must therefore clone the repo default (or the
operator's `targetBranch`) and create the shared branch locally
(`git switch -c`, `workspace.ts:71`); delivery's
`git push --set-upstream origin <branch>` then creates the remote ref — this
works even when the branch has no commits ahead of its base, so a documentation
step that writes one file, and even a step that writes nothing, still publishes
the branch. Every later step then satisfies rule 2 and clones the shared branch
directly; `branch === target`, the `switch -c` is skipped, and the step commits
straight onto the chain's head.

**Why rule 3 survives.** It is what keeps a chain that was started before this
change from getting worse (§8.2) and it preserves the template contract (§5.7).

**R9.** Consequence to be stated in the code and in the runbook: step ⑥ is now
*automatically* on a tree containing step ⑤'s work. The "branch self-healing"
prose in step ⑦⑧ task briefs becomes redundant. **Removing that prose is not
part of this batch** — the operator's chain-creation script is outside this
diff — but the spec records that it may be retired once one chain has run green
under the new behaviour.

### 5.4 Retries

**R10.** A retried step (`run-2`, `run-3`, …) pushes to the same shared branch.
Rule R8.1 already gives the retry the previous run's branch as its base, and
`Run.branch` is inherited from the previous run (`retry`) or recomputed
identically (`enqueueTaskRun`, `reconcile`) — all three yield the shared branch.
Batch 2.5's step ⑤ succeeded on its third run; this is not hypothetical.

**R11.** A retry whose predecessor never pushed (`pushStatus != SUCCEEDED`)
must not be left cloning a ref that does not exist. If R8.1's branch is the
shared branch and no successful push to it exists, fall through to R8.3/R8.4 —
i.e. rule 1 applies only when the branch it names is known to exist by the same
test as rule 2, or is a per-run branch that a salvage push created. Practical
statement: **`Run.targetBranch` must never name a ref the implementation cannot
show evidence of.** When no evidence exists, base on the repo default and let
the push either fast-forward or fail loudly.

### 5.5 What `targetBranch` means afterwards

**R12.** For chain steps, `Task.targetBranch` stops being the routing knob. It
becomes *the base for the chain's first push only* (R8.3) and is ignored
thereafter. It stays **writable** through `POST /tasks` and `PATCH /tasks/:id`:
the field is meaningful for non-chain tasks, and rejecting it for chain steps
would break the operator's existing chain-creation script for no benefit.

**R13.** Silent ignoring is a footgun, so when a run is created for a chain step
whose `Task.targetBranch` is set to something other than the value R8 selects,
the platform writes one `TaskActivity` row on that task:

> `targetBranch '<x>' is not used for chain steps; this run is based on '<base>' and pushes to '<shared>'`

One row per run, `actorType: "control-plane"`. This is how the operator finds
out that hand-repointing is no longer necessary.

### 5.6 Not every step opens a pull request

**R14.** New boolean chain data `opensPullRequest`, on `Task` and on
`TaskTemplateStep`, default **`true`** (§7 for the schema).

- **Default for non-chain tasks: `true`.** A one-off agent task keeps opening
  its PR exactly as today.
- **Default when unset for chain steps: `true`.** The chain creator (the
  operator's script, or a future UI) sets `false` on pure-documentation steps —
  spec ①, plan ②, plan review ④, review ⑥⑦, wiki ⑨ in the current nine-step
  shape — leaving the implementation step ⑤ (and any other step that sets it
  `true`) to open the chain's one PR.
- `TaskTemplateStep.opensPullRequest` is copied into the created `Task` at
  instantiation (`packages/api/src/templates.ts:88-102`). Existing template rows
  default `true`, so template behaviour is unchanged (§5.7).

**R15.** The runner must decide from this field alone. **Grepping step names,
output kinds, or task names inside the runner is forbidden** (BACKLOG-V2 states
this explicitly). The field travels to the runner in the claim payload — the
claim already returns the whole `task` row (`app.ts:2295`, `2394`), so this is a
type addition in `packages/runner/src/api.ts` (`ClaimedTask["task"]`), not a new
query.

**R16.** `deliverWorkspace` behaviour by flag, for a run that succeeded:

| `opensPullRequest` | push | `gh pr list --head` | `gh pr create` | result |
|---|---|---|---|---|
| `true` | yes | yes | only if no open PR | `pullRequestUrl` of the reused or created PR |
| `false` | yes | yes | **never** | `pullRequestUrl` of an existing open PR if there is one; otherwise no PR and `deliveryInstructions` naming the branch |

The lookup is kept for `false` so that a documentation step running *after* the
implementation step still reports the chain's PR on its Inbox gate card and in
`GET /tasks/:id`. Only *creation* is suppressed.

**R17.** `deliveryInstructions` when `opensPullRequest = false` and no open PR
exists must name the branch, e.g.:
`Branch '<shared>' was pushed. This step does not open a pull request.`
It must not read like a failure: `pushStatus` is `SUCCEEDED` and the run is
successful.

**R18.** Failure case — *the step that was supposed to open the PR fails and a
later step succeeds.* No automatic promotion. The later steps have
`opensPullRequest = false` and will not create a PR; the chain ends with a
pushed branch and no PR, every step's `deliveryInstructions` naming the branch.
Recovery is one operator command, which the rollback runbook must include:

```bash
gh pr create --base master --head agentos/chain/<slug>-<fingerprint> --title '<chain name>'
```

Rationale, and this is an assumption (A4): promotion would require the runner to
know the chain's shape at delivery time — "am I the last step that will run?" —
which is exactly the chain knowledge the runner is forbidden to acquire, and a
wrong guess opens a second PR, which is the defect being fixed. Failing to a
one-line manual recovery is cheaper than the machinery.

### 5.7 Template chains must not change

**R19.** `packages/api/src/chain.dbtest.ts` must pass **unmodified**. Its 23
tests define chain advance, CAS, parked successors, gates and template
instantiation semantics.

**R20.** The shared-branch derivation of §5.1 applies **only** when
`templateId == null`. Template chains keep today's expression verbatim. The
guard becomes, in effect:

```
if (task.templateId) → today's chainBranch expression, unchanged
else if (task.chainId) → sharedChainBranch({projectId, chainId})
else → null
```

Unifying the two is a tempting simplification and is **explicitly forbidden in
this batch**: template branch naming is a user-visible contract (below) and the
risk is asymmetric — a "simplification" that renames a template chain's branch
mid-flight strands work on a branch nobody merges.

**Load-bearing template behaviours** the implementation must not touch:

1. `templates.ts:101` — step ①'s `targetBranch` is `repo.defaultBranch`, every
   later step's is `branchName`. The `task.targetBranch !== repo.defaultBranch`
   half of the existing guard is what keeps step ① from trying to clone a branch
   that does not exist yet. Deleting it breaks template chains at step ①.
2. `templates.ts:110` — after enqueueing step ①, the run's `branch` is
   overwritten to `branchName`. That is how a template chain's first step lands
   on the shared branch. Keep it.
3. `templates.ts:76` — `branchName` defaults to `agentos/<chainId>` but is
   overridable by the `branchName` template variable. Operators rely on this;
   the new derived name must not replace it for template chains.
4. `pullRequestTitle` (`delivery.ts:67`) — the PR is titled after the chain, not
   the step, by stripping the `": <step>"` suffix using `templateStep.name`.
   Unchanged. For `chainId` chains without a `templateStep`, the title stays
   `task.name` as today (A5).
5. `enqueueTaskRun`'s archived-task / archived-assignee ordering, the savepoint
   around the successor enqueue, and the parked-successor guard — untouched.

---

## 6. Concrete scenarios

Written as given/when/then so the plan step can turn each into a test. "Chain"
means `chainId` chain unless stated.

**S1 — A fresh nine-step chain produces one branch.**
Given a project, repo (`defaultBranch = master`) and a chain of 9 tasks created
through `POST /tasks` with `chainId = C`, `chainIndex = 0…8`, and each step's
`targetBranch` unset;
when step ① is enqueued and each step completes in turn (`activateChainSuccessor`
advancing the chain);
then all 9 runs have `Run.branch = agentos/chain/<slug>-<fp>` — one distinct
value across the whole chain — and `Run.targetBranch` is `master` for step ①
and `agentos/chain/<slug>-<fp>` for steps ②–⑨.

**S2 — Only one step opens a PR.**
Given S1's chain with `opensPullRequest = false` on steps ①②④⑥⑦⑨ and `true` on
③⑤⑧ *(the exact mapping is the chain creator's, not the platform's)*;
when each step delivers;
then `gh pr create` is invoked at most once for the whole chain: the first
`true` step with no open PR on the head creates it, every later step — `true` or
`false` — finds it via `gh pr list --head <shared> --state open` and reuses it.
Exactly one open PR exists on the shared head; this is a GitHub invariant, and
the existing runner test already pins the reuse half.

**S3 — A pure documentation step pushes and opens nothing.**
Given step ① with `opensPullRequest = false` and no PR open on the shared branch;
when it delivers;
then `git push --set-upstream origin agentos/chain/<slug>-<fp>` ran, the run's
`pushStatus = SUCCEEDED`, `pullRequestUrl` is null, `deliveryInstructions` names
the branch, and no `gh pr create` was invoked.

**S4 — Step ⑥ reviews step ⑤'s work.**
Given step ⑤ completed with `pushStatus = SUCCEEDED` on the shared branch;
when step ⑥ is enqueued by `activateChainSuccessor`;
then `Run.targetBranch` for ⑥ is the shared branch (R8.2), the workspace clones
it, `branch === target` so no `switch -c` happens, and the tree contains ⑤'s
commits. No task-description prose was consulted.

**S5 — A retry lands on the shared branch.**
Given step ⑤'s `run-1` failed after the chain branch already existed;
when the operator retries (`POST /tasks/:id/retry`) or the reconciler requeues
after a lost lease;
then `run-2` has `branch = <shared>` and `targetBranch = <shared>`, and its
delivery pushes to `<shared>`. `run-1`'s salvage commits remain on
`agentos/<taskId>/run-1` and never enter the chain branch (R7).

**S6 — The first step fails before ever pushing.**
Given step ① failed and the shared branch does not exist on the remote;
when step ① is retried;
then `run-2`'s base falls through to `master` (R11), the workspace re-creates
the shared branch with `switch -c`, and delivery creates it on the remote.
Nothing clones a nonexistent ref.

**S7 — Template chain, unchanged.**
Given a three-step template instantiated through `instantiateTemplate`;
when the chain runs;
then every branch, base and PR is byte-identical to today's behaviour, including
a `branchName` variable override, and `chain.dbtest.ts` passes unmodified.

**S8 — Two projects, one `chainId`.**
Given projects P1 and P2 each holding a chain with `chainId = C` on the same
repo;
when both run;
then they use two different branches (different fingerprints) and neither
observes the other's steps. `GET /tasks/:id/chain` grouping is unchanged.

**S9 — Operator sets `targetBranch` on a chain step anyway.**
Given step ⑦ created with `targetBranch = agentos/<step-1-id>/run-1` (today's
habit);
when the shared branch already carries a successful push;
then R8.2 wins, the run bases on the shared branch, and one `TaskActivity` row
(R13) records that `targetBranch` was ignored.

**S10 — A 1/1 chain row (`chainIndex = null`).**
Given a task with `chainId` set and `chainIndex` null (E1);
when it runs;
then it uses the derived branch for its own `(projectId, chainId)` and its
`opensPullRequest` default (`true`) makes it behave exactly like an ordinary
task, except for the branch name.

---

## 7. Data and interface changes

### 7.1 Schema (`packages/db/prisma/schema.prisma`)

Additive only, two columns, both defaulted, no backfill:

```prisma
model Task {
  // …
  opensPullRequest   Boolean          @default(true)
}

model TaskTemplateStep {
  // …
  opensPullRequest        Boolean      @default(true)
}
```

Migration name: `2026081700xxxx_chain_opens_pull_request` (timestamp per the
directory's convention, e.g. `20260816180100_tasks_visibility`). Two
`ALTER TABLE … ADD COLUMN "opensPullRequest" BOOLEAN NOT NULL DEFAULT true`
statements. Both tables are small; a defaulted non-null add is metadata-only on
PostgreSQL 11+ and takes no table rewrite. Reversible by `DROP COLUMN` (§9).

**No new column stores the branch name.** It is derived (R3). A stored column
would be a second source of truth that can disagree with the function.

### 7.2 API

| Surface | Change |
|---|---|
| `POST /tasks` | accepts `opensPullRequest?: boolean` (default `true`); the inline first-run creation sets `branch` for chain tasks per R6 |
| `PATCH /tasks/:id` | accepts `opensPullRequest`; it takes effect on the *next* run created, not on a run already queued |
| `GET /tasks/:id`, `GET /tasks` | the field is part of the task row and rides along; no shape change needed beyond it appearing |
| `POST /templates/:id/instantiate`, `POST /hooks/templates/:id` | copy `TaskTemplateStep.opensPullRequest` onto each created Task |
| Template step create/patch routes | accept `opensPullRequest` (default `true`) |
| `POST /runner/tasks/claim` | payload gains `task.opensPullRequest` implicitly (the whole task row is returned today) |
| `GET /session/runs/:runId/status` | unchanged; the agent does not need this field |

No breaking change to any existing field. Clients that do not send
`opensPullRequest` get today's behaviour.

### 7.3 Runner

- `ClaimedTask["task"]` (`packages/runner/src/api.ts:17`) gains
  `opensPullRequest: boolean`. It must be **required** in the type, so a missing
  field is a compile error rather than a silent `undefined` → falsy → "never
  open a PR", which would be the expensive failure (§11).
- `deliverWorkspace` reads `claim.task.opensPullRequest` (R16). Its signature
  otherwise unchanged; `deliverFailedWorkspace` unchanged (R7).
- `runner.ts:232` call site unchanged.

### 7.4 `@agentos/db`

- New exported pure function `sharedChainBranch({ projectId, chainId })` (R1/R3).
- `enqueueTaskRun` computes `branch`/`targetBranch` per R8/R11.
- One shared helper used by `POST /tasks`, retry and reconcile (R6).

### 7.5 Web

Out of scope for behaviour, but the field is now user-visible data. If the web
package builds a task form that posts a fixed field set, it must keep compiling;
surfacing a checkbox is **not** required in this batch.

---

## 8. Migration and in-flight chains

### 8.1 Deploy shape

1. `npm run db:validate` → `npm run db:migrate` → `npm run db:generate` →
   `npm run db:drift-check` (must exit 0).
2. `npm run build`, then the operator restarts the API and the runner **at a
   time of their choosing**. No step of this batch restarts anything.
3. The new columns are defaulted; running the new schema under the old build is
   harmless (old code ignores the columns), so the migration may be applied
   before the restart.

### 8.2 Chains in flight at the restart

**The change takes effect at run-creation time.** A chain that started under the
old behaviour therefore ends up **mixed**: runs already created keep the
per-task branches they were given; steps not yet activated get the shared
branch.

Concretely, for a chain whose steps ①–⑤ already ran:

- ①–⑤'s work sits on `agentos/<taskId>/run-<n>` branches, with up to five PRs
  already open.
- ⑥ is enqueued after the restart. No run in that chain has
  `branch = <shared>` with `pushStatus = SUCCEEDED`, so R8.2 does not apply and
  the base falls through to R8.3 — the operator's hand-set `targetBranch` — or
  R8.4, `master`. Its head is the shared branch.
- So ⑥ bases on whatever `targetBranch` says (the operator's existing manual
  repair still works, and is still required) and pushes to a *new* shared
  branch, which opens a *new* PR if ⑥ has `opensPullRequest = true`.

**The honest statement: a chain that spans the restart is finished by hand, and
this batch is only correct for chains created after it.** The graceful part is
that R8.3 keeps the operator's existing repair lever working; the ungraceful
part is that the chain still ends with more than one PR. This is stated here so
it is not discovered.

The runbook (§9) must carry:

- **Preferred procedure: drain.** Let in-flight chains finish, or park their
  remaining steps in `BACKLOG` (which `parkedReason` already handles safely),
  before restarting the API.
- **Detection query** for mixed chains after a restart:

  ```sql
  SELECT t."chainId", t."projectId", t."chainIndex", t.name, r.branch, r."pushStatus"
    FROM "Task" t JOIN "Run" r ON r."taskId" = t.id
   WHERE t."chainId" IS NOT NULL AND r.branch NOT LIKE 'agentos/chain/%'
     AND EXISTS (SELECT 1 FROM "Task" s
                  WHERE s."chainId" = t."chainId" AND s."projectId" = t."projectId"
                    AND s.status IN ('todo','doing','backlog'))
   ORDER BY t."chainId", t."chainIndex";
  ```

- **Manual completion**: for a mixed chain, the operator merges the per-step
  branches as they do today, or re-bases the remaining steps by setting each
  remaining task's `targetBranch` to the real predecessor branch (R8.3 honours
  it) and closes the stray PRs.

**Existing tasks are not rewritten.** No backfill sets `opensPullRequest = false`
on historical documentation steps: they are done, and rewriting completed rows
would change what the audit trail says happened.

---

## 9. Rollback runbook

A new file `docs/runbooks/platform-chain-branch-and-pr-rollback.md`, following
the shape of `docs/runbooks/batch-2.5-rollback.md` (deploy order → the traps →
code-only rollback → schema rollback in reverse → what is lost). It must name:

- **The exact revert.** The commit(s) touching `packages/db/src/workflow.ts`,
  `packages/api/src/app.ts`, `packages/api/src/templates.ts`,
  `packages/runner/src/api.ts`, `packages/runner/src/delivery.ts`, plus the
  migration directory name.
- **Schema rollback**, exactly:

  ```sql
  ALTER TABLE "Task" DROP COLUMN "opensPullRequest";
  ALTER TABLE "TaskTemplateStep" DROP COLUMN "opensPullRequest";
  ```

  Safe in either order; nothing references them. Code-only rollback is also
  safe: old code ignores both columns.
- **The one trap**: after a code-only rollback, a chain that is *mid-flight on a
  shared branch* reverts to per-task branches for its remaining steps, so its
  step N+1 bases on `targetBranch`/`master` and **will not contain step N's
  work**. Same mixed-chain hazard as §8.2, mirrored. The runbook must say:
  drain or park in-flight chains before rolling back, and list the same
  detection query.
- **The manual PR command** from R18.
- The runbook must not restart anything; service management is the operator's.

---

## 10. Explicitly out of scope

- Changing what the nine steps are, their agents, or their models.
- **Approval-gate semantics.** The known defect 「闸门消息永远关不掉」
  (`docs/BACKLOG-V2.md`; the gate is opened in `activateChainSuccessor` and
  closed in the task PATCH route — the line numbers quoted in the backlog predate
  this batch) is real, adjacent, and **not this batch's**. Do not fold it in,
  do not "while I'm here" it.
- Workspace provisioning, dependency caching, retry policy. In particular, no
  fallback logic is added inside `provisionWorkspace`: if a base ref is missing
  the clone fails loudly and the run fails. §5.3 solves this in the data layer
  instead, where it is testable without git.
- Retiring the "branch self-healing" prose from the operator's chain-creation
  briefs (R9) — that script is outside this repo's diff for this batch.
- Any web UI for `opensPullRequest` beyond keeping the bundle compiling.
- Auto-merging, auto-closing stray PRs, or any GitHub write beyond
  `gh pr create` on the shared head.
- Making concurrent chain steps safe on one branch. Chains are sequential today
  (`activateChainSuccessor` activates at most one successor). If two runs ever
  share a head concurrently, the second push is rejected as non-fast-forward —
  loud, not silent. Noted, not fixed.

---

## 11. Failure behaviour and edge cases

| # | Situation | Required behaviour |
|---|---|---|
| E1 | Shared branch does not exist on the remote and a run bases on it | Must not happen: R8.2/R11 require evidence of a successful push. If it happens anyway, `git clone --branch` fails, the run fails during provisioning with the existing failure class, and the retry re-derives the base. |
| E2 | Step ① pushed successfully but with zero commits ahead of `master` | Fine. `git push -u origin <branch>` creates the remote ref regardless; later steps clone it. |
| E3 | Step N's push is rejected (non-fast-forward, e.g. someone pushed to the shared branch by hand) | `deliverWorkspace` already returns `pushStatus: FAILED` with the git message and a `failureClass`. No force push, ever. |
| E4 | `gh` unavailable / remote not GitHub | Existing `manual()` path; with `opensPullRequest = false` the message must still be the "no PR by design" wording of R17, not "open a PR manually". |
| E5 | `gh pr list` returns a *merged or closed* PR on the head | Already handled: only `--state open` is queried. A merged PR is never reused; a `true` step opens a new one, which is correct — the merged one is gone. |
| E6 | The chain's only `opensPullRequest = true` step fails | R18: chain ends with a branch and no PR; recovery is one `gh pr create`. |
| E7 | A chain step's task is archived / parked in `BACKLOG` | Unchanged (`parkedReason`); no branch is computed because no run is created. |
| E8 | `chainId` contains only characters that slug to nothing (e.g. `"…"`) | `slug = "chain"`, fingerprint still distinguishes. Branch is legal. |
| E9 | Two chains whose `chainId`s slug identically (e.g. `"a/b"` and `"a-b"`) | Different `sha256(key)` → different fingerprints → different branches. |
| E10 | `opensPullRequest` missing from an old runner build's claim payload handling | Prevented by the required (non-optional) field in `ClaimedTask` (§7.3). A stale runner binary against a new API is an operator concern, called out in the runbook. |
| E11 | Reconciler requeue after a lost lease | R6: the new run gets the shared branch, same as a retry. |
| E12 | Non-chain task | Nothing changes: no `chainId`, no shared branch, `opensPullRequest` defaults `true`. |

---

## 12. Verification — how a reviewer proves this works

### 12.1 Automated (the acceptance bar)

All tests must be **assertions on the branch and PR actually produced**, never
"the function returned the string I expected".

1. **dbtest, one branch per chain** (`packages/api/src/chain.dbtest.ts` is
   frozen — add a new file, e.g. `packages/api/src/chain-branch.dbtest.ts`):
   build a project/repo/agent + a `chainId` chain of ≥3 tasks through the real
   API (`POST /tasks`), drive it with real `completeRun`/`activateChainSuccessor`
   calls, then assert `SELECT DISTINCT branch FROM "Run"` over the chain's runs
   has **exactly one row**, and that it equals `agentos/chain/<slug>-<fp>`.
2. **dbtest, base branch**: in the same chain, assert step ①'s
   `Run.targetBranch = repo.defaultBranch` and step ②'s and ③'s
   `Run.targetBranch = <shared>` once a prior run has `pushStatus = SUCCEEDED`
   — and that step ②'s base falls back when it does not (S6).
3. **dbtest, retry**: fail step ②'s run, retry via the route, assert `run-2`'s
   `branch` is the shared branch and its `targetBranch` is not a per-run branch.
4. **dbtest, first run**: assert the run created inline by `POST /tasks` for a
   chain task already carries the shared branch (the R6 trap).
5. **dbtest, two projects one chainId**: assert two distinct branches (S8).
6. **runner test** (`packages/runner/src/delivery.test.ts`): with
   `opensPullRequest = false`, assert the recorded command list contains the
   `git push` and contains **no** `gh pr create`; with `true` and an open PR on
   the head, assert reuse (existing test, unmodified).
7. **runner test**: with `opensPullRequest = false` and no open PR, assert
   `pullRequestUrl` is undefined and `deliveryInstructions` names the branch.
8. **`packages/api/src/chain.dbtest.ts` passes unmodified.** If a diff to that
   file is needed, the change is wrong (or the plan step must argue the case
   explicitly and get it approved at the plan-review gate).
9. **Template regression**: a dbtest instantiating a template chain and
   asserting the branch is still `agentos/<chainId>` (and still overridable by
   the `branchName` variable) — i.e. the derived name did **not** leak into
   template chains.

"Exactly one PR" is proven by composition, since no test may call GitHub:
one branch (test 1) × delivery reuses any open PR on that head (test 6, existing)
× non-PR steps never create (test 6) ⇒ at most one `gh pr create` per chain.
The composition argument belongs in a comment on test 1, so a later reader knows
why no test asserts a PR count.

### 12.2 Gates

```bash
npm run build
npm test            # full workspace suite
npm run test:db     # dbtests (@agentos/api), where the chain assertions live
npm run typecheck
npm run db:drift-check   # must exit 0
```

All green, after rebasing onto the latest `origin/master` (batch 1 and the
batch 4 fixes chain are in flight; see §13).

### 12.3 Manual review checklist

- `grep -rn "run-" packages/runner/src` shows the per-run branch pattern only in
  `provisionWorkspace`'s fallback and in `deliverFailedWorkspace` (R7).
- No step-name, output-kind or task-name string matching in
  `packages/runner/src` decides PR creation (R15).
- The derived branch function is used, not re-implemented, in all four
  run-creating paths (R6).
- The rollback runbook exists, names the exact revert and the migration, and
  carries the mixed-chain warning and the manual `gh pr create` line.
- No artifact, commit message or task output contains `OPERATOR_TOKEN`.

**A reviewer cannot verify this by watching this chain.** See §14.

---

## 13. Concurrency with other chains

Two other chains are in flight. Batch 1 (Settings + i18n) is mostly `apps/web`
but may touch `packages/api/src/app.ts`. The batch 4 fixes chain touches
`packages/db/src/usage.ts`, `packages/db/prisma/backfill-session-usage.ts` and
the session ingest path in `packages/api/src/app.ts`. The diff for this batch
must stay inside the chain/delivery machinery: `workflow.ts`, `templates.ts`,
the task-creation/retry/claim regions of `app.ts`, `reconcile.ts`,
`packages/runner/src/{api,delivery}.ts`, the schema + migration, tests, spec,
runbook. At the fixes step, rebase onto the latest `origin/master` before the
final push and re-run every gate in §12.2 after rebasing. Migration timestamps must
sort after any migration that lands on `master` first — check before naming.

---

## 14. The thing that makes this batch unusual

**This batch modifies the machinery that is running it.** The chain executing it
is dispatched by `enqueueTaskRun` and delivered by `delivery.ts`.

1. **These changes do not take effect for this chain.** The API is a long-lived
   process and picks up new code only when the operator rebuilds and restarts
   it, which is deliberately held. This chain's own steps will keep opening
   sibling branches and PRs. **Do not "fix" anything because they did.**
2. **A defect here does not fail loudly** — it silently mis-delivers every
   future chain's work. A step that pushes to the wrong branch loses that work
   as far as the merger is concerned. Weigh a false green as more expensive than
   in an ordinary batch, and prefer tests that assert on the branch and PR
   actually produced over tests that assert a function returned an expected
   string.
3. **Never restart the runner, the API, or any launchd service, and never merge
   anything.** To observe chain behaviour, write a dbtest against a scratch
   database built from migrations with fixture rows — never a dump of the live
   one, and never point a second API process at it. (A second control plane
   against the live database, or any copy of it, classifies the live runs as
   orphans and deletes their workspaces, including `.git`, mid-task. This
   destroyed a workspace on 2026-08-16.)

---

## 15. Assumptions

Each is the simplest reading of an ambiguity; each is a decision the plan or
review steps may overturn with a stated reason.

- **A1 — Branch name shape.** `agentos/chain/<slug>-<fingerprint>` with an
  8-hex fingerprint of `${projectId}:${chainId}` and a 24-character slug
  (§5.1). The backlog recommends 「`agentos/chain/<chainId 前缀>`」; the
  fingerprint is added because `chainId` is free-form and project-scoped, and
  a prefix alone is neither ref-safe nor unique.
- **A2 — Template chains keep their own naming.** The derived name applies only
  when `templateId == null` (R20). Unifying is a separate, riskier change.
- **A3 — `opensPullRequest` defaults to `true` everywhere**, including chain
  steps, so the migration is behaviour-preserving and a chain creator opts
  documentation steps *out*. The alternative (default `false` for chain steps)
  would silently stop PRs for every existing chain-shaped workflow.
- **A4 — No PR-opening promotion** when the designated step fails (R18).
- **A5 — PR title for `chainId` chains** stays `task.name` (there is no
  `templateStep.name` to strip). A `chainId` chain's PR is therefore titled
  after whichever step opened it. Cosmetic; changing it means putting a chain
  name in chain data, which this batch does not do.
- **A6 — `Task.targetBranch` stays writable** for chain steps and acts as the
  base for the chain's first push (R12), with an activity note when ignored
  (R13). The alternative — rejecting the field with a 400 — would break the
  operator's existing chain-creation script.
- **A7 — Mixed chains across the restart are finished by hand** (§8.2). No
  migration attempts to move already-created runs onto the shared branch;
  rewriting a run's branch would not move the git commits.
- **A8 — No stored branch column.** The name is derived on demand (R3).
- **A9 — The `false` path still queries `gh pr list`** so a late documentation
  step reports the chain's PR (R16). The alternative saves one subprocess call
  and blinds the gate card.

## 16. Open questions

None blocking. Two the operator may want to answer later, recorded so they are
not lost:

- **Q1** — Should `opensPullRequest` be surfaced in the web task form and the
  template step editor? Out of scope here (§10); worth a backlog entry.
- **Q2** — Once one chain has run green on a shared branch, the "branch
  self-healing" prose in steps ⑦⑧ of the chain-creation script becomes dead
  weight (R9). Retiring it is a change to the operator's script, not to this
  repo.
