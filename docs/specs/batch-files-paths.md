# SPEC — Files batch: path scheme landing + thin storage interface

Status: draft for approval · Chain step 1 of 9 · 2026-08-16
Source of truth: `docs/reference/danny-agentos-video/decisions.md` §4–§6, `docs/BACKLOG-V2.md` 长尾 Files item.
Scope: backend + paths only. The Files UI page (SVAR file manager) ships with the frontend batches and is **out of scope** here; §7 defines the API surface that UI will consume.

## 1. Problem and audience

AgentOS scatters its on-disk state today: run workspaces live in the world-writable, reboot-wiped `/tmp/agentos-runs` (`packages/runner/src/config.ts:34`), the intended Files feature exists only as a dead env var (`.env.example:50`, `AGENTOS_FILES_ROOT` — zero code references) and two dead DB models (`FileObject` at `packages/db/prisma/schema.prisma:895`, `TaskAttachment` at `:510` — zero runtime references), and `FilesystemGrant` (`schema.prisma:332`) has CRUD routes (`packages/api/src/app.ts:518-544`) but is enforced nowhere. Agents are promised a "filesystem MCP" in their foundational prompt (`agents/foundational.md:13`) that does not exist.

Audience: Leo as the single self-hosted operator, and the agents that need a durable, permission-checked place to persist deliverables that outlive their throwaway workspaces.

This batch lands: (a) the two-root path scheme, (b) a thin storage interface with a local-disk implementation, (c) server-side permission enforcement (`FilesystemGrant` + `inside()`), and (d) the session-facing file tools, so the future Files UI and the existing agent prompt both have something real behind them.

## 2. Path scheme

### 2.1 `~/.agentos/` — hidden, machine-managed root

Machine-owned state the human never browses:

```
~/.agentos/
  runs/        # run workspaces (today: /tmp/agentos-runs)
  logs/        # reserved, not populated by this batch
  cache/       # reserved, not populated by this batch
```

- `RUNNER_WORKSPACE_ROOT` default in `packages/runner/src/config.ts:34` changes from `"/tmp/agentos-runs"` to `join(homedir(), ".agentos", "runs")` (resolved at config load via `node:os` `homedir()`, honoring `RUNNER_HOME` is **not** required — the root belongs to the operator account that runs the runner process, not to the agent session). The env override stays.
- The runner creates the directory on first provision (it already `mkdir`s workspaces; add recursive creation of the root — `packages/runner/src/workspace.ts:51-60`).
- `logs/` and `cache/` are name reservations only: no code writes there in this batch. They exist in the spec so later batches don't invent competing locations.

**Run-as caveat (edge case, must be documented in `.env.example`):** DECISIONS #4 runs agent sessions as the low-privilege `agentrunner` user via `RUNNER_RUN_AS_PREFIX`. `/tmp` was traversable by any user; `~/.agentos` under the operator's home is not. When `RUNNER_RUN_AS_PREFIX` is set, the operator must either point `RUNNER_WORKSPACE_ROOT` at an `agentrunner`-accessible location or grant traversal (`chmod +x` on `~` path components and appropriate perms on `~/.agentos/runs`). The runner already fails loudly if the root is unusable in run-as mode (`workspace.ts:57-58` stats the root); this spec adds no automatic ACL management. *(Assumption A4.)*

### 2.2 `~/Documents/agentos/` — visible Files Root

Human-browsable file storage, the domain of the Files feature:

```
~/Documents/agentos/
  _global/           # cross-project files
  <project-slug>/    # one folder per project, named by Project.slug
```

- Configured by a new **`FILES_ROOT`** env var on the API package, default `join(homedir(), "Documents", "agentos")`. *(Assumption A2: new name; the deleted `AGENTOS_FILES_ROOT` is not resurrected, avoiding confusion with the dead config.)*
- Per-project folders use `Project.slug` (already `@unique`, `schema.prisma` Project model), not the display name — slugs are filesystem-safe and collision-free. *(Assumption A3.)* Folders are created lazily on first write; renaming a project's slug does **not** move its folder (the old folder simply becomes orphaned content visible under the old name; acceptable for a single-user tool, noted as a known limitation).
- Code repositories stay where they are (`~/Documents/claude_projects/…`); this root is for Files, not repos (decisions §4).

### 2.3 Delete the dead config

- Remove `AGENTOS_FILES_ROOT=./var/files` and its comment from `.env.example:49-50`. Verified zero code references (grep over `packages/`, `apps/`, `deploy/`).

## 3. Data model

`FileObject` (`schema.prisma:895-909`) and `TaskAttachment` (`schema.prisma:508-515`) are dead: no API route, no runner code, no UI reads or writes them. Decisions §5 authorizes free redesign of `FileObject` in this batch.

**Decision: delete both models; the filesystem is the single source of truth.** *(Assumption A1 — the most consequential one.)*

Rationale: a DB index over disk files must be kept in sync with a directory the human is explicitly invited to manipulate in Finder. Sync is a standing bug farm, and nothing in V2 needs per-file DB rows — listing, reading, and writing all go through the storage interface directly against disk. Task attachments, when they return, can reference Files-Root-relative paths as plain strings.

Schema changes (one migration, per decisions §5 "schema 改动跟随所属批次"):
- Drop `FileObject`, `TaskAttachment`, and the `files FileObject[]` relation on `Project` (`schema.prisma:180`).
- `FilesystemGrant` (`schema.prisma:332-343`) is kept as-is: `agentId`, `folderPath`, `canRead`/`canWrite`/`canDelete`, unique on `(agentId, folderPath)`. New semantics (documented, no column change): **`folderPath` is a Files-Root-relative POSIX path** (`""` = whole root, `_global` = the global folder, `myproject/reports` = a subtree). Existing rows: verify count is 0 before migrating; if nonzero, they were written against undefined semantics and are deleted by the migration. *(Assumption A5.)*

## 4. Thin storage interface

New module `packages/api/src/files/` (staying inside the api package; no new workspace package for one interface + one impl):

```ts
// store.ts
export type FileStat = { path: string; kind: "file" | "dir"; size: number; modifiedAt: Date };

export interface FileStore {
  list(dir: string): Promise<FileStat[]>;          // non-recursive
  stat(path: string): Promise<FileStat | null>;
  read(path: string): Promise<Buffer>;
  write(path: string, data: Buffer): Promise<FileStat>; // creates parent dirs
  delete(path: string): Promise<void>;             // file or empty dir
  mkdir(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;   // rename within the root
}
```

Design constraints keeping the R2/S3 seam real (decisions §6):
- All paths are **root-relative POSIX strings**; no `node:fs` types, absolute paths, streams, or file descriptors cross the interface. An object-store implementation maps them to keys unchanged.
- No watch/notify, no permissions, no metadata beyond `FileStat` — permissions are the caller's job (§5), which is exactly where an R2 impl would also need them.
- `LocalFileStore` (`local.ts`) is the only implementation in this batch, constructed with the resolved `FILES_ROOT`.

`LocalFileStore` containment rule (the load-bearing security property): every incoming path is normalized, rejected if it is absolute or contains a `..` segment after normalization, then resolved against the root and checked with the same prefix idiom already used at `packages/runner/src/workspace.ts:14` and `packages/api/src/reconcile.ts:118` (`resolved.startsWith(root + sep)`, root itself allowed only for `list`/`stat`). Symlinks inside the Files Root that point outside it are not followed for `read`/`write`: the implementation `realpath`s the parent directory and re-checks containment before the operation. Single-user tool, but agents write here — the boundary must hold against agent-authored paths, not just typos.

## 5. Permission model

Two principals touch files, mirroring the existing auth split (`packages/api/src/auth.ts:5-9`, `principalMayAccess` at `:48-53`):

- **Operator** (web UI, `OPERATOR_TOKEN`): full access to the whole Files Root through the `/files/*` routes (§7). Single-user tool; the human owns the directory anyway.
- **Session** (agent, `agos_session_` token → `runId`): access only through `/session/runs/:runId/files/*` routes, enforced server-side per request:
  1. Resolve run → task → assigned agent (the session principal already carries `runId`).
  2. Load the agent's `FilesystemGrant` rows.
  3. The request path must satisfy `inside(grant.folderPath, requestPath)` (prefix containment on normalized root-relative paths, where `folderPath` `""` contains everything) for **at least one** grant carrying the required capability: `list`/`stat`/`read` → `canRead`; `write`/`mkdir` → `canWrite`; `delete` → `canDelete`; `move` → `canWrite` on both endpoints, plus `canDelete` on the source. No grant → 403 with a body naming the missing capability, so the agent can report precisely what it lacks.
- Grants CRUD stays as-is on the operator API (`app.ts:518-544`); the UI for editing them already exists on the agent page.

Enforcement lives in the API route layer, not in `LocalFileStore` — the store stays permission-free so the R2 seam doesn't inherit an agent concept.

## 6. Session tool surface (filesystem MCP)

The runner's hand-rolled MCP server (`packages/runner/src/mcp-server.ts`, `TOOLS` array) grows four tools, backed by the `/session/runs/:runId/files/*` routes using the existing session credentials (`AGENTOS_SESSION_TOKEN`):

- `files_list(dir)` → array of `FileStat`
- `files_read(path)` → text content, or base64 with an `encoding: "base64"` marker when the content is not valid UTF-8 *(Assumption A6)*
- `files_write(path, content, encoding?)` → `FileStat`
- `files_delete(path)` → ok

`mkdir` is implicit in `write` (parents auto-created); `move` is operator/UI-only in this batch — agents that need it can read+write+delete. This keeps the agent surface at four tools, matching the existing four (`mcp-server.ts:75-115`) in weight. `agents/foundational.md:13`'s "filesystem MCP" promise becomes true; the prompt text itself needs no change.

## 7. Operator API surface (what the future SVAR UI consumes)

All operator-authenticated, thin wrappers over `FileStore` with paths as query/body params (paths contain `/`, so they don't ride in route segments):

| Route | Behavior |
|---|---|
| `GET /files?dir=<path>` | list directory (non-recursive) |
| `GET /files/content?path=<path>` | download; `Content-Type` sniffed from extension, `Content-Disposition: attachment` |
| `PUT /files/content?path=<path>` | upload/overwrite raw body; 25 MB request cap *(Assumption A7)* |
| `POST /files/mkdir` `{path}` | create directory |
| `POST /files/move` `{from, to}` | rename/move |
| `DELETE /files?path=<path>` | delete file or empty dir; `?recursive=true` for non-empty dirs |

Session routes mirror the four MCP tools: `GET /session/runs/:runId/files`, `GET|PUT .../files/content`, `DELETE .../files` — same shapes, grant-checked per §5. SVAR's adapter maps onto list/read/write/move/delete directly; nothing UI-specific is baked into the API.

## 8. Edge cases and failure behavior

- **Path traversal / absolute paths / `..`**: 400 before touching disk (§4 containment rule). Applies to both operator and session routes.
- **Symlink escape**: read/write through a symlink whose target resolves outside the root → 400.
- **Missing roots**: `FILES_ROOT` and per-project folders are created lazily on first write; `list` on a nonexistent dir returns 404, not an empty array (the UI needs to distinguish).
- **Concurrent writes**: last-writer-wins, no locking. Single user, low contention; documented, not solved.
- **Grant edge combos**: `canWrite` without `canRead` is legal (drop-box). Overlapping grants: any one sufficient grant admits the operation.
- **Project slug rename**: folder is not moved (§2.2); old folder stays browsable under `_global`-style manual cleanup.
- **Large files**: writes over the 25 MB cap → 413. Reads are unbounded (operator downloads own disk content); MCP `files_read` over 5 MB → error telling the agent the file is too large for a tool result.
- **Run-as runner user**: see §2.1 caveat; failure mode is a loud provision error, not silent fallback to `/tmp`.

## 9. Migration notes

**Run workspaces — fresh start, no copy.** Justification: `/tmp/agentos-runs` is ephemeral by design (macOS purges `/tmp` on reboot), workspaces are throwaway by contract (`agents/foundational.md`), and `reconcileWorkspaces` (`packages/api/src/reconcile.ts:120`) tolerates an empty or missing root (`ENOENT → 0`). Procedure: deploy with no runs in flight (drain: let RUNNING runs finish or stop them), flip the default, start the runner. Historical `Run.workspacePath` values keep pointing at `/tmp/…`; they are advisory strings and `reconcileWorkspaces` only acts on paths inside the *current* root, so stale rows are inert. Leftover `/tmp/agentos-runs` contents may be deleted manually or left for the next reboot.

**DB migration** (single Prisma migration in this batch): drop `TaskAttachment`, drop `FileObject`, drop `Project.files` relation; delete any `FilesystemGrant` rows predating the new `folderPath` semantics (expected 0 — verify with a row count before running; if `FileObject` unexpectedly holds rows, stop and escalate rather than drop).

**Config**: remove `AGENTOS_FILES_ROOT` from `.env.example`; add `FILES_ROOT` (commented, showing the default) and the run-as caveat comment next to `RUNNER_WORKSPACE_ROOT`.

## 10. Rollback

- Path scheme: revert the config default / set `RUNNER_WORKSPACE_ROOT=/tmp/agentos-runs`; workspaces are disposable so nothing is lost either direction.
- Storage/API/MCP: additive code; revert the commit. The four new MCP tools disappear from the next session's tool list; running sessions fail those calls loudly.
- DB: **there is no rollback.** Prisma 6.19 has no `migrate down` (`npx prisma migrate --help` lists no such command) and this repository carries no restoration migration. Recovery is forward-only: re-insert `FilesystemGrant` rows from the pre-migration export as Files-Root-relative paths, and, if the dropped models are ever needed again, write a new forward migration re-adding them from the pre-drop schema. The dropped models were required to be empty (guarded in SQL, §9), so there is no row data to restore. Files on disk are never deleted by the migration in either direction. Full procedure: `docs/runbooks/files-deployment.md` §5.

## 11. Acceptance criteria (reviewer checklist)

1. `grep -r AGENTOS_FILES_ROOT` over the repo returns only `docs/reference/` history mentions.
2. Fresh runner start with no env overrides provisions a workspace under `~/.agentos/runs/<runId>` (verify via `Run.workspacePath` and on disk); `RUNNER_WORKSPACE_ROOT` override still wins.
3. `FileObject`/`TaskAttachment` are gone from `schema.prisma`; migration applies cleanly on a dev DB.
4. `PUT /files/content?path=_global/hello.txt` as operator creates `~/Documents/agentos/_global/hello.txt`; `GET /files?dir=_global` lists it; Finder shows the same file.
5. Traversal probes (`path=../outside.txt`, absolute path, symlink pointing at `~/.ssh`) all return 400 and touch nothing (unit tests in `packages/api` cover the containment rule).
6. An agent session whose agent has a grant `{folderPath: "<slug>", canRead: true}` can `files_list`/`files_read` under that folder and gets 403 with the missing capability named on `files_write` there and on any access outside it; adding `canWrite` makes `files_write` succeed. Covered by an API-level test using a session token.
7. `packages/api` and `packages/runner` test suites pass.

## 12. Out of scope

- Files UI page / SVAR file manager (frontend batches; consumes §7 as-is).
- R2/S3 implementation (seam only, per decisions §6).
- Task attachments feature (models deleted; future batches re-add on top of path strings).
- Populating `~/.agentos/logs/` and `cache/`.
- Automatic OS ACL management for the `agentrunner` user.
- Grant-editing UI changes (existing agent-page CRUD suffices).

## Assumptions (need Leo's eyes)

- **A1** `FileObject` + `TaskAttachment` are deleted outright; disk is the source of truth, no DB file index. (Decisions §5 permits redesign; this is the simplest reading, but it forecloses DB-backed attachment queries until re-added.)
- **A2** The wired Files Root env var is named `FILES_ROOT`, not a resurrected `AGENTOS_FILES_ROOT`.
- **A3** Per-project folders are named by `Project.slug`; slug renames don't move folders.
- **A4** Run-as (`agentrunner`) accessibility of `~/.agentos/runs` is the operator's manual responsibility, documented in `.env.example` — no automatic ACL management.
- **A5** Any pre-existing `FilesystemGrant` rows (expected none) are deleted by the migration since their `folderPath` semantics were never defined.
- **A6** MCP file tools carry binary content as base64 with a 5 MB read cap; `move` is not offered to agents.
- **A7** 25 MB upload cap on operator writes.
