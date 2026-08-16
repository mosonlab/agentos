# Runbook — deploying the Files batch

Merge order and schema-merge constraints live in `docs/merge-notes/batch-files.md`. This
file is the deployment sequence. Steps 1–3 are mandatory pre-flight; step 5 is the only
recovery path, because this migration has none.

## 1. Pre-flight: the dead-model precheck (required)

```
npm run db:files-precheck -w @agentos/db
```

Exits non-zero if `FileObject`, `TaskAttachment`, or `FilesystemGrant` holds any rows.
Run it **against the deployment's own database** — a green result from a fresh container is
vacuous, since all three are 0 there by construction.

- `FileObject` / `TaskAttachment` non-zero: **stop.** The migration drops both tables. It
  guards `FileObject` and aborts the whole transaction, so nothing is lost, but the deploy
  fails mid-flight. Export the rows and clear them deliberately first.
  (`TaskAttachment.fileObjectId` is an FK to `FileObject.id`, so a non-empty
  `TaskAttachment` implies a non-empty `FileObject` and the guard always fires.)
- `FilesystemGrant` non-zero: the migration **deletes every row** and now reports the count
  via `RAISE NOTICE`. This is deliberate — those rows predate `folderPath` semantics, hold
  absolute paths that `normalizeRelPath` rejects, and are already fail-closed — but you
  must re-create the grants you still want afterwards (step 4). Record them first:
  `SELECT "agentId", "folderPath", "canRead", "canWrite", "canDelete" FROM "FilesystemGrant";`

## 2. Pre-flight: drain the old workspace roots (required)

The default workspace root is now `~/.agentos/runs`. `.env.example` previously *set*
`RUNNER_WORKSPACE_ROOT=/Users/Shared/agentos-runs` and now leaves it commented out, so a
deployment that re-copies the example moves roots.

Existing `Run.workspacePath` rows still point at the old root, and `reconcileWorkspaces`
only enumerates the current root — **those directories will never be swept again and leak
silently.** Nothing in the code enforces this. Before deploy:

1. Drain in-flight runs.
2. Archive or delete `/tmp/agentos-runs` and `/Users/Shared/agentos-runs` (and any other
   previous `RUNNER_WORKSPACE_ROOT`) by hand.
3. Either accept the new default or set `RUNNER_WORKSPACE_ROOT` explicitly to keep the old
   one; do not let it change silently under running rows.

## 3. Pre-flight: root isolation (enforced at startup)

- `FILES_ROOT` must not equal, contain, or sit inside `RUNNER_WORKSPACE_ROOT`. The API now
  **refuses to start** on overlap. Agents have full write access to their run workspaces,
  and write access inside the Files Root is the precondition for every remaining
  containment gap (hardlinks are closed; the post-walk directory swap is not).
- `RUNNER_RUN_AS_PREFIX` empty means model CLIs run as the API's own OS user and can write
  `FILES_ROOT` directly. The API logs a warning. The shipped default (`.env.example`) is
  exactly this configuration, so on a stock install the post-walk-swap backstop is absent —
  see the threat model in `packages/api/src/files/local.ts` and probe 24
  (`AGENTOS_RACE_PROBE=1`) for executable evidence.

## 4. Deploy

```
npm run db:migrate -w @agentos/db     # applies 20260816060946_files_drop_dead_models
```

Then re-create the FilesystemGrant rows recorded in step 1, as Files-Root-relative POSIX
paths (`""` means the whole Files Root). Grant creation now rejects a folderPath that
resolves to the same physical folder as an existing grant (409) — on a case-insensitive
volume `protected` and `Protected` are one directory and must not carry two grants.

## 5. Recovery — there is no rollback

**Prisma 6.19 has no `migrate down`**; `npx prisma migrate --help` lists no such command,
and this repository contains no restoration migration. Recovery is forward-only:

1. **`FilesystemGrant`**: re-insert from the step-1 export, converting any absolute
   `folderPath` to a Files-Root-relative POSIX path. Rows that are not already canonical
   are skipped by `grantAdmits` and grant nothing.
2. **`FileObject` / `TaskAttachment`**: both were required to be empty before the migration
   ran, so there is nothing to restore. If you need the tables back, write a new forward
   migration re-adding the models from the pre-drop `schema.prisma`
   (`git show b64b36b:packages/db/prisma/schema.prisma`) and regenerate the client. Do not
   hand-edit the applied migration.
3. **Files on disk are never touched by the migration** in either direction.
