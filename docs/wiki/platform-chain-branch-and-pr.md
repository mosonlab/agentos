# Platform chain branches and pull requests

Status: current.

This page describes the runtime contract for API-created task chains: how a
chain chooses its Git head and base, how publication survives runner failure,
and which run is allowed to create the pull request. The main implementation is
in [`packages/db/src/chain-branch.ts`](../../packages/db/src/chain-branch.ts),
[`packages/db/src/workflow.ts`](../../packages/db/src/workflow.ts), the run
creation and claim routes in
[`packages/api/src/app.ts`](../../packages/api/src/app.ts),
[`packages/api/src/reconcile.ts`](../../packages/api/src/reconcile.ts), and
the delivery/provisioning code under
[`packages/runner/src`](../../packages/runner/src). Deployment and recovery
operations are in
[`docs/runbooks/platform-chain-branch-and-pr-rollback.md`](../runbooks/platform-chain-branch-and-pr-rollback.md).

## The runtime contract

For an indexed task chain (`chainId` and `chainIndex` are present) that is not a
template chain, every run uses one derived head:

```text
agentos/chain/<slug>-<fingerprint>
```

The slug is the lowercased `chainId`, with non-alphanumeric runs replaced by
`-`, trimmed, limited to 24 characters, and defaulted to `chain` if empty. The
fingerprint is the first eight lowercase hex characters of
`sha256("<projectId>:<chainId>")`. The function is pure and exported as
`sharedChainBranch` from `@agentos/db`; the name is derived on demand and is
not stored as a separate chain-name column. The project id is part of the hash,
so the same operator-supplied `chainId` in two projects gets different heads.

The head name is the same on two repositories used by one chain, but those are
different Git refs on different remotes. Publication evidence is consequently
scoped by repository as well as project and chain.

Two cases intentionally do not enter this routing:

- A task with no `chainId` keeps ordinary per-run branch behavior and, by
  default, opens a PR.
- A `chainId` row with a null `chainIndex` is treated as the platform's isolated
  1/1 row. It uses ordinary per-run routing and cannot consume or contribute
  publication evidence for indexed siblings with the same chain id.

Template chains keep their existing branch contract. The resolver returns early
for `templateId`, preserving the template's `targetBranch`/branch expression;
`instantiateTemplate` still uses the repository default for the first step,
`branchName` for later steps, and the `branchName` template variable override.
Template chains therefore continue to use their configured `agentos/<chainId>`
style branch rather than the derived `agentos/chain/...` name.

## Where a run's branches are decided

[`resolveRunBranches`](../../packages/db/src/workflow.ts) is the single branch
and base resolver. All five run-creating paths call it for indexed,
non-template chain steps:

| Run creator | Behavior |
| --- | --- |
| `enqueueTaskRun` | Used by successor activation, scheduler/start operations, and other normal queueing paths. |
| `POST /projects/:projectId/tasks` | Builds the first run inline, so it calls the same resolver rather than relying on enqueue code. Only `chainIndex = 0` is admitted inline; later indexed steps remain parked until predecessor activation. |
| `POST /tasks/:taskId/retry` | Recomputes the chain head and base under the task-row lock. |
| `POST /runner/runs/:runId/complete` | The automatic retry path re-reads the task after locking it and resolves the next run after recording the completing run. |
| `reconcileDatabaseRuns` | Lost-lease requeues resolve the chain again after taking the task-row lock. |

This admission rule is load-bearing. API-created chain steps are posted one at
a time; a later `NOW` step is not given a queued run merely because its task
payload requests `NOW`. `activateChainSuccessor` creates it after the preceding
step completes. This prevents two fresh workspaces from pushing divergent
commits to the same new head.

For an indexed, non-template chain task, the resolver produces:

1. `Run.branch = sharedChainBranch(...)` on every newly created run.
2. `Run.targetBranch = sharedChainBranch(...)` only when an indexed task in the
   same project/chain and the same `repoId` has `Run.pushedBranch` equal to that
   shared name.
3. Otherwise, `Run.targetBranch = Task.targetBranch` when set, or the repo's
   `defaultBranch`.

The first run therefore creates the shared ref from the operator's selected
base or repository default. Once a real publication is recorded, later runs
clone the shared ref directly. The chain resolver deliberately does not use a
prior run's `branch` as the base: that would preserve a per-task branch for a
chain spanning an API restart. `Task.targetBranch` remains writable and is the
first-run fallback; when the resolver ignores it, it writes one control-plane
`TaskActivity` explaining the selected base and shared head.

The runner claim also carries `run.pullRequestBase`. For a chain this is the
first chain run's selected base, so a custom initial base remains the PR base
even though later runs target the shared head. A non-chain claim uses the repo
default.

## Publication is a durable fact

`Run.pushedBranch` records the exact ref handed to `git push`. It is not a
second branch-naming mechanism; `sharedChainBranch` remains the only source of
the derived name. It is the only field used as publication evidence by
`resolveRunBranches`, together with matching `repoId`, project, chain, and a
non-null chain index. The resolver intentionally does not infer publication
from `Run.branch`, `Run.status`, or `Run.pushStatus`:

- A failed run's salvage may report the workspace branch in `Run.branch` while
  pushing its WIP commit to a per-run ref.
- A real shared push may be followed by a GitHub error, leaving the run failed
  even though the shared ref exists.

After `git push` succeeds, `deliverWorkspace` immediately calls the fenced
`POST /runner/runs/:runId/publication` endpoint, before GitHub lookup, cleanup,
or terminal completion. Completion preserves an earlier ACK instead of
overwriting it. The small crash window between the remote accepting the push
and the ACK is handled in
[`provisionWorkspace`](../../packages/runner/src/workspace.ts): when the
intended head already exists on the remote, it clones that head instead of the
stale fallback base. The probe is read-only and does not force-push or rewrite
the remote.

Failed-run salvage is deliberately different. `deliverFailedWorkspace` commits
trackable work and pushes `agentos/<taskId>/run-<n>` as WIP. It never pushes the
shared chain head, never opens a PR, and its `pushedBranch` must not count as
chain publication evidence. A salvaged run can therefore have a misleading
workspace `branch` value; `pushedBranch` is the authoritative history signal.

## Pull-request decisions

`opensPullRequest` exists on `Task`, `TaskTemplateStep`, and `Run`, with a
default of `true` everywhere. The migration is additive and has no backfill.
Existing workflows therefore retain PR-opening behavior. The task value is
snapshotted onto every Run at creation, and the claim payload exposes it only
as `claim.run.opensPullRequest`; the runner does not read the live task row.
Consequently, a task PATCH affects the next run created, not a run already
queued. Task PATCH, automatic retry, and lost-lease requeue share the task-row
lock so the snapshot is ordered with the current task value.

The API surfaces are:

- `POST /projects/:projectId/tasks` and `PATCH /tasks/:taskId` accept the task
  flag.
- `POST /task-templates/:templateId/steps` creates a fully specified template
  step with the flag defaulting to `true`; it validates template ownership,
  project-local agent assignment, archived agents, configured webhook-repository
  access, and duplicate step indexes.
- `PATCH /task-templates/:templateId/steps/:stepId` is intentionally bounded to
  the flag and validates template/step ownership.
- Template instantiation and webhook-triggered instantiation copy the template
  step flag onto each Task.

`deliverWorkspace` always pushes first. For a GitHub remote it then checks for
one open PR on the head with `gh pr list --head ... --state open`:

| Run flag | Push | Open-PR lookup | Create PR |
| --- | --- | --- | --- |
| `true` | Always | Always | Only when no open PR exists |
| `false` | Always | Always | Never |

The lookup remains on the `false` path so a documentation step can report the
chain's existing PR. If there is no PR, its successful delivery instructions
name the pushed branch and say that this step does not open a pull request. A
create race is confirmed with another open-PR lookup, so an already-created PR
is reused rather than turning a successful publication into a failure.

If GitHub is unavailable or the remote is not GitHub, a `true` step returns the
existing manual-delivery instruction; a `false` step still reports successful
publication without telling the operator to open a PR. If a `true` step hits a
GitHub lookup/create failure after pushing, the run retains `pushedBranch` and
manual instructions, but the existing runner classification still makes that
run failed and non-retryable. There is no automatic promotion of a later
`false` step to PR opener. The recovery command is documented in the rollback
runbook (replace `master` with the chain's selected integration base when it
was started from a custom branch):

```bash
gh pr create --base master --head 'agentos/chain/<slug>-<fingerprint>' --title '<chain name>'
```

The PR title is the task name for API-created chain steps. Template delivery
retains its existing chain-title behavior by removing the template-step suffix.

## Schema and compatibility boundaries

Migration `20260817020000_chain_branch_and_pr` adds four fields:

- `Task.opensPullRequest BOOLEAN NOT NULL DEFAULT true`
- `TaskTemplateStep.opensPullRequest BOOLEAN NOT NULL DEFAULT true`
- `Run.opensPullRequest BOOLEAN NOT NULL DEFAULT true`
- `Run.pushedBranch TEXT NULL`

There is no backfill and no stored derived chain-branch column. Old code can
run against the additive schema because it ignores these fields. The supported
code-only rollback leaves the columns and successful migration history in
place. A physical removal is a new forward compensating migration; deleting a
Prisma migration ledger row or marking a successful migration rolled back is
not a rollback procedure.

The dbtest harness in
[`packages/api/src/testdb.ts`](../../packages/api/src/testdb.ts) derives a
PostgreSQL schema from the workspace path when `TEST_DATABASE_URL` is not set,
and rejects the public schema. Each workspace therefore resets its own test
schema rather than dropping a sibling workspace's tables. An explicit dedicated
`TEST_DATABASE_URL` remains supported.

## Operational failure modes

### Chains spanning a restart

Routing takes effect when a Run is created; existing Runs are not rewritten.
A chain that crosses the API/runner restart is therefore mixed: old runs keep
their per-task heads, while later runs receive the derived shared head. The
batch is correct for chains created after the restart, not for completing a
mixed chain automatically. Drain chains before a restart, or park their
remaining tasks in `BACKLOG`.

Before the first shared publication, the remaining task's `targetBranch` can
still point at the real predecessor. After shared publication, target overrides
are intentionally ignored; the operator must merge or cherry-pick missing
predecessor commits into the shared head, push without force, and then resume.
The same hazard occurs in reverse after a code-only rollback: remaining steps
fall back to per-task routing and will not automatically contain the previous
shared-head work. The detection SQL and both recovery procedures are in the
[rollback runbook](../runbooks/platform-chain-branch-and-pr-rollback.md).

### Other constraints

- Chains are sequential. An external writer or legacy admission that makes two
  runs push one head concurrently gets a non-fast-forward rejection. The runner
  never force-pushes.
- Publication evidence is remote-specific. A successful push in repository A
  never authorizes a repository-B step to clone the same branch name.
- A null-index chain row is isolated from indexed siblings even when the
  project and `chainId` match.
- A stale runner must be rebuilt with the API. An old runner omits the new PR
  snapshot and publication ACK; the `!== false` compatibility check defaults to
  opening PRs, while remote-head probing reduces the ACK-loss risk. Mixed old
  and new runners are not a supported steady state.
- Approval-gate semantics, web UI for the new flag, retirement of the external
  step-⑦/⑧ self-healing prose, auto-merging, and closing stray PRs remain out
  of scope. The known gate-message defect is unrelated.

## Verification anchors

The behavior is pinned by the unit and database tests under
`packages/api/src/chain-branch.test.ts` and
`packages/api/src/chain-branch.dbtest.ts`, the runner delivery tests, and the
workspace reconciliation test. The frozen
[`packages/api/src/chain.dbtest.ts`](../../packages/api/src/chain.dbtest.ts)
remains unchanged for template and existing chain semantics. The full gates
for this tree are `npm run build`, `npm test`, `npm run test:db`,
`npm run typecheck`, and `npm run db:drift-check`.
