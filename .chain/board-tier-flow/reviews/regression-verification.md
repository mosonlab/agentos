# Post-fix regression verification — board tier-flow wiring

Verdict: **PASS**, bound to `905baf34266126d74ecada589211323d17294e13`.

## Range and identities

- implementation base: `45584af215b1e727316caf63e900d765d727aa91`
- pre-fix code head: `e387cac448854d0b033fada65e38024ed5e46099`
- pre-fix head including chain records: `0befc629e355066c0e3128aeaacaa27e2324ece8`
- fixed head under verification: `905baf34266126d74ecada589211323d17294e13`
  (`fix: preserve deferred board task starts`)
- fix diff reviewed as one unit: `0befc62..905baf3` — 8 files, +236 / −57
  (`apps/web/src/pages/Tasks.tsx`, `apps/web/src/tests/tasks-board.test.tsx`,
  `packages/api/src/chain-branch.dbtest.ts`, `packages/api/src/templates.test.ts`,
  `packages/api/src/templates.ts`, `packages/api/src/workflow.test.ts`,
  `packages/db/src/workflow.ts`, `public-snapshot.json`)
- must-fix authority: `.chain/board-tier-flow/reviews/adjudication.md` (`0befc62`)
- specification: `.chain/board-tier-flow/spec.md`. No `slices/` — direct chain.
- forbidden files `packages/db/src/merge-integrator.ts` and
  `packages/db/src/agent-contract.ts` are byte-identical across `45584af..905baf3`.

This session is not the persisted `opus_blind_review` session
(`cmt28jgrp00pdmp4597991ziz`); exact resume was unavailable, so the complete
persisted review package — spec, both reports, and the closed adjudication — was
read before judging the fix, as the role's fallback requires.

## Must-fix account — all four closed

### MFX-01 — P0 — `autoStart: false` stranded the chain branch — CLOSED

The fix removes the immediate-start-only `tx.run.update({ branch: branchName })`
(`packages/api/src/templates.ts:172-174`) and instead derives the head inside
`resolveRunBranches` (`packages/db/src/workflow.ts:238-254`, `:352-366`). Step ①,
whose `targetBranch` is deliberately `repo.defaultBranch`, recovers the shared
head from the lowest-`chainIndex` sibling of the same chain whose `targetBranch`
is not the repository default; steps ②..n keep the pre-existing expression
byte-for-byte and never issue the extra query. Both the immediate and the
deferred first start therefore go through one resolver.

Verified against a real PostgreSQL, not by reading alone:

- `T6b: a deferred template start preserves its custom head and successor base`
  — PASS. Instantiates with `autoStart:false` and `branchName: custom/deferred`,
  asserts zero Runs, starts step ① through `POST /tasks/:id/start`, asserts
  `run.branch === "custom/deferred"` and `run.targetBranch === repo.defaultBranch`,
  publishes, completes, then asserts the successor's `branch` and `targetBranch`
  are both `custom/deferred`. This is exactly the base/head continuity MFX-01
  required.
- `T6: a template chain still uses agentos/<chainId>, and a branchName override
  still wins` — PASS, so the `autoStart:true` path is unregressed.
- `a deferred template first run recovers its shared head from a later step`
  (`packages/api/src/workflow.test.ts:598-606`) — PASS at the resolver's unit level.

The sibling lookup rides the existing `@@unique([chainId, chainIndex])` index and
runs inside the same serializable transaction that just wrote the sibling rows,
so an `autoStart:true` instantiation still sees them.

### MFX-02 — P1 — start confirmation hijacked the card menu — CLOSED

`dropAction(status, startable)` became
`moveAction(origin, status, startable)` (`apps/web/src/pages/Tasks.tsx:51-53`),
and the page now has two callbacks. `move` (`:248-258`) is the unchanged plain
PATCH. `drop` (`:260-269`) is new and consults startability only for `DOING`.
Wiring verified exhaustively:

- `actions.onMove` → `move` (`:308`), and `actions` is what `TaskCard`'s
  `Move to →` menu calls (`apps/web/src/components/task-card.tsx:136`) and what
  `MobileTaskList` renders every card with (`:362`, `mobile-task-list.tsx:93`).
  Menu and mobile are PATCH-only again.
- `DesktopBoard.onMove` → `drop` (`:372`). Repository-wide, `DesktopBoard`
  consumes that prop at exactly one site — `onDrop` (`desktop-board.tsx:341`) —
  so the confirmed-start path is reachable only from a desktop drop.
- `moveAction("menu", status, true) === "patch"` is asserted for every column
  (`tasks-board.test.tsx:71-77`).

### MFX-03 — P1 — a failed confirmed start rendered its error behind the modal — CLOSED

The flow moved into `useTaskStartConfirmation` (`Tasks.tsx:112-155`) and
`StartTaskDialog` now takes `error` and renders `<ErrorNotice message={error} />`
inside the `Modal` (`:84-110`). `confirm` no longer clears `request` on failure,
so the message appears in the active, non-inert surface; the page-level
`{startError && <ErrorNotice/>}` was deleted (`:349`). `requestForDrop` calls
`setError(null)` before opening (`:123`), and `cancel` clears both — the stale
cross-card error folded in from OP-8 is closed too.

`drop confirmation decline is inert and a failed POST stays visible in its active
surface` (`tasks-board.test.tsx:150-165`) drives the real hook through jsdom and
asserts: confirmation opens; Cancel issues neither POST nor PATCH; Start issues
exactly one `POST /api/tasks/t1/start` and zero `PATCH /api/tasks/t1`; and the
server's own sentence `Run budget was exhausted by another operator.` is inside
`[data-confirmation]` after a 409.

### MFX-04 — P1 — the tracked chain specification was unclassified — CLOSED

`public-snapshot.json` gains a directory-level `.chain/**` exclusion with a
reason, at the directory level the adjudication required rather than per file.
`later-release-follow-up` is the only disposition the manifest validator accepts
for an exclusion that is not itself a blocker
(`scripts/public-snapshot-scan.mjs:111-115`), so the choice is forced, not loose.

Verified differentially rather than by assertion:

| head | blockers |
| --- | --- |
| `e387cac` (pre-fix, scanned in a detached worktree) | `.chain/board-tier-flow/spec.md`, `docs/media/agents.png` ×2, `docs/media/tasks-board.png` ×2, `docs/release/v0.2.0-release-notes.md` |
| `905baf3` (fixed) | `docs/media/agents.png` ×2, `docs/media/tasks-board.png` ×2, `docs/release/v0.2.0-release-notes.md` |

Zero `.chain` paths are blockers at the fixed head. The three that remain are the
pre-existing ones the adjudication placed outside this range — and `origin/main`
already classifies them in `2b64c33`.

## Regressions rerun at the fixed head

Clean bootstrap (`npm install`, `npm run db:generate`, `npm run build -w @agentos/db`),
throwaway PostgreSQL in Docker, private `RUNNER_WORKSPACE_ROOT` /
`CONTROL_PLANE_STATE_DIR` / `FILES_ROOT` under `mktemp -d`.

| Suite | Result |
| --- | --- |
| `npm run typecheck` | exit 0, all workspaces |
| `npm run lint` (biome + eslint) | exit 0, 375 files |
| `npm run test -w @agentos/db` | 191 tests, 191 pass, 0 fail |
| `npm run test -w @agentos/api` | 409 tests, 408 pass, 1 skipped, 0 fail |
| `npm run build -w @agentos/web` | ok |
| `npm run test -w @agentos/web` | 368 tests, 368 pass, 0 fail |
| `packages/db/src/*.dbtest.ts` (via the shared runner) | 67 tests, 64 pass, 3 fail — all `preflight-goal-execution` |
| `packages/api/src/*.dbtest.ts` (full suite) | 323 tests, 322 pass, 1 fail — `preflight-goal-execution` |
| `node scripts/public-snapshot-scan.mjs` | exit 1, 5 blockers, all pre-existing, zero `.chain` |
| `bash scripts/merge-gate.sh --expect-head 905baf3…` | **MERGE GATE: FAIL (database preflight tests)** |

Merge-gate stages that passed before the failing one: frozen records append-only,
frozen-record checker fixtures, npm ci, release documentation executable
contract, templates release-demo harness, prisma generate, typecheck, lint,
build, migrate the gate schema, unit tests. The gate stops at
`database preflight tests`, so it never reached its own `api database tests`
step — that suite was therefore run separately, under the gate's exact
environment (same image, same fixture credential, same scratch-database and
private-root settings), which is where the 322/323 above comes from.

Baseline deltas against the brief's declared numbers:

- unit db **191**, not the brief's 192. No file under `packages/db` other than
  `src/workflow.ts` is touched anywhere in `45584af..905baf3`, and no db test
  file is touched at all, so the brief's figure is stale rather than regressed.
- unit api **409** (408 + 1 skipped), not 406 — the range adds tests.
- dbtest db **64/67** and api **322/323**, not 67/67 and 320/320 — see below.

## The four dbtest failures are branch staleness, demonstrated

All four are the same assertion in `preflight-goal-execution.dbtest.ts`
(one copy in `packages/db`, one in `packages/api`):

```
STOP preflight authority: the attestation records master 8d69ee85…, not the declared 29aac967…
STOP preflight authority: the recorded master 29aac967… is not an ancestor of the attested commit 14d50bd0…
```

Neither file, nor `release-authority.json`, is modified anywhere in
`45584af..905baf3`. `origin/main` carries
`ac0e6f7 test: declare the re-identified recorded master in preflight dbtests`,
which sets `MASTER_SHA` to the attested `8d69ee85…`; that commit is a descendant
of this branch's base `45584af`, so the branch was cut immediately before it.

Demonstrated, not asserted: at the fixed head, with only those two dbtest files
replaced by their `origin/main` versions, the preflight suites run
**28 tests, 28 pass, 0 fail**. The working tree was restored to `905baf3`
afterwards and re-verified clean.

`git merge-tree --write-tree origin/main 905baf3` succeeds — the branch merges
into `origin/main` without conflict, including the two `public-snapshot.json`
edits (this branch adds an `exclude` entry; `2b64c33` adds `include` and
`approvedFindings` entries).

Consequence for the human: no `MERGE GATE: PASS` is claimed at `905baf3`, and
none is obtainable at that exact head. Bringing the branch up to `origin/main`
clears both the preflight failures (`ac0e6f7`) and the three residual snapshot
blockers (`2b64c33`). That is an integration decision, not a fix-phase defect —
nothing in the delivered diff causes it.

## Newly observed, non-blocking (P2)

Neither is a P0/P1, so by the adjudication's own rule they are recorded and do
not return the chain to the fix phase.

- **RV-01** — a **single-step** template instantiated with `autoStart: true` now
  resolves `run.branch = null` where it previously got `branchName`: step ①'s
  `targetBranch` is the repository default, and with no step ② there is no
  sibling to recover the head from, so the runner falls back to
  `agentos/<taskId>/run-1` (`packages/runner/src/workspace.ts:159-160`). Not
  reachable today — no API route creates templates; the only two in the
  repository have ten steps (`packages/db/prisma/seed.ts`) and two
  (`packages/api/src/merge-integrator-fixture.ts`). Related: step ①'s head is now
  derived from a sibling's mutable `targetBranch`, which `PATCH /tasks/:id`
  accepts as nullable (`packages/api/src/app.ts:278`), so an operator who blanks
  or repoints step ②'s target before step ① starts can move step ①'s head. A
  head persisted at instantiation on the chain, rather than inferred from a
  sibling row, would close both.
- **RV-02** — the interaction test only ever runs the 409 variant:
  `withStartFlow`'s `startStatus = 201` default is never used, so the successful
  `confirm` path (`setRequest(null)` then `reload()`) is uncovered. And the
  MFX-02 wiring — menu → `move`, drop → `drop` — is asserted through the pure
  `moveAction` predicate rather than through `TasksPage`, so a future re-cross of
  the two callbacks would not be caught by a test. REC-08 also stands: `origin`
  and `status` are both literals at `moveAction`'s only production call site
  (`Tasks.tsx:123`), which leaves two of its three parameters dead there.

## Verdict

Every must-fix ID is accounted for and closed. Each defect is verified shut
against the code and, where the defect was behavioural, against an executed test.
The fix preserves the specification — the deferred-start rule of §1, the
drop-only confirmation and verbatim error surfacing of §2, and the shared
server-side predicate of §3 are all still satisfied — and the combined fixes
introduce no regression in any suite that was green before them.

`905baf34266126d74ecada589211323d17294e13` is the only head eligible for human
review.
