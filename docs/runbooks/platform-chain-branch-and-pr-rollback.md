# Runbook — platform repair: one branch and one PR per chain

Covers the four additive columns, the derived chain branch, the five
run-creating paths that now share one resolver, the `opensPullRequest` flag and
the runner's delivery change.

**What changes for the operator.** A chain created through `POST /tasks` with a
`chainId` now runs every step on one branch, `agentos/chain/<slug>-<fingerprint>`,
and lands as one pull request. Repointing a later step's `targetBranch` at the
previous step's branch — the manual repair that steps ⑦⑧ of the chain-creation
script describe — becomes unnecessary. `targetBranch` stays writable; for a
chain step it no longer routes, and one `TaskActivity` row per run says so.

## 1. Deploy order

```bash
npm run db:generate
cd packages/db && npx prisma validate            # DATABASE_URL bound explicitly, see below
cd packages/db && npx prisma migrate deploy      # 20260817020000_chain_branch_and_pr
npm run db:drift-check                           # must exit 0
npm run build
# then, at a time of the operator's choosing: restart the API and the runner
```

Use `prisma migrate deploy`, not `npm run db:migrate`. The latter is
`prisma migrate dev`, which wants a shadow database and can offer to **reset**
the target when it sees drift — the wrong tool for a live database.

`DATABASE_URL` comes from the operator's own environment or the repository root
`.env`; every `db:*` script shells through `dotenv -e ../../.env`, and a fresh
agent workspace has only `.env.example`, so bind it explicitly there. **Never
print its value, and never write it into a commit, an artifact or a task
output.** The same goes for the operator token.

**This runbook restarts nothing and touches no launchd service.** Applying the
migration before the restart is safe and is the intended shape: all four columns
are additive and defaulted-or-nullable, and the running build does not know they
exist. The API and the runner pick up the new behaviour only when the operator
rebuilds and restarts them.

The runner must be rebuilt too, not only the API — see the stale-runner note in
§7.

## 2. The exact revert

Commits on this branch, oldest first:

| Commit | Work item |
|---|---|
| `cc87c9e` | WI-1 `sharedChainBranch` |
| `6a1aa8b` | WI-2 schema + migration |
| `d0db3e1` | WI-3 `resolveRunBranches` + `enqueueTaskRun` |
| `7226cec` | WI-4 `POST /tasks` inline first run |
| `91c34b8` | WI-5 operator retry + lost-lease requeue |
| `8a2916a` | WI-6 automatic retry in the completion transaction |
| `b9444a1` | WI-7 task API + template copy |
| `864330d` | WI-8 template-step patch route |
| `67fc678` | WI-9 the runner |
| `35e8b14` | unit-test transaction fakes |
| this commit | this runbook |

Files touched: `packages/db/src/chain-branch.ts` (new),
`packages/db/src/workflow.ts`, `packages/db/src/index.ts`,
`packages/db/prisma/schema.prisma`,
`packages/db/prisma/migrations/20260817020000_chain_branch_and_pr/`,
`packages/api/src/app.ts`, `packages/api/src/templates.ts`,
`packages/api/src/reconcile.ts`, `packages/runner/src/api.ts`,
`packages/runner/src/delivery.ts`, and tests. Nothing in `apps/web`.

## 3. Schema rollback — two shapes, and the difference matters

**Code-only rollback (the normal one).** Revert the code commits and **leave all
four columns and the applied migration in place** — folder committed,
`_prisma_migrations` row untouched. The old code ignores every one of them.
This is the supported state and needs no database work at all.

**Physical rollback (only if the columns must actually go).** Do not run the
SQL below ad hoc. Ship it as a new forward migration, for example
`<timestamp>_remove_chain_branch_and_pr`, after the rollback build no longer
reads the columns:

```sql
ALTER TABLE "Task"             DROP COLUMN "opensPullRequest";
ALTER TABLE "TaskTemplateStep" DROP COLUMN "opensPullRequest";
ALTER TABLE "Run"              DROP COLUMN "opensPullRequest", DROP COLUMN "pushedBranch";
```

Apply that new migration with `prisma migrate deploy` and keep **both** the
original additive migration and the compensating migration recorded as
successful. `prisma migrate resolve --rolled-back` is invalid here: Prisma
rejects it with P3012 because the original migration succeeded; that command is
only for failed migrations.

To roll forward again after physical removal, ship another forward migration
that restores the same four columns and defaults, regenerate the client,
deploy, then require `npm run db:drift-check` to exit 0. The `DROP COLUMN`s are
safe in either order; nothing references them and there is no foreign key. Test
both forward migrations on a scratch schema before the production deploy.

**Hand-deleting a `_prisma_migrations` row is not a rollback procedure.** It
produces a database that tells the next `migrate deploy` the migration is
unapplied, so `deploy` re-runs `ADD COLUMN` against columns that already exist
and fails — and it bypasses the tool's own history checks. Never delete the
original migration folder or mark its successful row rolled back. Physical
removal and later restoration are new forward migrations.

## 4. The mixed-chain trap, in both directions

The change takes effect at **run-creation time**, so a chain whose steps were
queued on either side of the restart is mixed.

**Forward (after the restart), before any shared publication.** Runs already
created keep their per-task branches; runs created afterwards get the shared
branch. Park the remaining steps, point the first not-yet-created shared run's
`Task.targetBranch` at the real predecessor branch, then start that step. This
works only while no run in that repo/chain has published the shared head.

**Forward, after the first shared publication.** `Task.targetBranch` is now
intentionally ignored because the resolver has durable shared-head evidence.
Changing later tasks cannot restore work omitted from the first shared tree.
Park the chain, fetch both refs in a recovery checkout, merge or cherry-pick the
missing predecessor commits **into the shared branch**, push it without force,
and only then resume later steps. Close stray per-step PRs only after verifying
their commits are reachable from the shared head.

**Backward (after a code-only rollback).** A chain mid-flight on a shared branch
reverts to per-task branches for its remaining steps, so **step N+1 will not
contain step N's work** as far as the merger is concerned.

Both directions have the same instruction: **drain the in-flight chains, or park
their remaining steps in `BACKLOG`, before restarting or rolling back.**

## 5. Detecting mixed chains

```sql
SELECT t."chainId", t."projectId", t."chainIndex", t.name, r.branch, r."pushStatus"
  FROM "Task" t JOIN "Run" r ON r."taskId" = t.id
 WHERE t."chainId" IS NOT NULL AND r.branch NOT LIKE 'agentos/chain/%'
   AND EXISTS (SELECT 1 FROM "Task" s
                WHERE s."chainId" = t."chainId" AND s."projectId" = t."projectId"
                  AND s.status IN ('todo','doing','backlog'))
 ORDER BY t."chainId", t."chainIndex";
```

The lowercase status literals are correct: `TaskStatus` is `@map`-ed to
lowercase in `schema.prisma`. For each returned chain, query publication state
by repository before choosing the pre- or post-publication procedure:

```sql
SELECT r."repoId", r."pushedBranch", r.status, r."runNumber", t."chainIndex"
  FROM "Run" r JOIN "Task" t ON t.id = r."taskId"
 WHERE t."projectId" = '<project id>' AND t."chainId" = '<chain id>'
 ORDER BY r."repoId", t."chainIndex", r."runNumber";
```

## 6. Manual pull-request recovery

There is **no automatic promotion**: if the step designated to open the chain's
PR fails before creating it, no later step takes over. Promotion would need
chain-wide knowledge the runner is deliberately forbidden to have — it decides
from one boolean on its own run and never from a step name. Recovery is one
line:

```bash
gh pr create --base master --head 'agentos/chain/<slug>-<fingerprint>' --title '<chain name>'
```

## 7. The stale-runner note

A runner binary older than the API omits two fields from what it sends and
reads, and the two degrade differently:

- **`opensPullRequest`**: the runner compares `!== false`, so an omitted field
  reads as "open the PR" — today's behaviour. Noisy (a PR per step again), not
  lossy.
- **`pushedBranch`**: an old runner never sends the immediate publication ACK.
  Provisioning now checks whether the intended head already exists remotely, so
  an ACK-loss retry still adopts that head; nevertheless mixed old/new runners
  should be drained rather than treated as a supported steady state.

The fix for both is to rebuild the runner, not to edit branches by hand.

## 8. What a wedged chain looks like, and how to unwedge it

**Symptom.** A step fails during provisioning with a clone error naming
`agentos/chain/<slug>-<fp>`, or a push rejected non-fast-forward on that ref.

**Diagnosis.**

```sql
SELECT id, "runNumber", "branch", "pushedBranch", "pushStatus", status, "targetBranch"
  FROM "Run" WHERE "taskId" = '<task id>' ORDER BY "runNumber";
```

- `pushedBranch` NULL is **ambiguous**: a push may have succeeded immediately
  before the runner died and before its fenced ACK. Check the remote with
  `git ls-remote --heads <remote> 'refs/heads/agentos/chain/<slug>-<fp>'`.
  Only an absent remote head means the task/default fallback is authoritative.
- `pushedBranch` set but the remote lacks the ref ⇒ the push went to a different
  remote. The evidence is scoped by `repoId`, because the same branch name on
  two remotes is two unrelated refs; check the step's repo.
- A push rejected non-fast-forward on the shared ref ⇒ legacy concurrent
  admission or an external writer moved the head. Current API admission queues
  only `chainIndex = 0`; later indexed steps remain parked until predecessor
  activation. Fetch and reconcile the remote tree; never force-push.

`pushedBranch` is the durable local publication fact; the remote itself resolves
the narrow pre-ACK ambiguity. `branch` and `pushStatus` each lie in one
direction — a salvaged failure records `pushStatus = SUCCEEDED` against a branch
it never pushed, and a run that published the branch and then hit a `gh` error
is recorded FAILED.

## 9. Computing a chain's branch by hand

The name is derived, never stored, so there is no column to look it up in:

```bash
printf '%s' "<projectId>:<chainId>" | shasum -a 256 | cut -c1-8
```

The slug is the `chainId`, lowercased, with every run of non-alphanumeric
characters replaced by `-`, leading and trailing `-` stripped, truncated to 24
characters, any `-` the truncation left at the end stripped, and the literal
`chain` substituted if nothing survives. The branch is
`agentos/chain/<slug>-<fingerprint>`.

## 10. What is not in this batch

Failure classification is unchanged: a pull-request creation failure still fails
the run, non-retryably, even though the branch is already published. This batch
stops that from *also* erasing the publication fact, so the chain no longer
wedges — but "a delivered branch with no PR is a warning, not a failed run"
remains a backlog item.
