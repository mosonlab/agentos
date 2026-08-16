# PLAN — Files batch: path scheme landing + thin storage interface

Status: revision 2 (post plan-review) · Chain step 2 of 9 · 2026-08-16
Implements: `docs/specs/batch-files-paths.md` (approved at `f8cadc0`; A1–A7 all confirmed by Leo, plus two added requirements: iCloud warn-only, PR #6 merges first).
Revises: revision 1 at `6067e69`, which the plan review failed with 6 must-fix / 6 should-fix. See §"Revision record" for the per-finding disposition.
Target branch: `agentos/cmsvbe9ps01ugmpj2bsx04mjj/run-1` (PR #9).

## 0. Approach summary

Nine steps in dependency order: land the workspace-root move first (independent of everything else), then the one DB migration, then build the storage layer bottom-up — pure path discipline, the containment-checked `LocalFileStore`, its security test wall, operator routes, grant validation + enforcement + session routes, the MCP tools — and close with a full verification sweep. Each step is one commit and each commit compiles on its own.

Revision 2 changes the shape in three places:

- **The security wall is now three steps, not two** (§3 pure paths → §4 store → §5 probe wall). The review demonstrated that revision 1's "lexical root + parent `realpath`" algorithm both false-rejects legitimate roots *and* leaves three working escapes; the replacement algorithm (canonical root, component-wise no-follow walk, `O_NOFOLLOW` on the final open) is enough larger that bundling it with the interface made an unreviewable commit.
- **Grant path validation moved into scope** (§7). The approved `folderPath: ""` = whole Files Root semantics is unreachable through today's CRUD, which rejects `""` with a 400.
- **A hard deployment precondition is stated up front** (§"Deployment preconditions"). With `RUNNER_RUN_AS_PREFIX` empty — the shipped default — the model CLI runs as the runner's own OS user and can reach `FILES_ROOT` with a plain shell, so the grant check on the session routes is not a security boundary. This plan does not change A4 (no automatic ACL management); it names the precondition, documents it where an operator will see it, and adds an acceptance probe.

**Merge-order precondition (hard):** the platform-repair batch (PR #6) touches `reconcileWorkspaces` and fixes the "suspended run's workspace gets GC'd" hole in the same region this batch re-roots. **PR #6 merges first, this batch merges after**, rebased on it if `packages/api/src/reconcile.ts` conflicts. Deployment additionally follows spec §9: no runs in flight when the root default flips; workspaces are not copied.

**All `file:line` references below were re-verified against the working tree at `6067e69`** (revision 1's citations were re-run, not carried over). Corrections made in this revision: `TaskAttachment` is at `schema.prisma:506-514`; `Project.files` at `:180`; `Task.attachments` at `:473` (missed entirely in revision 1); `FileObject` at `:895-909`; `FilesystemGrant` at `:332-343`; the root `mkdir` the spec asks to add at `workspace.ts:51-60` already exists at `workspace.ts:61`, so step 1 verifies rather than re-adds it.

## Deployment preconditions for the Files grant boundary (hard)

**Verified facts about the shipped default:**

- `RUNNER_RUN_AS_PREFIX` defaults to empty (`packages/runner/src/config.ts:37`; `.env.example:36`).
- With an empty prefix, `spawnRuntime` execs the model binary directly — `prefixed` is false, so `executable` is the binary itself and no launcher wraps it (`packages/runner/src/adapters.ts:358-362`). The same branch exists in the second spawn site (`adapters.ts:432-433`) and in `workspace.ts:23-24`.
- The Files Root default is `~/Documents/agentos` — inside the home directory of that same operator account.

Consequence: **out of the box, an agent reaches the entire Files Root with `cat`/`ls`/`>` and never touches the grant-checked session routes.** The `FilesystemGrant` enforcement this batch adds is then an audit and ergonomics boundary, not a security boundary. Revision 1 did not say this anywhere.

**Precondition (does not reopen A4 — still no automatic ACL management):** the Files grant boundary is real only when **both** hold on the deployment:

1. `RUNNER_RUN_AS_PREFIX` is set to a low-privilege launcher (e.g. `sudo -u agentrunner`), **or** an equivalent sandbox (macOS seatbelt profile, container) confines the model CLI to a different security principal than the API process; **and**
2. that principal has **no** traverse (`--x`) and **no** write access to `FILES_ROOT` or to any of its path components.

Where this is written down: `.env.example` next to `RUNNER_RUN_AS_PREFIX` (step 1) and next to `FILES_ROOT` (step 6), in both cases stating plainly that grants are not a security boundary until the precondition holds. Acceptance probe in step 9.

This precondition is also what makes §4's residual TOCTOU unreachable: an agent that cannot write inside the Files Root cannot plant or swap the symlinks the race needs.

## Step 1 — Move the workspace-root default to `~/.agentos/runs`

Spec §2.1, §2.3-adjacent config text. Covers acceptance §11.2. Carries the MF-3 documentation half.

Files:

- `packages/runner/src/config.ts:34` — `workspaceRoot: process.env.RUNNER_WORKSPACE_ROOT ?? join(homedir(), ".agentos", "runs")`. Add `homedir` to the existing `node:os` import (line 1 currently imports `hostname` only) and import `join` from `node:path`.
- `packages/api/src/index.ts:17` and `packages/api/src/app.ts:1721` — both hard-code the same `?? "/tmp/agentos-runs"` fallback for `reconcileWorkspaces`. The spec names only `config.ts:34`, but leaving these would point the API reconciler at a root the runner no longer uses. Change both to the same expression via a shared `defaultWorkspaceRoot()` exported from `packages/api/src/reconcile.ts`. **Consequential edit beyond the spec's file list — forced by consistency.**
- `packages/runner/src/workspace.ts` — no change: root creation is already recursive at `:61` (`mkdir(root, { recursive: true, mode: 0o750 })`), and run-as mode already stats the root loudly at `:57-58`. Verify only.
- `.env.example:27-37` — rewrite the block. Comment out the active `RUNNER_WORKSPACE_ROOT=/Users/Shared/agentos-runs` assignment at `:30` (an active assignment means anyone who copies the example never reaches the new default) and state the default in a comment, noting that values here are **not** shell-expanded so `~` would be taken literally and any override must be absolute. Use `/opt/agentos/runs` as the commented override example — deliberately **not** `/Users/Shared/agentos-runs`, so step 9's regression grep can expect zero hits. Keep the A4 run-as caveat (when `RUNNER_RUN_AS_PREFIX` is set, `~/.agentos/runs` still resolves under the *runner process owner's* home, so the operator must grant traversal or point the root elsewhere; no automatic ACLs). Add the MF-3 security note under `RUNNER_RUN_AS_PREFIX` at `:34-37`: while the prefix is empty the model CLI runs as the runner's own OS user, so `FilesystemGrant` is not a security boundary.

Commit: `feat(paths): default run workspaces to ~/.agentos/runs`

Verification:

- `npm run typecheck -w @agentos/runner -w @agentos/api`
- `npm test -w @agentos/runner` (workspace containment tests still pass against the new default)
- `git grep -nE '/tmp/agentos-runs|/Users/Shared/agentos-runs' -- .env.example packages apps deploy` → **no output**. Baseline today is 4 hits: `.env.example:30`, `packages/api/src/app.ts:1721`, `packages/api/src/index.ts:17`, `packages/runner/src/config.ts:34`. This step clears all four.
- Manual (§11.2): unset `RUNNER_WORKSPACE_ROOT`, start the runner, dispatch a task, confirm `Run.workspacePath` and the on-disk workspace live under `~/.agentos/runs/<runId>`; then set `RUNNER_WORKSPACE_ROOT` to a temp dir and confirm the override still wins.

## Step 2 — The one DB migration

Spec §3, §9. Covers acceptance §11.3. One migration for the whole batch (spec §9 — not negotiable).

Files:

- `packages/db/prisma/schema.prisma` — delete **four** things, not three:
  1. `model FileObject` (`:895-909`)
  2. `model TaskAttachment` (`:506-514`)
  3. `files FileObject[]` on `Project` (`:180`)
  4. **`attachments TaskAttachment[]` on `Task` (`:473`)** — missed in revision 1. Deleting the model while this back-relation survives makes Prisma reject the schema outright with `P1012` (`Type "TaskAttachment" … does not refer to another model`), so the migration cannot even be generated. Verified present at `:473`.

  Leave `TaskTemplateStep.attachmentsFromPrevious Boolean @default(false)` (`:425`) alone — it is a scalar flag, not a relation to the deleted model. `FilesystemGrant` (`:332-343`) is untouched; its new `folderPath` semantics (Files-Root-relative POSIX path, `""` = whole root) are documented in a comment above the model.
- `packages/db/prisma/precheck-files.ts` (new) — the row-count pre-check, run through Prisma so it uses the *same* `DATABASE_URL` the migration will use (revision 1 hard-coded `agentos@localhost/agentos`, which would check database A while migrating database B on any custom deployment; a raw `psql "$DATABASE_URL"` does not work either, because `.env.example:5`'s URL carries `?schema=public` and libpq rejects that as an unknown query parameter). Uses `$queryRaw`, so it is independent of whether the models are still in the generated client. `COUNT(*)` comes back as `BigInt` — coerce with `Number()`. Prints the three counts, exits non-zero if `FileObject` is non-empty, never echoes the connection URL.
- `packages/db/package.json:20` — add `"db:files-precheck": "dotenv -e ../../.env -- tsx prisma/precheck-files.ts"`, matching the existing `dotenv -e ../../.env --` idiom at `:18-20`. `tsx` is already the db package's seed runner (`packages/db/package.json:23`).
- One new migration under `packages/db/prisma/migrations/`.

Procedure — exact commands, run from the repo root:

1. Pre-check row counts (spec §9: if `FileObject` is unexpectedly non-empty, **stop and escalate**, do not drop):
   ```sh
   npm run db:files-precheck -w @agentos/db
   ```
   Expected: `FileObject 0, TaskAttachment 0, FilesystemGrant 0`, exit 0. Non-zero `FileObject` → the script exits 1; abort the step and report via the task activity log.
   Docker Compose deployments without a local `psql`/node toolchain can read the same counts with
   `docker compose exec -T postgres psql -U agentos -d agentos -c 'SELECT (SELECT COUNT(*) FROM "FileObject") AS file_objects, (SELECT COUNT(*) FROM "TaskAttachment") AS task_attachments, (SELECT COUNT(*) FROM "FilesystemGrant") AS filesystem_grants;'`
   (service name `postgres` per `docker-compose.yml:2`) — **only** valid if the Compose database is the one `DATABASE_URL` points at.
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
   (`TaskAttachment` drops first — it carries the FK to `FileObject` at `schema.prisma:510`. `Project` and `Task` need no SQL; both relations' FKs live on the dropped tables.)
4. Apply and regenerate the client:
   ```sh
   npm run db:migrate -w @agentos/db
   ```
   Hand-editing a not-yet-applied migration does not cause drift: `migrate dev` applies the edited file as written, and a second `migrate dev` reports `Already in sync`.

**Shadow-database note (corrected).** Prisma 6.19.0 (`packages/db/package.json:26,30`) has **no `--shadow-database-url` CLI flag** on `migrate dev`; the datasource block declares only `url = env("DATABASE_URL")` (`schema.prisma:5-8`). On PostgreSQL, `migrate dev` auto-creates a temporary shadow database, which requires the `DATABASE_URL` role to hold `CREATEDB`. If step 2 fails with `P3014`:

- **The `agentos` role cannot fix this itself.** Lacking `CREATEDB` is precisely why `P3014` fired; running `CREATE DATABASE` with the same credentials returns `ERROR: permission denied to create database`. (Revision 1 told the operator to do exactly that.)
- The fix requires a **DBA or superuser** to do one of:
  - `CREATE DATABASE agentos_shadow OWNER agentos;` (connected as a superuser, e.g. `psql "postgresql://postgres@localhost:5432/postgres"`), or
  - `ALTER ROLE agentos CREATEDB;` — also superuser-only — after which auto-creation works and no config change is needed, or
  - hand over an already-provisioned empty database the `agentos` role owns.
- Then add `shadowDatabaseUrl = env("SHADOW_DATABASE_URL")` to the `datasource db` block (`schema.prisma:5-8`), set `SHADOW_DATABASE_URL` in `.env`, add it commented to `.env.example`, and re-run.
- Do not add any of this preemptively — on the standard local Compose setup the `agentos` role owns the server and auto-creation works.

Commit: `feat(db): drop dead FileObject/TaskAttachment, reset FilesystemGrant rows`

Verification:

- `npm run db:validate -w @agentos/db` (this is what catches a missed back-relation like `Task.attachments`)
- Migration applied cleanly in step 4 above (§11.3); `git grep -n "FileObject\|TaskAttachment" -- packages/db/prisma/schema.prisma` returns nothing.
- `npm run build -w @agentos/db && npm run typecheck -w @agentos/api` — surfaces any code still referencing the deleted models (expected: none; both were dead).

## Step 3 — `FileStore` interface + pure path discipline

Spec §4 (types), §8 first bullet. Foundation for steps 4–7.

Files (all new unless noted):

- `packages/api/src/files/store.ts` — the `FileStore` interface and `FileStat` type exactly as spec §4 spells them (list/stat/read/write/delete/mkdir/move; root-relative POSIX strings; `Buffer` payloads; no `node:fs` types across the seam), plus the typed error classes the route layer maps to status codes: `InvalidPathError` (→ 400), `SymlinkError` (→ 400, subclass of `InvalidPathError` so route mapping stays one branch), `NotFoundError` (→ 404), `NotADirectoryError` (→ 400).
- `packages/api/src/files/paths.ts` — pure, no IO, shared by the store (step 4), the grant checker and the grant CRUD validator (step 7):
  - `normalizeRelPath(input: string): string` — normalizes with `node:path/posix` and throws `InvalidPathError` for anything that is not a Files-Root-relative POSIX path. Rejects, in order, **before** any normalization: length > 4096; any `\0`; any backslash (this is a POSIX-only interface — the rule also disposes of Windows separators and UNC prefixes); a Windows drive prefix (`/^[A-Za-z]:/`); a leading `/`. Then `posix.normalize`, map `"."` → `""`, strip one trailing `/`, and reject a result of `".."` or anything starting with `"../"`. `normalizeRelPath("")` returns `""` (the root). It performs **no percent-decoding** — see the decoding rule below.
  - `isCanonicalRelPath(input: string): boolean` — `input !== "" && normalizeRelPath(input) === input`, false if it throws. Used by step 7's CRUD validator so a stored `folderPath` is byte-identical to what enforcement will compare against (`"a/../b"`, `"a/"`, `"./a"` are rejected rather than silently rewritten).
  - `contains(prefix: string, path: string): boolean` — both arguments already normalized; `prefix === "" || path === prefix || path.startsWith(prefix + "/")`.
  - **Decoding rule, stated once and enforced everywhere:** percent-decoding happens exactly once, at the HTTP boundary (Hono's `c.req.query()` already decodes). Neither `paths.ts` nor the store decodes. So a once-encoded `%2e%2e%2f` arrives as `../` and is rejected; a double-encoded `%252e%252e` arrives as the literal filename `%2e%2e` and is stored as such, inside the root. No layer may decode twice.
- `packages/api/src/files/paths.test.ts` (new) — pure unit tests, no filesystem: the traversal/absolute/drive/UNC/backslash/NUL/encoding table, `contains` including `""`, `isCanonicalRelPath` accept/reject pairs.
- `packages/api/package.json:10` — the test script glob is `node --import tsx --test src/*.test.ts` (non-recursive); extend it to `node --import tsx --test src/*.test.ts src/files/*.test.ts` so the new subdirectory is picked up. **Consequential edit beyond the spec — without it none of steps 3/5/6/7's tests ever run.** Moved here from revision 1's step 4 because this is now the first step that adds a file under `src/files/`. No other nested test files exist in the repo, so the glob pulls in nothing unexpected.

Commit: `feat(api): FileStore seam and pure path discipline`

Verification: `npm run typecheck -w @agentos/api`; `npm test -w @agentos/api` (the new `paths.test.ts` runs and passes).

## Step 4 — `LocalFileStore` with a no-follow containment resolver

Spec §4 containment rule, §8 bullets 1–3. This step replaces revision 1's algorithm entirely.

### Why the previous algorithm is gone

Revision 1 resolved the root lexically and `realpath`ed only the *parent* directory. Two independent failures, both reproduced on this machine:

- **False rejection of legitimate roots.** `os.tmpdir()` is `/tmp` here, whose realpath is `/private/tmp`; a `mkdtemp(tmpdir())` root therefore fails a `realpath(...).startsWith(lexicalRoot)` check (measured: `prefixPass = false`). The plan's own test root would have been rejected, and so would the iCloud-symlinked `~/Documents` the spec explicitly requires to keep working.
- **Three working escapes.** Parent-only `realpath` leaves the final component unchecked (a symlinked target file is read/written through), leaves `readdir` free to list a symlinked directory's outside contents, and leaves a post-check swap of the checked directory able to redirect a write.

### The replacement

`packages/api/src/files/local.ts` (new) — `createLocalFileStore(logicalRoot: string): Promise<FileStore>`.

**Construction.** `await mkdir(logicalRoot, { recursive: true, mode: 0o750 })`, then `const canonicalRoot = await realpath(logicalRoot)`. Both are kept: `canonicalRoot` is the *only* value containment math ever compares against (so a symlinked root — `/tmp`, iCloud-relocated `~/Documents` — works); `logicalRoot` appears in log lines and error messages so an operator recognises what they configured.

**`resolveContained(rel, mode)`**, exported for direct unit testing, where `mode` is `"existing"` or `"create-parents"`:

1. `const norm = normalizeRelPath(rel)`.
2. `const target = norm === "" ? canonicalRoot : resolve(canonicalRoot, norm)`.
3. Lexical guard, defence in depth: `target === canonicalRoot || target.startsWith(canonicalRoot + sep)`, else `InvalidPathError`.
4. **Component-wise no-follow walk.** Starting at `canonicalRoot`, for each segment of `norm` *except the last*: `dir = join(dir, seg)`; `lstat(dir)`.
   - missing → `mode === "existing"`: `NotFoundError`; `mode === "create-parents"`: `mkdir(dir, { mode: 0o750 })` **non-recursively** (so a concurrently-created symlink surfaces as `EEXIST` rather than being silently accepted), then re-`lstat` and re-apply the checks below.
   - `isSymbolicLink()` → `SymlinkError`. **Every** symlink is rejected, not only those pointing outside — see ambiguity #9.
   - not a directory → `NotADirectoryError`.
   No `realpath` anywhere in the walk: `lstat` never follows, so there is no "resolve then compare" window per component.
5. Return `{ target, parent: dir, name: lastSegment }`.

**Final component, per operation.** The last segment is never trusted to a plain `stat`:

- `read` — `open(target, O_RDONLY | O_NOFOLLOW)`, then `fh.readFile()`. `ELOOP` → `SymlinkError`, `ENOENT` → `NotFoundError`. The `O_NOFOLLOW` refusal is atomic with the open, so it also closes a swap of the final component. *(Measured on this platform: `read refused: ELOOP`.)*
- `write` — `resolveContained(rel, "create-parents")`, then `open(target, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o640)`, `fh.writeFile(data)`, `fh.stat()` for the returned `FileStat`. `ELOOP` → `SymlinkError`. *(Measured: `write refused: ELOOP`.)*
- `stat` — `lstat(target)`; symlink → `SymlinkError`; `ENOENT` → `null`.
- `list` — walk **all** segments as directory components, `readdir(target, { withFileTypes: true })`, and build each `FileStat` from `lstat(join(target, name))`. Entries that are symlinks are **omitted** from the result and never followed. *(Measured: `readdir({withFileTypes:true})` reports `isSymbolicLink() === true` for a symlinked entry, so the filter is reliable without a second syscall.)* `ENOENT` on the directory → `NotFoundError` (spec §8 wants 404, not `[]`).
- `delete` — `lstat(target)`; a symlink is removed with `unlink`, which removes the *link* and never touches the target (rejecting instead would leave a stray symlink the API could never clear); otherwise file → `unlink`, empty dir → `rmdir`, non-empty dir → error.
- `mkdir` — `resolveContained(rel, "create-parents")` for the parents, then `mkdir(target, { mode: 0o750 })`; `EEXIST` tolerated only when `lstat(target)` is a real directory and not a symlink.
- `move` — both endpoints through `resolveContained` (`from` as `"existing"`, `to` as `"create-parents"`); `lstat(from)` symlink → `SymlinkError`; `to` must be absent or a non-symlink; then `rename`.

`list("")` on a freshly constructed root returns `[]` — construction already created the root (ambiguity #8).

### Threat model — stated, because the algorithm does not close everything

**What this closes.** Every path string an agent or operator can submit: traversal, absolute paths, Windows drive and UNC shapes, backslashes, `NUL`, and once-decoded percent sequences. Every symlink already stored inside the root, whether it sits as an intermediate path component, as the final target, or as a `readdir` entry — for all seven operations including `list` and `stat`. And a swap of the **final** component between resolution and use, because `O_NOFOLLOW` is atomic with the `open`.

**What this does not close.** An adversary with concurrent write access **inside** the Files Root can rename an already-walked intermediate directory into a symlink between the walk and the `open`. Node exposes no `openat(2)`/fd-relative API, so this residual TOCTOU cannot be closed in pure Node; closing it would require a native addon, which this batch does not add. It is unreachable when the §"Deployment preconditions" hold, because the agent then has no direct filesystem write access to the root at all.

**Therefore: this plan does not claim the algorithm alone provides absolute containment.** It provides containment against every path an API caller can express and against every symlink at rest, and relies on OS isolation for the concurrent-attacker case. That sentence, and the two paragraphs above it, belong in a header comment in `local.ts` so the next reader does not over-trust the code.

### Store lifecycle (consequential, forced by the above)

`createLocalFileStore` is async (it `mkdir`s and `realpath`s), but `createApp` is synchronous and every existing test calls it synchronously (`packages/api/src/app.test.ts:26`). So:

- `packages/api/src/files/config.ts` (step 6) exposes `getFileStore(): Promise<FileStore>`, memoizing one promise **per resolved root path** in a module-level `Map`, plus `resetFileStores()` for tests. Route handlers are already async and simply `await getFileStore()`.
- This supersedes revision 1's ambiguity #2 ("one `LocalFileStore` per app instance, constructed inside `createApp`") — see the rewritten ambiguity #2.

Commit: `feat(api): contained LocalFileStore with no-follow path resolution`

Verification: `npm run typecheck -w @agentos/api`. Behavior and security tests land in step 5 (same PR, adjacent commit) — the split exists so the probe wall is reviewable as its own unit.

## Step 5 — Security-boundary probe wall

Spec §4 containment rule, §8 bullets 1–3. Covers acceptance §11.5. Revision 1 had three probes; the review showed three live escapes those three would have missed.

Files:

- `packages/api/src/files/local.test.ts` (new) — real IO against `mkdtemp(join(tmpdir(), "agentos-files-"))`, no mocks, no stubbed `fs`. Each item below is a named test.

  **Root shape**
  1. **Symlinked root.** Two roots: the plain `mkdtemp` root (whose realpath differs from its lexical path on macOS), and an explicit `symlink(realDir, linkDir)` root. Ordinary write/read/list inside both must **succeed**. This test fails against revision 1's algorithm; it is the regression guard for the false-reject half of MF-2.

  **Symlinks at rest — the three demonstrated escapes**
  2. Final component is a symlink to a file outside the root → `read` throws `SymlinkError`; the outside SECRET sentinel's contents never appear in the result.
  3. Final component is a symlink to a file outside the root → `write` throws `SymlinkError`; the outside file is byte-identical afterwards (assert on content, not just on the throw).
  4. A directory symlink inside the root pointing outside → `list` of the containing directory omits it, and none of the outside directory's entries appear anywhere in the result.
  5. `stat` on a symlink → `SymlinkError`; never the target's size/mtime.
  6. Intermediate directory symlink → refused for all six of read, write, list, stat, delete-target-beneath, move (both directions).
  7. Multi-hop inside → inside → outside (`a/b` where `b` symlinks to `../../outside`) → refused at the walk.
  8. `delete` on a symlink unlinks the link and leaves the target file intact.

  **Races**
  9. **Deterministic final-component swap.** Create `x.txt` as a regular file; `store.stat("x.txt")` succeeds; replace it with a symlink to an outside SECRET; `store.read("x.txt")` must throw `SymlinkError` (the `O_NOFOLLOW` open catches it). Two separate store calls make the swap deterministic, no timing luck.
  10. **Documented limitation.** A test named for what is *not* covered: pre-plant a symlink at an intermediate component before the walk → refused (this part passes); with an inline comment stating that a post-walk intermediate swap is not closeable in pure Node and is covered by the deployment precondition, not by this file. The test asserts the closeable half and documents the rest rather than pretending.

  **Path-string shapes**
  11. Parent does not yet exist: `write("x/y/z.txt")` creates `x` and `y` at mode `0o750` and succeeds; if `x` already exists as a symlink, it refuses.
  12. Windows shapes: `C:\evil`, `\\server\share\x`, `a\b`, `..\..\x` → `InvalidPathError`.
  13. `NUL`: `"a\u0000b"` → `InvalidPathError`, thrown by `paths.ts` before any syscall.
  14. Encoding: `"%2e%2e%2f"` and `"%2E%2E/"` reaching the store as literals (route already decoded once) are accepted as ordinary filenames and land **inside** the root under those literal names; `"../"` is rejected. After the whole encoding block, assert nothing was created anywhere outside the root.
  15. The original §11.5 three: `read("../outside.txt")`/`write("../outside.txt", …)` → `InvalidPathError` with an outside sentinel untouched; absolute `/etc/passwd` → rejected; symlink to a directory outside the root (stand-in for `~/.ssh`) → rejected.
  16. A path that *begins* with the root string but escapes — both as an absolute (`<root>-evil/x`) and as a relative (`../<basename>-evil/x`) → rejected.

  **Functional surface**
  17. Round-trip of all seven interface methods: write-with-lazy-parents, `list` (non-recursive, correct `FileStat`), `stat` on file/dir/missing (`null`), `delete` on file and on empty dir, `delete` on non-empty dir fails, `mkdir`, `move` within the root with both endpoints containment-checked.
  18. `list` on a missing directory → `NotFoundError`; `list("")` on a virgin root → `[]`.
  19. Traversal that normalizes to inside (`a/../b.txt`) is accepted as `b.txt`; `a/../../b.txt` is rejected.

Commit: `test(api): containment probe wall for LocalFileStore`

Verification: `npm test -w @agentos/api` — every probe passes; §11.5's "unit tests in `packages/api` cover the containment rule" is satisfied here. Sanity check on the wall itself: temporarily reverting step 4's final-component `O_NOFOLLOW` must turn probes 2, 3 and 9 red — if it does not, the probes are not testing what they claim.

## Step 6 — `FILES_ROOT` wiring, operator `/files/*` routes, iCloud warning

Spec §2.2, §2.3, §7, §8 (caps, 404, recursive delete). Covers acceptance §11.1 and §11.4.

Files:

- `packages/api/src/files/config.ts` (new):
  - `resolveFilesRoot(): string` = `process.env.FILES_ROOT ?? join(homedir(), "Documents", "agentos")`.
  - `getFileStore(): Promise<FileStore>` / `resetFileStores(): void` — the per-root memo described in step 4.
  - `warnIfICloudPath(root: string): Promise<void>` — `realpath` the root (falling back to its nearest existing ancestor), and **log a warning, never throw or exit** if the result sits under `join(homedir(), "Library", "Mobile Documents")`. This catches both a `FILES_ROOT` placed there directly and a `~/Documents` that is itself a symlink into iCloud's「桌面与文稿」sync. (Leo's requirement #1; warn-only is the explicit instruction.)
- `packages/api/src/index.ts` — `await warnIfICloudPath(resolveFilesRoot())` at startup, next to the existing reconciliation log at `:15-20`.
- `packages/api/src/app.ts` — the six operator routes from spec §7's table, paths in query/body because they contain `/`. Each handler `await getFileStore()`. Error mapping is one shared helper: `SymlinkError`/`NotADirectoryError`/`InvalidPathError` → 400, `NotFoundError` → 404.
  - `GET /files?dir=` → `store.list`.
  - `GET /files/content?path=` → `store.read`; `Content-Type` from Hono's `getMimeType` (`hono/utils/mime`; hono is a direct dependency at `packages/api/package.json:18`, resolved to 4.13.2) with an `application/octet-stream` fallback; `Content-Disposition: attachment`. `node_modules` is not installed in the planning workspace, so the implementer must confirm the subpath import resolves on first use; if it does not, substitute a ten-entry extension→MIME map — this is a two-line contingency, not a plan change.
  - `PUT /files/content?path=` → **cap before buffering** (SF-2): if `Content-Length` is present and exceeds `25 * 1024 * 1024`, return 413 without reading the body at all; if it is absent (chunked), read `context.req.raw.body` as a `ReadableStream` through a bounded reader that accumulates chunks and aborts with 413 the instant the running total exceeds the cap. Only then concatenate to a `Buffer` and `store.write`. Revision 1 called `arrayBuffer()` first, which buffers a hostile chunked body in full before deciding.
  - `POST /files/mkdir` `{path}`, `POST /files/move` `{from, to}` — zod-validated through the existing `readJson` helper (`app.ts:303`).
  - `DELETE /files?path=&recursive=` — plain delete maps to `store.delete` (file/empty dir); `recursive=true` walks `list` depth-first and deletes children through the store, keeping the interface at seven methods (ambiguity #3).
  Routes are operator-gated automatically: `principalMayAccess` (`auth.ts:48-49`) admits the operator to everything outside `/runner/` and `/session/`.
- `packages/api/src/files/routes.test.ts` (new) — `createApp({} as PrismaClient)` per the existing mock idiom (`app.test.ts:26`), `FILES_ROOT` pointed at a fresh temp dir with `resetFileStores()` between tests, operator token set. Named tests: upload→list→download→move→delete round trip; **`recursive=true` delete of a populated tree** and `recursive` absent on a non-empty dir → error; 413 via `Content-Length` without the body being read; 413 via a chunked body, asserting the reader aborts near the cap rather than materializing the whole stream; 400 traversal at the HTTP layer; 404 on a missing dir; filenames containing `?`, `#`, `%`, `&`, a space and non-ASCII (`报告.md`) surviving the query round trip intact.
- `.env.example` — delete `:49-50` (`# Local persistent filesystem…` + `AGENTOS_FILES_ROOT=./var/files`) and add a commented `FILES_ROOT` block: the default `~/Documents/agentos` stated in a comment with the not-shell-expanded warning and an absolute override example, the iCloud caution (Leo's requirement #1: with「桌面与文稿」sync on, files here can be evicted to dataless placeholders — reads fail, agent writes get uploaded; the API warns at startup and does not refuse to start), and the MF-3 security precondition in plain language.

Commit: `feat(api): operator /files routes over LocalFileStore, FILES_ROOT config`

Verification:

- `npm test -w @agentos/api`
- `git grep -n AGENTOS_FILES_ROOT -- .env.example packages apps deploy` → **no output**. Baseline today is exactly one hit, `.env.example:50`, which this step removes. (Revision 1 ran `grep -rn AGENTOS_FILES_ROOT .` and expected "only reference/spec history"; that expectation is unsatisfiable — the plan file itself, `docs/BACKLOG-V2.md:52`, `docs/reference/danny-agentos-video/{comparison,decisions}.md` and `docs/specs/batch-files-paths.md` all match. Documentation history is intentionally out of scope; see §11.1 note in the coverage map.)
- Manual (§11.4): `curl -X PUT -H "Authorization: Bearer $OPERATOR_TOKEN" --data-binary hello "localhost:3000/files/content?path=_global/hello.txt"` creates `~/Documents/agentos/_global/hello.txt`; `GET /files?dir=_global` lists it; Finder shows the same file.

## Step 7 — Grant path validation, enforcement, and session routes

Spec §5, §7 session mirror, §8 grant combos. Covers the server half of acceptance §11.6.

### Making the approved `""` semantics reachable (MF-4)

Spec §3/A5 defines `folderPath: ""` as "the whole Files Root", and Leo approved A5. That value cannot be created today: `filesystemGrantFields` declares `folderPath: z.string().trim().min(1).max(4096)` (`packages/api/src/app.ts:122-127`), so `POST /agents/:agentId/filesystem-grants {folderPath: "", canRead: true}` returns 400 `too_small`. This is not a reopening of A5 — it is the two-line change that makes the approved semantics reachable.

- `packages/api/src/app.ts:123` — replace `folderPath: z.string().trim().min(1).max(4096)` with
  ```ts
  folderPath: z.string().trim().max(4096).refine(
    (value) => value === "" || isCanonicalRelPath(value),
    'folderPath must be "" (the whole Files Root) or a normalized Files-Root-relative POSIX path',
  ),
  ```
  importing `isCanonicalRelPath` from `./files/paths.js`. Keeping `.trim()` preserves today's whitespace tolerance; requiring the *canonical* form (not merely a normalizable one) keeps the stored string byte-identical to what enforcement compares, so a grant can never mean something other than it reads.
  **Verify the derived schemas still parse after the change:** `filesystemGrantInput` (`app.ts:128-131`, object-level `.refine`) and especially `filesystemGrantPatch` (`app.ts:132`, `.partial()`), because a field-level `.refine` is a pipe in zod 4.4.3 (`packages/api/package.json:19` declares `^4.1.12`) and `.partial()` must wrap it. If `.partial()` rejects the pipe, fall back to an object-level `superRefine` on `folderPath` — same semantics, no shape change.
- `@@unique([agentId, folderPath])` (`schema.prisma:341`) treats `""` as an ordinary distinct value, so an agent gets at most one root grant. No migration needed — this is validation only, and the batch's single migration is already spent (spec §9).
- **Enforcement stays fail-closed for dirty history.** Pre-existing rows are deleted by step 2's migration, but a row could still be written by a future direct DB edit; `grantAdmits` normalizes every `grant.folderPath` at check time and a non-normalizable grant simply never matches.

### Files

- `packages/api/src/files/grants.ts` (new) — `requiredCapability(op)` per spec §5 (`list`/`stat`/`read` → `canRead`; `write`/`mkdir` → `canWrite`; `delete` → `canDelete`) and `grantAdmits(grants, op, path)`: normalize each `grant.folderPath`, skip any that fails, and succeed if **any one** surviving grant both `contains` the path (`""` contains everything) and carries the capability; on failure return the missing capability name so the 403 body can state it (spec §5). Overlapping grants: any sufficient one admits (spec §8). `canWrite` without `canRead` (drop-box) falls out naturally.
- `packages/api/src/files/grants.test.ts` (new — named explicitly, per SF-3; revision 1 referred vaguely to "`grants.ts`'s test file"). Pure unit tests over hand-built grant rows: the full capability matrix; drop-box; overlapping grants where only one is sufficient; a root grant (`""`); and dirty rows (`"/abs"`, `"a/../.."`, `"..\\x"`, `"a/"`) all failing closed.
- `packages/api/src/app.ts` — session routes mirroring the four MCP tools, placed with the existing session block (`app.ts:1451-1529`, ending just before `/runner/runs/:runId/complete` at `:1531`), auto-gated to the owning run by `principalMayAccess` (`auth.ts:51`):
  - `GET /session/runs/:runId/files?dir=` → list
  - `GET /session/runs/:runId/files/content?path=` → **`store.stat` first**; if `size > 5 * 1024 * 1024`, return 413 without reading (SF-2 — revision 1 read then measured). Otherwise `store.read` and respond JSON `{content, encoding: "utf8"|"base64", stat}` (A6: base64 iff the bytes are not valid UTF-8). The 413 body tells the agent the file is too large for a tool result.
  - `PUT /session/runs/:runId/files/content` `{path, content, encoding?}` → write, parents auto-created. Cap on the **decoded** byte length at 25 MB (base64 inflates ~4/3, so also refuse early when the request's `Content-Length` exceeds 34 MB).
  - `DELETE /session/runs/:runId/files?path=` → delete (file/empty dir only; **no recursive, no move** for sessions — A6).
  Per-request enforcement: the session principal carries `runId` → `db.run.findUnique({ where: { id: runId }, select: { agentId: true } })` → `db.filesystemGrant.findMany({ where: { agentId } })` → `grantAdmits`. `Run.agentId` exists directly on the Run model (`schema.prisma:592`), so spec §5's "run → task → assigned agent" collapses to one lookup reaching the same agent (ambiguity #5). No grant → 403 naming the capability.
- `packages/api/src/files/session-routes.test.ts` (new) — mock Prisma per the existing idiom (`run.findFirst` for `authenticate`, `run.findUnique`, `filesystemGrant.findMany`), a real temp-dir store, a real session token flow. Named tests: with `{folderPath: "<slug>", canRead: true}`, list/read inside succeed, write there → 403 naming `canWrite`, any access outside the folder → 403, and adding `canWrite` makes write succeed (§11.6's server half); root grant `{folderPath: "", canRead: true}` reaches every folder; drop-box (`canWrite` only) → write 200, read 403; overlapping grants where only the broader one carries the capability; a dirty grant row fails closed; the exact 403 body text naming the missing capability; **5 MB read boundary** (just under → 200, just over → 413, asserted via `stat` so no 5 MB buffer is allocated); **25 MB decoded write boundary**; invalid UTF-8 → `encoding: "base64"` round trip.

Commit: `feat(api): grant path validation and grant-enforced session file routes`

Verification: `npm test -w @agentos/api`, including the new grant-CRUD validation tests added to `packages/api/src/app.test.ts` (POST `""` accepted; POST `"/abs"`, `"a/../b"`, `"a/"` → 400; POST `"  _global  "` stored as `_global`; PATCH with a `folderPath` still parses).

## Step 8 — The four MCP file tools

Spec §6. Covers the client half of acceptance §11.6 and touches §11.7.

Files:

- `packages/runner/src/mcp-server.ts`:
  - **Widen the HTTP helper first (SF-1).** `call`'s method type is `"GET" | "POST" | "PUT"` (`:142`) — a `DELETE` branch would not type-check. Change it to `"GET" | "POST" | "PUT" | "DELETE"`. And build the URL properly: `:146` interpolates the path directly, so a legal filename containing `?`, `#`, `%` or `&` would change the request's meaning. Give `call` a `query?: Record<string, string>` parameter and construct with `new URL(...)` + `url.searchParams.set(...)`; no caller hand-builds a query string.
  - Append `files_list`, `files_read`, `files_write`, `files_delete` to the `TOOLS` array (`:74-138`) with JSON schemas matching spec §6's signatures, and extend `invokeTool` (`:156`) with four branches calling step 7's session routes through `call` (which already prefixes `/session/runs/:runId` at `:146`). `files_read` surfaces the route's `encoding` marker; 403 and 413 responses flow back as tool errors verbatim — the 403 already names the missing capability, so the agent can report precisely what it lacks. No `move` tool (A6). `agents/foundational.md:13` needs no text change: its "filesystem MCP" promise simply becomes true.
- `packages/runner/src/mcp-server.test.ts` — extend using the existing `withApi` stub-HTTP-server pattern (`:10-15`): each tool hits the right method and path with the session token; base64 round trip; 403 and 413 surfaced as tool errors; **and a query-encoding test with a filename containing `?`, `#`, `%`, `&`, a space and non-ASCII**, asserting the stub server receives the decoded name intact (SF-1). Update the handshake assertion `assert.equal(TOOLS.length, 4)` at `:52` to `8`.

Commit: `feat(runner): files_* MCP tools over session file routes`

Verification: `npm test -w @agentos/runner` (§11.7 runner half). End-to-end §11.6 — a live agent session exercising grants through the MCP — is a manual acceptance item in step 9; there is no automated runner-against-real-API testbed in the repo and this plan does not invent one.

## Step 9 — Full verification sweep and acceptance run-through

Covers §11.7 and re-checks §11.1–6.

No new code. Run and record the output in the PR:

1. `npm run typecheck -w @agentos/db -w @agentos/api -w @agentos/runner`
2. `npm test -w @agentos/api && npm test -w @agentos/runner` (§11.7)
3. `git grep -n AGENTOS_FILES_ROOT -- .env.example packages apps deploy` → **no output** (§11.1, runnable surface). Documentation history keeps its mentions by design; list them in the PR so the delta is visible rather than silently tolerated: `docs/BACKLOG-V2.md:52`, `docs/reference/danny-agentos-video/comparison.md:50,54`, `docs/reference/danny-agentos-video/decisions.md:35`, `docs/specs/batch-files-paths.md` (six mentions), and this plan.
4. `git grep -nE '/tmp/agentos-runs|/Users/Shared/agentos-runs' -- .env.example packages apps deploy` → **no output** (SF-6). Baseline is the four hits listed in step 1; the commented override example deliberately uses `/opt/agentos/runs` so it does not match.
5. **Grant-boundary isolation probe (MF-3).** With the §"Deployment preconditions" satisfied (`RUNNER_RUN_AS_PREFIX` set, `FILES_ROOT` inaccessible to that account), dispatch a task to an agent holding `{folderPath: "<slug>", canRead: true}` and, from inside that live session, run all three of:
   - `ls "$FILES_ROOT"`
   - `cat "$FILES_ROOT/_global/hello.txt"`
   - `touch "$FILES_ROOT/pwn"`

   All three must fail with `EACCES`/`EPERM`. In the same session, `files_list` and `files_read` through the MCP must succeed inside the grant and 403 outside it. Paste both halves into the PR. If the preconditions are **not** satisfied on this deployment, record that explicitly instead of skipping silently — the probe's failure is the finding, and `FilesystemGrant` is then documented as an audit boundary only.
6. Manual checklist against a locally running stack: §11.2 (fresh workspace under `~/.agentos/runs`, override wins), §11.3 (migration applied in step 2), §11.4 (curl + Finder), §11.6 end-to-end (create a grant via the existing agent-page CRUD — including one with `folderPath: ""` now that step 7 permits it — dispatch a trivial task, watch `files_list`/`files_read`/`files_write` behave per grant).

Commit: none (or `docs:` fixups if the sweep shakes something loose — anything larger reopens the owning step).

## Step / commit table

| Step | Commit | Touches | Independently compiles |
|---|---|---|---|
| 1 | `feat(paths): default run workspaces to ~/.agentos/runs` | `runner/config.ts`, `api/index.ts`, `api/app.ts`, `api/reconcile.ts`, `.env.example` | yes |
| 2 | `feat(db): drop dead FileObject/TaskAttachment, reset FilesystemGrant rows` | `db/prisma/schema.prisma`, new migration, `db/prisma/precheck-files.ts`, `db/package.json` | yes |
| 3 | `feat(api): FileStore seam and pure path discipline` | `api/files/{store,paths,paths.test}.ts`, `api/package.json` | yes |
| 4 | `feat(api): contained LocalFileStore with no-follow path resolution` | `api/files/local.ts` | yes |
| 5 | `test(api): containment probe wall for LocalFileStore` | `api/files/local.test.ts` | yes |
| 6 | `feat(api): operator /files routes over LocalFileStore, FILES_ROOT config` | `api/files/{config,routes.test}.ts`, `api/app.ts`, `api/index.ts`, `.env.example` | yes |
| 7 | `feat(api): grant path validation and grant-enforced session file routes` | `api/files/{grants,grants.test,session-routes.test}.ts`, `api/app.ts`, `api/app.test.ts` | yes |
| 8 | `feat(runner): files_* MCP tools over session file routes` | `runner/mcp-server.ts`, `runner/mcp-server.test.ts` | yes |
| 9 | none (sweep) | — | — |

Revision 1 had eight steps. The security work split from two into three (3/4/5) because the MF-2 rewrite is too large to review alongside the interface, and grant validation joined step 7.

## Deployment / migration sequencing (spec §9 + Leo's requirement #2)

1. **PR #6 (platform-repair batch) merges first.** It changes `reconcileWorkspaces` and fixes the suspended-run workspace-GC hole; this batch re-roots the very directory that code sweeps. Rebase this branch on it before merge if `reconcile.ts` conflicts.
2. Deploy with **no runs in flight** (drain: let RUNNING runs finish or stop them) — the root flip does not copy workspaces; old `/tmp/agentos-runs` (or `/Users/Shared/agentos-runs` per the current `.env.example:30`) content is inert and manually deletable. Stale `Run.workspacePath` rows are advisory; `reconcileWorkspaces` only acts inside the *current* root (`reconcile.ts:118,125`).
3. Run the step-2 migration during the same drained window (pre-check counts first).
4. **Before announcing Files as permission-bounded**, satisfy §"Deployment preconditions" and run step 9's probe 5. Until then the feature works but the grant check is not a security boundary, and `.env.example` says so.
5. Rollback per spec §10: the env override restores the old root; code is revert-safe; the dropped tables were verified empty so a forward re-add loses nothing; files on disk are never deleted by rollback.

## Test strategy (what runs where — honestly)

- **`app.test.ts`-style route tests use a mock**: an object literal cast to `PrismaClient` (`app.test.ts:26`). They verify routing, auth, validation and error mapping — they **cannot** verify migration correctness, FK behavior or unique constraints, and this plan does not pretend otherwise. No real-DB test harness exists in the repo and none is invented here.
- **Real database** verification is step 2's procedure itself against the dev Postgres (`DATABASE_URL` from `.env`, `.env.example:5`): pre-check, apply, `db:validate`, plus step 9's manual checklist. That is the entire real-DB surface this batch needs — after the migration there are no file rows left to constrain.
- **Filesystem layer runs real IO**: `local.test.ts`, `routes.test.ts` and `session-routes.test.ts` all use `mkdtemp` temp dirs with actual symlinks, actual `lstat`, actual `O_NOFOLLOW` opens, actual traversal attempts. Deliberate: the security wall must be tested against a real filesystem, not a mock. `paths.test.ts` and `grants.test.ts` are pure and touch no disk.
- **Runner MCP tests** use the existing `withApi` local-HTTP-stub pattern (`mcp-server.test.ts:10-15`) — real HTTP, stubbed API.
- Test files this batch adds, all of them reachable only because step 3 extends the glob at `packages/api/package.json:10`: `src/files/paths.test.ts`, `src/files/local.test.ts`, `src/files/routes.test.ts`, `src/files/grants.test.ts`, `src/files/session-routes.test.ts`.
- Command for the lot: `npm test -w @agentos/api && npm test -w @agentos/runner`.

## Spec-coverage map (spec §11 → steps)

| §11 criterion | Step(s) |
|---|---|
| 1. `AGENTOS_FILES_ROOT` gone | 6 (verified again in 9) — scoped to the runnable surface; see the §11.1 note below |
| 2. Workspaces under `~/.agentos/runs`, override wins | 1 |
| 3. Models dropped, migration clean | 2 |
| 4. Operator write→list→Finder | 6 |
| 5. Traversal probes, unit-tested | 3 + 4 + 5 |
| 6. Grant-scoped session access, 403 names capability | 7 (server) + 8 (MCP) + 9 (end-to-end, plus the isolation probe that makes the boundary real) |
| 7. Both test suites pass | 3–8 cumulatively, swept in 9 |

**§11.1 note (deviation, deliberate).** The spec's literal wording is `grep -r AGENTOS_FILES_ROOT` over the repo returning "only `docs/reference/` history mentions". That is unsatisfiable as written: the spec itself, `docs/BACKLOG-V2.md:52` and this plan all contain the string. The plan checks the runnable surface (`.env.example packages apps deploy`) instead and enumerates the documentation hits in step 9 so nothing is hidden. Worth a one-line spec amendment at the next spec touch; listed under §"Open for Leo".

## Ambiguities — defaults chosen here, not silently in the implementation

Each item: the default this plan implements, and what overturning it costs.

1. **API's own `/tmp/agentos-runs` fallbacks** (`api/index.ts:17`, `app.ts:1721`) are not in the spec's change list. **Default:** change them in step 1 to match the runner's new default. **Cost:** none to code, but the API-side reconciler would otherwise sweep a root the runner no longer writes, silently stopping workspace GC — close to forced.
2. **Where `FILES_ROOT` resolves and when the store is built.** *(Rewritten in revision 2 — the no-follow store is async to construct, so revision 1's "one store per app instance built inside the synchronous `createApp`" no longer works.)* **Default:** `resolveFilesRoot()` reads `process.env` at first use; `getFileStore()` memoizes one store promise per resolved root in a module-level map, with `resetFileStores()` for tests. **Cost:** module-level state; tests must call `resetFileStores()` when they repoint `FILES_ROOT`. The alternative — making `createApp` async — would touch every existing call site and test.
3. **Recursive delete vs. the thin interface.** Spec §4's `delete` is file-or-empty-dir; spec §7 offers `?recursive=true`. **Default:** the route layer walks `list` + `delete` through the store, keeping the seam at seven methods. **Cost:** O(children) store calls on big trees — irrelevant on local disk, mildly wasteful on a future R2; widening the interface later is additive.
4. **Dirty and root `FilesystemGrant.folderPath` values.** *(Rewritten in revision 2 — MF-4.)* Revision 1 left CRUD untouched, which made the approved `""` semantics unreachable (`app.ts:122-127` rejects it with 400). **Default:** step 7 changes `filesystemGrantFields` to accept exactly `""` or a canonical Files-Root-relative POSIX path, and enforcement additionally fails closed on any non-normalizable value that reaches it by another route. **Cost:** a two-line validation change beyond the spec's file list, and operators can no longer save a `folderPath` that would never have matched anything — arguably the point.
5. **Run→agent resolution.** Spec §5 says "run → task → assigned agent"; `Run.agentId` exists directly (`schema.prisma:592`). **Default:** use `Run.agentId` — same agent by construction, one lookup. **Cost:** none; revert to the two-hop join if a future batch ever lets a run's agent diverge from the task's assignee.
6. **Where the 5 MB read cap lives.** **Default:** enforced in the session `GET files/content` route via `store.stat` before reading, not in the MCP client. **Cost:** any future non-MCP session consumer shares the cap; today the MCP is the only consumer, and server-side is the only placement an agent cannot bypass.
7. **Shadow database provisioning.** *(Rewritten in revision 2 — MF-5.)* Prisma 6.19.0 has no `--shadow-database-url` flag; **default:** rely on Postgres auto-creation (the local `agentos` role owns the Compose server). **Cost:** if the role lacks `CREATEDB`, recovery is **not** self-service — a DBA/superuser must create `agentos_shadow OWNER agentos` or grant `CREATEDB`, after which the fallback is a two-line config addition. Revision 1 claimed the `agentos` role could create the database itself; it cannot, and that claim was the whole failure mode.
8. **`list("")` on a virgin root.** Spec §8 wants 404 for missing dirs, but the future UI's first act is listing an untouched root. **Default:** the store creates the root at construction, so the root always lists (`[]`) while missing *sub*dirs 404. **Cost:** an empty `~/Documents/agentos/` appears on first API start even if Files is never used.
9. **All symlinks inside the Files Root are rejected, not just escaping ones.** *(New in revision 2.)* Spec §8 only requires refusing symlinks whose target resolves outside the root. **Default:** the store refuses every symlink it meets as a path component, as a final target, or as a `stat` subject — because "does this link stay inside?" cannot be answered without a `realpath` that reintroduces the TOCTOU window the no-follow walk exists to remove. `delete` is the one exception: it unlinks the link itself, so a stray symlink is still removable through the API. **Cost:** an operator who deliberately places an inside-pointing symlink in the Files Root finds it inert from the API (still visible in Finder). Overturning this means reintroducing per-component `realpath` and accepting the wider race; the plan judges that a bad trade. Listed under §"Open for Leo".
10. **`list` omits symlink entries silently.** **Default:** symlinked entries are filtered out of `list` results rather than returned with a marker. **Cost:** a file the human sees in Finder is invisible in the future Files UI with no explanation. The alternative — a third `kind: "symlink"` in `FileStat` that the UI renders as inert — is additive and can land with the UI batch, which is when it would actually be visible.

## Open for Leo (recorded, not blocking — no `inbox_ask` this run)

1. **Ship-before-isolation (MF-3).** This plan documents the run-as/sandbox precondition and probes it, but does **not** block the batch on `agentrunner` existing. If you would rather the Files feature stay unmerged until the precondition is genuinely satisfied on this machine, say so and step 9's probe 5 becomes a merge gate instead of a recorded result.
2. **Spec §11.1 wording.** The literal `grep -r` acceptance criterion is unsatisfiable; the plan scopes it to the runnable surface and lists the documentation hits. Worth amending the spec text at its next touch.
3. **Ambiguity #9** — rejecting inside-pointing symlinks too, which is stricter than spec §8's wording. Called out because it is a real behavior narrowing, not because it is in doubt.

## Revision record (revision 1 `6067e69` → revision 2)

### Must-fix — all six implemented, none deferred

| # | Finding | Where it is now implemented |
|---|---|---|
| MF-1 | `Task.attachments` missed → `P1012`, migration ungenerable | Step 2, deletion item 4, with the verified citation `schema.prisma:473` and an explicit note that `TaskTemplateStep.attachmentsFromPrevious` (`:425`) stays. `db:validate` in step 2's verification is the check that would have caught it. |
| MF-2 | Lexical root false-rejects; parent-only `realpath` leaves three escapes | Step 4 rewritten end to end: canonical root at construction (fixes the false reject), component-wise no-follow `lstat` walk (fixes intermediate symlinks and the `readdir` escape), `O_NOFOLLOW` on the final `open` (fixes the final-component escape and its swap), `list`/`stat` no longer follow. §"Threat model" states the residual post-walk intermediate swap explicitly and **withdraws any claim of standalone absolute containment**. Step 5's probe wall grew from 3 items to 19, covering every case the review named: symlinked root, final-component symlink, `list`/`stat`, inside→inside→outside, absent parent, deterministic swap, Windows drive/UNC/backslash, `NUL`, single and double URL encoding. |
| MF-3 | `FilesystemGrant` is not the agent's real boundary | New top-level §"Deployment preconditions" with the verified evidence (`config.ts:37`, `.env.example:36`, `adapters.ts:358-362`), stated as a hard precondition rather than an ACL change (A4 untouched); documented in `.env.example` twice (steps 1 and 6); acceptance probe 5 in step 9 requires shell access to fail with `EACCES`/`EPERM` while MCP access succeeds per grant, and requires an explicit negative record if the preconditions are unmet. Also cited as what makes MF-2's residual race unreachable. |
| MF-4 | `folderPath: ""` unreachable through CRUD | Step 7's first subsection changes `filesystemGrantFields` (`app.ts:122-127`) to accept exactly `""` or a canonical relative POSIX path, with the zod-4 `.partial()` risk flagged and a fallback named; root-grant and dirty-value tests added to `grants.test.ts`, `session-routes.test.ts` and `app.test.ts`. Ambiguity #4 rewritten from "CRUD stays as-is" to the opposite. |
| MF-5 | `CREATE DATABASE` fallback fails under its own trigger condition | Step 2's shadow-database note rewritten: the fix now requires a DBA/superuser to `CREATE DATABASE agentos_shadow OWNER agentos` (or `ALTER ROLE agentos CREATEDB`, or hand over a pre-provisioned DB), and states in as many words that the `agentos` role cannot create it itself. The correct Prisma-6.19-has-no-flag finding is retained (version verified: `packages/db/package.json:26,30`). Ambiguity #7 rewritten to match. |
| MF-6 | `grep -rn AGENTOS_FILES_ROOT .` cannot return what was claimed | Steps 6 and 9 now run `git grep -n AGENTOS_FILES_ROOT -- .env.example packages apps deploy` expecting no output; the documentation hits are enumerated in step 9 and the deviation from the spec's literal wording is recorded in the coverage map's §11.1 note and in §"Open for Leo". Baseline verified: one runnable hit today (`.env.example:50`). |

### Should-fix — six dispositions, all explicit

| # | Finding | Disposition |
|---|---|---|
| SF-1 | MCP helper needs `DELETE` + URL-encoded query | **Adopted.** Step 8 widens `call`'s method union (`mcp-server.ts:142`) before adding tools, replaces the `:146` interpolation with `new URL` + `searchParams`, and adds an encoding test over `? # % & space` and non-ASCII. |
| SF-2 | Cap before buffering; missing behaviors in the test matrix | **Adopted.** Step 6: `Content-Length` refused pre-read, chunked bodies read through a bounded aborting reader, `recursive=true` tested. Step 7: session read `stat`s before reading; named tests for the 5 MB and 25 MB decoded boundaries, invalid UTF-8, drop-box, overlapping grants, dirty grants and the 403 body text. |
| SF-3 | Name the grant test file | **Adopted.** `packages/api/src/files/grants.test.ts` is now a listed file in step 7, and §"Test strategy" enumerates all five new test files against the extended glob at `packages/api/package.json:10`. |
| SF-4 | Pre-check hard-codes a localhost DB | **Adopted, with a correction to the suggested fix.** A repo script is the right call, but plain `psql "$DATABASE_URL"` also fails here: `.env.example:5`'s URL carries `?schema=public`, which libpq rejects as an unknown query parameter. Step 2 therefore adds `packages/db/prisma/precheck-files.ts` run through `dotenv -e ../../.env -- tsx`, using Prisma's own URL handling, plus the `docker compose exec` equivalent the finding asked for. |
| SF-5 | `.env.example` assignment form for the new default | **Adopted.** Step 1 comments out the active `RUNNER_WORKSPACE_ROOT=` at `:30`, states the default in prose, warns that values are not shell-expanded, and gives an absolute commented override — using `/opt/agentos/runs` rather than the old path so SF-6's grep stays clean. Same treatment for `FILES_ROOT` in step 6. |
| SF-6 | Add a workspace-root regression grep | **Adopted.** `git grep -nE '/tmp/agentos-runs\|/Users/Shared/agentos-runs' -- .env.example packages apps deploy` runs in step 1 (to prove the move is complete) and again in step 9. Baseline verified at four hits; the finding's claim that there is no fifth is confirmed. |

### Consequential edits beyond the findings

Named here because the must-fixes forced them, per the revision brief:

- **Step count 8 → 9 and a redrawn commit table.** MF-2's rewrite made the security implementation too large to share a commit with the `FileStore` interface, so revision 1's step 3 split into steps 3 (interface + pure paths), 4 (store) and 5 (probe wall); MF-4's validation change joined the grant step. Each step is still exactly one commit and still compiles standalone.
- **The `packages/api/package.json:10` test-glob edit moved from step 4 to step 3**, because `paths.test.ts` is now the first file under `src/files/`.
- **Ambiguity #2 rewritten and two new ambiguities (#9, #10) added** — direct consequences of MF-2: an async store constructor forces a memoized `getFileStore()` instead of construction inside the synchronous `createApp`, and the no-follow rule narrows symlink behavior (`list` and `stat`) beyond what spec §8 literally requires.
- **`packages/db/prisma/precheck-files.ts` and a `db:files-precheck` script** are new files, added for SF-4.
- **All `file:line` citations were independently re-derived** against `6067e69` rather than carried over from revision 1. Two of the review's own probes were reproduced on this machine before being relied on: `tmpdir()` `/tmp` vs. realpath `/private/tmp` yielding `prefixPass = false`, and `O_NOFOLLOW` refusing both read and write through a final-component symlink with `ELOOP`.
