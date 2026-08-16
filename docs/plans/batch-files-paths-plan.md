# PLAN — Files batch: path scheme landing + thin storage interface

Status: draft for plan review · Chain step 2 of 9 · 2026-08-16
Implements: `docs/specs/batch-files-paths.md` (approved at `f8cadc0`; A1–A7 all confirmed by Leo).
Target branch: `agentos/cmsvbe9ps01ugmpj2bsx04mjj/run-1` (PR #9).

## 0. Approach summary

Eight steps in dependency order: land the workspace-root move first (it is independent of everything else), then the one DB migration, then build the storage layer bottom-up — containment-checked `LocalFileStore`, its security test wall, operator routes, session routes with grant enforcement, MCP tools — and close with a full verification sweep. Each step is one commit; the security boundary (§4 of the spec) gets a dedicated step whose only deliverable is tests, because it is the load-bearing wall of the batch.

**Merge-order precondition (hard):** the platform-repair batch (PR #6) touches `reconcileWorkspaces` and fixes the "suspended run's workspace gets GC'd" hole in the same region this batch re-roots. **PR #6 merges first, this batch merges after**, rebased on it if `packages/api/src/reconcile.ts` conflicts. Deployment additionally follows spec §9: no runs in flight when the root default flips; workspaces are not copied.

All line numbers below were re-verified against the working tree at `f8cadc0`. Two spec citations drifted slightly and are corrected here: `TaskAttachment` is at `schema.prisma:506-514` (spec said `:510`), and the root-`mkdir` the spec asks to add at `workspace.ts:51-60` already exists at `workspace.ts:61` (`mkdir(root, { recursive: true, mode: 0o750 })` in the non-run-as branch) — step 1 verifies rather than re-adds it.

## Step 1 — Move the workspace-root default to `~/.agentos/runs`

Spec §2.1, §2.3-adjacent config text. Covers acceptance §11.2.

Files:
- `packages/runner/src/config.ts:34` — `workspaceRoot: process.env.RUNNER_WORKSPACE_ROOT ?? join(homedir(), ".agentos", "runs")`. Add `homedir` to the existing `node:os` import (line 1 currently imports `hostname`) and import `join` from `node:path`.
- `packages/api/src/index.ts:17` and `packages/api/src/app.ts:1721` — both hard-code the same `?? "/tmp/agentos-runs"` fallback for `reconcileWorkspaces`; the spec names only `config.ts:34`, but leaving these would point the API reconciler at a root the runner no longer uses. Change both to the same `join(homedir(), ".agentos", "runs")` expression (a small shared helper `defaultWorkspaceRoot()` exported from `packages/api/src/reconcile.ts` keeps the two call sites identical). **Consequential edit beyond the spec's file list — forced by consistency.**
- `packages/runner/src/workspace.ts` — no change: root creation already recursive at `:61`; run-as mode already stats the root loudly at `:57-58`. Verify only.
- `.env.example:28-37` — update the `RUNNER_WORKSPACE_ROOT` block: state the new default `~/.agentos/runs`, keep the run-as caveat (spec §2.1 / A4: when `RUNNER_RUN_AS_PREFIX` is set, the operator must point the root somewhere `agentrunner`-accessible or grant traversal manually; no automatic ACLs).

Commit: `feat(paths): default run workspaces to ~/.agentos/runs`

Verification:
- `npm run typecheck -w @agentos/runner -w @agentos/api`
- `npm test -w @agentos/runner` (workspace containment tests still pass against the new default)
- Manual (§11.2): unset `RUNNER_WORKSPACE_ROOT`, start the runner, dispatch a task, confirm `Run.workspacePath` and the on-disk workspace live under `~/.agentos/runs/<runId>`; then set `RUNNER_WORKSPACE_ROOT` to a temp dir and confirm the override still wins.

## Step 2 — The one DB migration

Spec §3, §9. Covers acceptance §11.3.

Files:
- `packages/db/prisma/schema.prisma` — delete `model FileObject` (`:895-909`), `model TaskAttachment` (`:506-514`), and the `files FileObject[]` relation line on `Project` (`:180`). `FilesystemGrant` (`:332-343`) is untouched; its new `folderPath` semantics (Files-Root-relative POSIX path, `""` = whole root) are documented in a comment above the model.
- One new migration under `packages/db/prisma/migrations/`.

Procedure — exact commands, run from the repo root:

1. Pre-check row counts (spec §9: if `FileObject` is unexpectedly non-empty, **stop and escalate**, do not drop):
   ```sh
   psql "postgresql://agentos:agentos@localhost:5432/agentos" -c \
     'SELECT (SELECT COUNT(*) FROM "FileObject")      AS file_objects,
             (SELECT COUNT(*) FROM "TaskAttachment")  AS task_attachments,
             (SELECT COUNT(*) FROM "FilesystemGrant") AS filesystem_grants;'
   ```
   Expected: `0, 0, 0`. Non-zero `FileObject` → abort the step and report via the task activity log.
2. Generate the migration without applying it:
   ```sh
   npm run db:migrate -w @agentos/db -- --create-only --name files_drop_dead_models
   ```
   (expands to `dotenv -e ../../.env -- prisma migrate dev --create-only --name files_drop_dead_models`)
3. Edit the generated `migration.sql` to prepend a guard and the grant cleanup, so the final file reads:
   ```sql
   -- Guard: FileObject must be empty (spec §9 — stop and escalate otherwise).
   DO $$
   DECLARE n integer;
   BEGIN
     SELECT COUNT(*) INTO n FROM "FileObject";
     IF n > 0 THEN
       RAISE EXCEPTION 'FileObject holds % rows; expected 0 — abort (spec §9)', n;
     END IF;
   END $$;

   -- FilesystemGrant rows written before folderPath semantics existed (A5).
   DELETE FROM "FilesystemGrant";

   DROP TABLE "TaskAttachment";
   DROP TABLE "FileObject";
   ```
   (`TaskAttachment` drops first — it carries the FK to `FileObject`. `Project` needs no SQL; the relation's FK lives on `FileObject.projectId`.)
4. Apply and regenerate the client:
   ```sh
   npm run db:migrate -w @agentos/db
   ```

Shadow-database note (no ellipses, no invented flags): **Prisma 6.19 has no `--shadow-database-url` CLI flag** on `migrate dev`. On PostgreSQL it auto-creates a temporary shadow database, which requires the `DATABASE_URL` role (`agentos`) to hold `CREATEDB`. If step 2's command fails with Prisma error `P3014` (shadow DB creation denied), the fix is: add `shadowDatabaseUrl = env("SHADOW_DATABASE_URL")` to the `datasource db` block in `schema.prisma:5-8`, create the database once with `psql "postgresql://agentos:agentos@localhost:5432/postgres" -c 'CREATE DATABASE agentos_shadow;'`, add `SHADOW_DATABASE_URL=postgresql://agentos:agentos@localhost:5432/agentos_shadow` to `.env` and (commented) `.env.example`, and re-run. Do not add this preemptively — on the standard local setup the role owns the server and auto-creation works.

Commit: `feat(db): drop dead FileObject/TaskAttachment, reset FilesystemGrant rows`

Verification:
- `npm run db:validate -w @agentos/db`
- Migration applied cleanly in step 4 above (§11.3); `grep -n "FileObject\|TaskAttachment" packages/db/prisma/schema.prisma` returns nothing.
- `npm run build -w @agentos/db && npm run typecheck -w @agentos/api` — surfaces any code still referencing the deleted models (expected: none; both were dead).

## Step 3 — Thin `FileStore` interface + `LocalFileStore` with containment

Spec §4. Foundation for §11.4–6; containment property tested in step 4.

Files (all new):
- `packages/api/src/files/store.ts` — the `FileStore` interface and `FileStat` type exactly as spec §4 spells them (list/stat/read/write/delete/mkdir/move; root-relative POSIX strings; `Buffer` payloads; no fs types across the seam).
- `packages/api/src/files/paths.ts` — pure path discipline, shared by the store and by step 6's grant check: `normalizeRelPath(path)` (POSIX-normalize, reject absolute paths and any `..` segment after normalization, reject `NUL`; returns the normalized path or throws a typed `InvalidPathError`) and `contains(prefix, path)` (prefix containment on normalized paths, `""` contains everything).
- `packages/api/src/files/local.ts` — `LocalFileStore` constructed with the resolved absolute root. Every operation: `normalizeRelPath` → `resolve(root, rel)` → `resolved === root || resolved.startsWith(root + sep)` check (root itself admitted only for `list`/`stat`, same idiom as `packages/runner/src/workspace.ts:14` and `packages/api/src/reconcile.ts:118`) → for `read`/`write`/`delete`/`move`, `realpath` the parent directory (nearest existing ancestor for `write` with lazy parents) and re-check containment before touching the file, so a symlinked directory inside the root cannot route the operation outside it. `write` creates parent dirs; `delete` removes a file or empty dir only; `list` on a missing dir throws a typed `NotFoundError` (the route layer maps it to 404 — spec §8 requires 404, not `[]`). The store lazily `mkdir`s the root itself on construction so listing an untouched root works.

Commit: `feat(api): thin FileStore seam with contained LocalFileStore`

Verification: `npm run typecheck -w @agentos/api`; behavior tests land in step 4 (same PR, adjacent commit) — this split exists so the security tests are reviewable as their own unit.

## Step 4 — Security-boundary tests (the load-bearing wall)

Spec §4 containment rule, §8 first two bullets. Covers acceptance §11.5.

Files:
- `packages/api/src/files/local.test.ts` (new) — real IO against `mkdtemp(join(tmpdir(), "agentos-files-"))`, no mocks. Must include, as named tests, the three §11.5 probes plus the operational surface:
  1. `read("../outside.txt")` and `write("../outside.txt", …)` → `InvalidPathError`, and a sentinel file created outside the temp root is untouched.
  2. Absolute path (`/etc/passwd`, and a path that *begins* with the root string but escapes, e.g. `<root>-evil/x`) → rejected.
  3. A symlink inside the root pointing at a directory outside it (stand-in for `~/.ssh`): `read`/`write` through it → rejected by the realpath re-check; the target is untouched.
  4. Traversal that normalizes to inside (`a/../b.txt`) is accepted as `b.txt`; `a/../../b.txt` is rejected.
  5. Round-trip coverage of all seven interface methods: write-with-lazy-parents, list (non-recursive, correct `FileStat`), stat on file/dir/missing (`null`), delete on file and empty dir, delete on non-empty dir fails, mkdir, move within the root, move endpoints both containment-checked.
  6. `list` on a missing directory throws `NotFoundError`; `list("")` on the fresh root returns `[]`.
- `packages/api/package.json` — the test script glob is `src/*.test.ts` (non-recursive); extend it to `node --import tsx --test src/*.test.ts src/files/*.test.ts` so the new subdirectory is picked up. **Consequential edit beyond the spec — without it these tests never run.**

Commit: `test(api): containment probes for LocalFileStore`

Verification: `npm test -w @agentos/api` — all probes red-team the boundary and pass; §11.5's "unit tests in packages/api cover the containment rule" is satisfied here.

## Step 5 — `FILES_ROOT` wiring, operator `/files/*` routes, iCloud startup check

Spec §2.2, §2.3, §7, §8 (caps, 404, recursive delete). Covers acceptance §11.1 and §11.4.

Files:
- `packages/api/src/files/config.ts` (new) — `resolveFilesRoot(): string` = `process.env.FILES_ROOT ?? join(homedir(), "Documents", "agentos")`, and `warnIfICloudPath(root: string): void`: realpath the root (or its nearest existing ancestor) and **log a warning — never fail** — if the result sits under `join(homedir(), "Library", "Mobile Documents")`, which catches both a `FILES_ROOT` placed there directly and a `~/Documents` that is a symlink into iCloud's「桌面与文稿」sync. (Leo's requirement #1; this machine is confirmed not syncing, so warn-only is safe and correct.)
- `packages/api/src/index.ts` — call `warnIfICloudPath(resolveFilesRoot())` at startup, next to the existing reconciliation log.
- `packages/api/src/app.ts` — construct one `LocalFileStore` from `resolveFilesRoot()` inside `createApp` (env read at app-construction time, same pattern as the `OPERATOR_TOKEN` reads in `auth.ts`), then add the six operator routes exactly per spec §7's table, paths in query/body (they contain `/`):
  - `GET /files?dir=` → `store.list`; `NotFoundError` → 404; `InvalidPathError` → 400.
  - `GET /files/content?path=` → `store.read`; `Content-Type` from Hono's `getMimeType` (`hono/utils/mime`, already a dependency at `hono@^4.10.6`) with `application/octet-stream` fallback; `Content-Disposition: attachment`.
  - `PUT /files/content?path=` → raw body via `context.req.raw.arrayBuffer()`, reject `> 25 * 1024 * 1024` bytes with 413 (checked against both `Content-Length` and actual body size — A7), then `store.write`.
  - `POST /files/mkdir` `{path}`, `POST /files/move` `{from, to}` — zod-validated via the existing `readJson` helper (`app.ts:303`).
  - `DELETE /files?path=&recursive=` — plain delete maps to `store.delete` (file/empty dir); `recursive=true` walks `list` depth-first and deletes children through the store, keeping the interface thin (see ambiguity #3).
  Routes are operator-gated automatically: `principalMayAccess` (`auth.ts:48-53`) already admits the operator to everything outside `/runner/` and `/session/`.
- `packages/api/src/files/routes.test.ts` (new) — `createApp({} as PrismaClient)` per the existing `app.test.ts` mock idiom, `FILES_ROOT` pointed at a temp dir, operator token set: upload→list→download→move→delete round trip, 413 over-cap, 400 traversal probe at the HTTP layer, 404 on missing dir.
- `.env.example` — delete lines 49-50 (`# Local persistent filesystem…` + `AGENTOS_FILES_ROOT=./var/files`); add a commented `FILES_ROOT` block showing the default `~/Documents/agentos` **plus the iCloud caution line** (Leo's requirement #1: if「桌面与文稿」iCloud sync is on, files here can be evicted to dataless placeholders — reads fail, agent writes get uploaded; point the root elsewhere in that case).

Commit: `feat(api): operator /files routes over LocalFileStore, FILES_ROOT config`

Verification:
- `npm test -w @agentos/api`
- `grep -rn AGENTOS_FILES_ROOT --exclude-dir=node_modules .` → only `docs/reference/` and `docs/specs/` history mentions (§11.1).
- Manual (§11.4): `curl -X PUT -H "Authorization: Bearer $OPERATOR_TOKEN" --data-binary hello "localhost:3000/files/content?path=_global/hello.txt"` creates `~/Documents/agentos/_global/hello.txt`; `GET /files?dir=_global` lists it; Finder shows the same file.

## Step 6 — Grant enforcement + session `/session/runs/:runId/files*` routes

Spec §5, §7 session mirror, §8 grant combos. Covers the server half of acceptance §11.6.

Files:
- `packages/api/src/files/grants.ts` (new) — `requiredCapability(op)` mapping per spec §5 (`list`/`stat`/`read` → `canRead`; `write`/`mkdir` → `canWrite`; `delete` → `canDelete`) and `grantAdmits(grants, op, path)`: normalize each `grant.folderPath` with `normalizeRelPath` (a grant that fails normalization never matches — see ambiguity #4), succeed if **any one** grant both contains the path (`contains`, `""` = everything) and carries the capability; on failure return the missing capability name so the 403 body can state it (spec §5: "403 with a body naming the missing capability"). Overlapping grants: any sufficient one admits (spec §8). `canWrite` without `canRead` (drop-box) falls out naturally.
- `packages/api/src/app.ts` — session routes mirroring the four MCP tools, next to the existing session block (`app.ts:1451-1507`), auto-gated to the owning run by `principalMayAccess` (`auth.ts:51`):
  - `GET /session/runs/:runId/files?dir=` → list
  - `GET /session/runs/:runId/files/content?path=` → read; responds JSON `{content, encoding: "utf8"|"base64", stat}` (A6: base64 iff not valid UTF-8); **5 MB cap → 413** with a message telling the agent the file is too large for a tool result (spec §8).
  - `PUT /session/runs/:runId/files/content` `{path, content, encoding?}` → write (parents auto-created; 25 MB cap shared with the operator route).
  - `DELETE /session/runs/:runId/files?path=` → delete (file/empty dir only; **no recursive, no move** for sessions — A6).
  Per-request enforcement: the session principal carries `runId` → `db.run.findUnique({ where: { id: runId }, select: { agentId: true } })` → `db.filesystemGrant.findMany({ where: { agentId } })` → `grantAdmits`. `Run.agentId` exists directly on the Run model (`schema.prisma:587-592`), so the spec §5 wording "run → task → assigned agent" collapses to one lookup reaching the same agent (see ambiguity #5). No grant → 403 naming the capability.
- `packages/api/src/files/session-routes.test.ts` (new) — mock-Prisma per existing idiom (`run.findFirst` for `authenticate`, `run.findUnique`, `filesystemGrant.findMany`), real temp-dir store, real session token flow: with `{folderPath: "<slug>", canRead: true}` list/read inside succeed; write there → 403 naming `canWrite`; any access outside the folder → 403; adding `canWrite` makes write succeed (§11.6's server half, "API-level test using a session token").

Commit: `feat(api): grant-enforced session file routes`

Verification: `npm test -w @agentos/api`; grant unit tests in `grants.ts`'s test file cover the capability matrix including drop-box and overlapping grants.

## Step 7 — The four MCP file tools

Spec §6. Covers the client half of acceptance §11.6 and touches §11.7.

Files:
- `packages/runner/src/mcp-server.ts` — append `files_list`, `files_read`, `files_write`, `files_delete` to the `TOOLS` array (`:74`) with JSON schemas matching §6's signatures, and extend `invokeTool` (`:156`) with four branches calling the step-6 session routes through the existing `call` helper (`:146` already prefixes `/session/runs/:runId`). `files_read` surfaces the route's `encoding` marker; over-cap and 403 responses flow back as tool errors verbatim (the 403 already names the missing capability, so the agent can report precisely what it lacks). No `move` tool (A6). `agents/foundational.md:13` needs no text change — its "filesystem MCP" promise simply becomes true.
- `packages/runner/src/mcp-server.test.ts` — extend using the existing `withApi` stub-HTTP-server pattern: each tool hits the right method/path with the session token; base64 round-trip; 403/413 surfaced as tool errors. Update the handshake test, which currently asserts exactly four tools, to eight.

Commit: `feat(runner): files_* MCP tools over session file routes`

Verification: `npm test -w @agentos/runner` (§11.7 runner half). End-to-end §11.6 (a live agent session exercising grants through the MCP) is a manual acceptance item in step 8 — there is no automated runner-against-real-API testbed, and this plan does not invent one.

## Step 8 — Full verification sweep and acceptance run-through

Covers §11.7 and re-checks §11.1–6.

No new code. Run and record in the PR:
1. `npm run typecheck -w @agentos/db -w @agentos/api -w @agentos/runner`
2. `npm test -w @agentos/api && npm test -w @agentos/runner` (§11.7)
3. `grep -rn AGENTOS_FILES_ROOT --exclude-dir=node_modules .` (§11.1)
4. Manual checklist against a locally running stack: §11.2 (fresh workspace under `~/.agentos/runs`, override wins), §11.3 (migration applied in step 2), §11.4 (curl + Finder), §11.6 end-to-end (create a grant via the existing agent-page CRUD, dispatch a trivial task, watch `files_list`/`files_read`/`files_write` behave per grant).

Commit: none (or `docs:` fixups if the sweep shakes anything loose — anything larger reopens the owning step).

## Deployment / migration sequencing (spec §9 + Leo's requirement #2)

1. **PR #6 (platform-repair batch) merges first.** It changes `reconcileWorkspaces` and fixes the suspended-run workspace-GC hole; this batch re-roots the very directory that code sweeps. Rebase this branch on it before merge if `reconcile.ts` conflicts.
2. Deploy with **no runs in flight** (drain: let RUNNING runs finish or stop them) — the root flip does not copy workspaces; old `/tmp/agentos-runs` (or `/Users/Shared/agentos-runs` per current `.env.example`) content is inert and manually deletable. Stale `Run.workspacePath` rows are advisory; `reconcileWorkspaces` only acts inside the *current* root.
3. Run the step-2 migration during the same drained window (pre-check counts first).
4. Rollback per spec §10: env override restores the old root; code is revert-safe; the dropped tables were verified empty so a forward re-add loses nothing; files on disk are never deleted by rollback.

## Test strategy (what runs where — honestly)

- **`packages/api/src/app.test.ts`-style route tests use a mock**: an object literal cast to `PrismaClient`. They verify routing, auth, validation, and error mapping — they **cannot** verify migration correctness, FK behavior, or unique constraints, and this plan does not pretend otherwise. No real-DB test harness exists in the repo and none is invented here.
- **Real database** verification is the step-2 procedure itself against the dev Postgres (`DATABASE_URL` in `.env`): pre-count, apply, `db:validate`, plus step 8's manual checklist. That is the entire real-DB surface this batch needs — after the migration there are no file rows left to constrain.
- **Filesystem layer runs real IO**: `local.test.ts` and both route-test files use `mkdtemp` temp dirs — actual symlinks, actual `realpath`, actual traversal attempts. This is deliberate: the security wall must be tested against a real filesystem, not a mock.
- **Runner MCP tests** use the existing `withApi` local-HTTP-stub pattern in `mcp-server.test.ts` — real HTTP, stubbed API.
- Command for the lot: `npm test -w @agentos/api && npm test -w @agentos/runner`.

## Spec-coverage map (spec §11 → steps)

| §11 criterion | Step(s) |
|---|---|
| 1. `AGENTOS_FILES_ROOT` gone | 5 (verified again in 8) |
| 2. Workspaces under `~/.agentos/runs`, override wins | 1 |
| 3. Models dropped, migration clean | 2 |
| 4. Operator write→list→Finder | 5 |
| 5. Three traversal probes, unit-tested | 3 + 4 |
| 6. Grant-scoped session access, 403 names capability | 6 (server) + 7 (MCP) + 8 (end-to-end) |
| 7. Both test suites pass | 4–7 cumulatively, swept in 8 |

## Ambiguities — defaults chosen here, not silently in the implementation

Each item: the default this plan implements, and what overturning it costs.

1. **API's own `/tmp/agentos-runs` fallbacks** (`packages/api/src/index.ts:17`, `app.ts:1721`) are not in the spec's change list. **Default:** change them in step 1 to match the runner's new default. **Cost of overturning:** none to code, but the API-side reconciler would sweep a root the runner no longer writes, so workspace GC silently stops working — this default is close to forced.
2. **Where `FILES_ROOT` resolves.** **Default:** read from `process.env` at `createApp` time (matching how `auth.ts` reads tokens), one `LocalFileStore` per app instance. **Cost:** trivial refactor if review prefers constructor injection; tests already inject via env.
3. **Recursive delete vs. the thin interface.** Spec §4's `delete` is file-or-empty-dir; spec §7 offers `?recursive=true`. **Default:** the route layer walks `list` + `delete` through the store, keeping the seam seven methods. **Cost:** O(children) store calls on big trees — irrelevant on local disk, mildly wasteful on a future R2; widening the interface later is additive.
4. **Dirty `FilesystemGrant.folderPath` values.** Grant CRUD (`app.ts:518-544`) stays as-is per spec §5, so an operator can save `folderPath: "/abs"` or `"a/../.."`. **Default:** the enforcement layer normalizes at check time and a non-normalizable grant simply never matches (fail-closed). **Cost:** dead grants are invisible until an agent hits 403; the alternative — adding validation to `filesystemGrantFields` (`app.ts:122`) — is a two-line spec deviation Leo could okay later.
5. **Run→agent resolution.** Spec §5 says "run → task → assigned agent"; `Run.agentId` exists directly (`schema.prisma:592`). **Default:** use `Run.agentId` — same agent by construction, one lookup. **Cost:** none; revert to the two-hop join if a future batch ever lets a run's agent diverge from the task's assignee.
6. **Where the 5 MB read cap lives.** **Default:** enforced in the session `GET files/content` route (server-side), not in the MCP client. **Cost:** any future non-MCP session consumer shares the cap; today the MCP is the only consumer, and server-side is the only placement an agent can't bypass.
7. **Shadow database provisioning.** No `--shadow-database-url` flag exists in Prisma 6; **default:** rely on Postgres auto-creation (the local `agentos` role owns the server). **Cost:** if the role lacks `CREATEDB`, step 2 documents the exact one-time `shadowDatabaseUrl` fallback — a two-line config addition, no plan change.
8. **`list("")` on a virgin root.** Spec §8 wants 404 for missing dirs, but the future UI's first act is listing an untouched root. **Default:** `LocalFileStore` creates the root lazily at construction, so the root always lists (`[]`) while missing *sub*dirs 404. **Cost:** an empty `~/Documents/agentos/` appears on first API start even if Files is never used; the alternative (special-case `""` → `[]` without mkdir) is a five-line swap.
