# Merge notes — Files batch (PR #9)

Companion to `docs/merge-notes/batch-repairs-and-batch-2.md` (PR #6 / PR #2); read both
before landing either. Nothing in this file is a code change: it is the merge and
deployment sequence PR #9 depends on and cannot enforce from inside itself.

## Merge order is a hard gate, not a note

**PR #6 (repairs) → PR #2 (batch 2) → PR #9 (Files).** Rebase after each step and rerun
`npm run typecheck`, `npm test`, `npm run build`, and the migration validation. The plan
(`docs/plans/batch-files-paths-plan.md`, "Deployment / migration sequencing") already
requires PR #6 first; treat it as a gate.

Against exact heads `fd6c0c8` × `3519e82`, `git merge-tree --write-tree` reports content
conflicts in `packages/api/src/app.ts` and `packages/api/src/reconcile.ts`.

**The `reconcile.ts` conflict is purely textual.** This batch's entire change to that file
is an added `homedir`/`join` import and a new `export const defaultWorkspaceRoot` at
`reconcile.ts:18`; `reconcileDatabaseRuns` and `reconcileWorkspaces` are untouched. The
repairs batch rewrites the GC keep-set. The two change different things — this batch
changes *which root* is swept, repairs changes *which entries* are kept — so resolve the
import block textually and keep both. Do not treat it as a semantic conflict.

## Migration ordering

- This batch: `20260816060946_files_drop_dead_models`
- Repairs batch: `20260816055603` — **lexicographically earlier**

Prisma applies pending migrations in directory-name order. If this batch lands first, the
repairs migration is applied out of order afterwards: `migrate deploy` tolerates it, but
`migrate status` flags it and `migrate dev` will want a reset. Landing PR #6 first avoids
this entirely.

## `schema.prisma` is not textually mergeable

This batch removes two models and two back-relations. Batch 2 also edits `schema.prisma`
and adds its own migration. Two branches regenerating migrations from one schema do not
commute: **whichever lands second must regenerate its migration, not merge it.**

## Deployment

See `docs/runbooks/files-deployment.md`. Three items in it are load-bearing for this merge:

1. `npm run db:files-precheck` is a required pre-step and now exits non-zero on any
   non-zero count.
2. Old workspace roots (`/tmp/agentos-runs`, `/Users/Shared/agentos-runs`) must be drained
   before deploy. `.env.example:30` used to *set* `RUNNER_WORKSPACE_ROOT` and now leaves it
   commented, so a redeployed example moves to `~/.agentos/runs`, while existing
   `Run.workspacePath` rows still point at the old root. `reconcileWorkspaces` only
   enumerates the current root, so those directories are never swept again — a silent leak
   that nothing in the code enforces against.
3. `FILES_ROOT` must not overlap `RUNNER_WORKSPACE_ROOT`. This one *is* now enforced: the
   API refuses to start on overlap (`assertFilesRootIsolated`).

## Verified consistent — do not re-litigate

The historical three-way default bug is closed: `reconcile.ts:18` (the shared helper),
`index.ts` and `app.ts` (both call it), and `packages/runner/src/config.ts:35` all agree.
The runner copy is still an independent re-implementation because the runner cannot import
from `@agentos/api`; `packages/runner/src/config.test.ts` now pins the two against each
other by source until a package both can depend on exists.
