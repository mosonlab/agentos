# Post-fix regression verification — board tier-flow wiring

Verdict: **PASS**, with `MERGE GATE: PASS` at the gated head.

This supersedes the first verification pass. That pass judged a head
(`905baf34266126d74ecada589211323d17294e13`) that no longer exists: the branch
was rebased onto `origin/main` afterwards, which rewrote every commit in it.
The findings below are re-established against commits that resolve in the tree.

## Range and identities

Recorded in `sessions.md` as `implementation_range` were `45584af…` (base) and
`e387cac…` (head). `45584af…` still resolves and is still an ancestor; `e387cac…`,
`0befc62…` and `905baf3…` do not resolve, because `board-tier-flow` was rebased
onto `origin/main`. The equivalent commits in this tree, by content and message:

| Role | Recorded | In this tree |
| --- | --- | --- |
| implementation base | `45584af215b1e727316caf63e900d765d727aa91` | `2b64c33be4fa82226cc604a09cb210190cd8a4fa` (`origin/main`) |
| implementation head | `e387cac448854d0b033fada65e38024ed5e46099` | `6b1a270e48613f4382c5caff6d97777272f5cf24` `feat: add confirmed board task starts` |
| pre-fix head (incl. chain records) | `0befc629e355066c0e3128aeaacaa27e2324ece8` | `6c8d9c48c2af4186dafcfd98640bd696973d38f2` |
| fixed head | `905baf34266126d74ecada589211323d17294e13` | `6fbb6dcf1573a93a20cf77ed6cce0c643d791d6b` `fix: preserve deferred board task starts` |

- delivered head gated: `a3216c75bbcf3bd1c04dc71609ff148b696a565e`
- fix diff reviewed as one unit: `6c8d9c4..6fbb6dc` — 8 files, +236 / −57
  (`apps/web/src/pages/Tasks.tsx`, `apps/web/src/tests/tasks-board.test.tsx`,
  `packages/api/src/chain-branch.dbtest.ts`, `packages/api/src/templates.test.ts`,
  `packages/api/src/templates.ts`, `packages/api/src/workflow.test.ts`,
  `packages/db/src/workflow.ts`, `public-snapshot.json`) — byte-identical in
  file set and line counts to what the first pass reviewed, so the rebase carried
  the fix across unchanged.
- delivered range `2b64c33..a3216c7`: 31 files, +1597 / −67.
- must-fix authority: `.chain/board-tier-flow/reviews/adjudication.md`.
- specification: `.chain/board-tier-flow/spec.md`, byte-identical to its state at
  the implementation commit. No `slices/` — direct chain, the spec is the sole
  authority, and everything the chain carries is reachable at the gated head.
- forbidden files `packages/db/src/merge-integrator.ts` and
  `packages/db/src/agent-contract.ts` are unchanged across `2b64c33..a3216c7`.

The rebase is what closed the two staleness causes the first pass reported and
could not clear from the branch: `ac0e6f7 test: declare the re-identified
recorded master in preflight dbtests` and `2b64c33 chore(snapshot): register the
v0.2.0 README screenshots and release notes` are now both ancestors.

## Must-fix account — all four closed

### MFX-01 — P0 — `autoStart: false` stranded the chain branch — CLOSED

`packages/api/src/templates.ts:172-174` no longer overwrites the first Run's
`branch` after `enqueueTaskRun`; the head is derived inside `resolveRunBranches`
by `templateChainBranch` (`packages/db/src/workflow.ts:238-254`, used at `:356`).
Step ①, whose `targetBranch` is deliberately `repo.defaultBranch`
(`templates.ts:164`), recovers the shared head from the lowest-`chainIndex`
sibling of the same chain and template whose `targetBranch` is not the repository
default; steps ②..n short-circuit on their own `targetBranch` and issue no extra
query. Immediate and deferred first starts now go through one resolver, and the
head no longer depends on a Run existing at instantiation time.

Verified by execution inside the authoritative gate, not by reading:

- `T6b: a deferred template start preserves its custom head and successor base`
  (`packages/api/src/chain-branch.dbtest.ts:355`) — PASS. Instantiates with
  `autoStart: false` and `branchName: custom/deferred`, asserts zero Runs, starts
  step ① through `POST /tasks/:id/start`, asserts `run.branch === "custom/deferred"`
  and `run.targetBranch === repo.defaultBranch`, publishes, completes, then
  asserts the successor's `branch` and `targetBranch` are both `custom/deferred`.
  That is exactly the head/base continuity MFX-01 required.
- `T6: a template chain still uses agentos/<chainId>, and a branchName override
  still wins` — PASS, so the `autoStart: true` path is unregressed.
- `a deferred template first run recovers its shared head from a later step`
  (`packages/api/src/workflow.test.ts:598`) — PASS at the resolver's unit level.

`branchName` defaults to `agentos/<chainId>` (`templates.ts:108`), which is never
the repository default, so the sibling predicate finds a head on every chain any
product path can create.

### MFX-02 — P1 — start confirmation hijacked the card menu — CLOSED

`dropAction(status, startable)` became `moveAction(origin, status, startable)`
(`apps/web/src/pages/Tasks.tsx:51-53`), and the page now has two callbacks:
`move` (`:248-258`), the unchanged plain PATCH, and `drop` (`:260-269`), which
consults startability only for `DOING`. Wiring re-verified at the gated head:

- `actions.onMove` → `move` (`Tasks.tsx:308`); `actions` is what `TaskCard`'s
  `Move to →` menu invokes (`task-card.tsx:136`) and what `MobileTaskList`
  renders every card with (`Tasks.tsx:374`). Menu and mobile are PATCH-only.
- `DesktopBoard.onMove` → `drop` (`Tasks.tsx:372`), and `DesktopBoard` consumes
  that prop at exactly one site — `onDrop` (`desktop-board.tsx:341`) — so the
  confirmed-start path is reachable only from a desktop drop.
- `only a startable desktop drop onto Doing asks for start confirmation` — PASS;
  it asserts `moveAction("menu", status, true) === "patch"` for every column.

### MFX-03 — P1 — a failed confirmed start rendered its error behind the modal — CLOSED

The flow is `useTaskStartConfirmation` (`Tasks.tsx:112-155`), and
`StartTaskDialog` takes `error` and renders `<ErrorNotice message={error} />`
inside the `Modal` (`:84-110`). `confirm` no longer clears `request` on failure,
so the message lands in the active, non-inert surface; the page-level
`{startError && <ErrorNotice/>}` is deleted. `requestForDrop` calls
`setError(null)` before opening and `cancel` clears both, which closes the stale
cross-card error folded in from OP-8.

- `drop confirmation decline is inert and a failed POST stays visible in its
  active surface` (`apps/web/src/tests/tasks-board.test.tsx:150`) — PASS. It
  drives the real hook through jsdom: confirmation opens; Cancel issues neither
  POST nor PATCH; Start issues exactly one `POST /api/tasks/t1/start` and zero
  `PATCH /api/tasks/t1`; and after a 409 the server's own sentence
  `Run budget was exhausted by another operator.` is inside `[data-confirmation]`.

### MFX-04 — P1 — the tracked chain specification was unclassified — CLOSED

`public-snapshot.json` gains a directory-level `.chain/**` exclusion with a
reason — the directory level the adjudication required, not a per-file entry.
`later-release-follow-up` is the only disposition the manifest validator accepts
for a non-blocker exclusion (`scripts/public-snapshot-scan.mjs:111-115`).

Verified differentially, base against head:

| tree | `snapshot-scope` blockers |
| --- | --- |
| `2b64c33` (base, scanned in a detached worktree) | 18, all `agents/templates/**` |
| `a3216c7` (gated head) | the same 18, all `agents/templates/**` |

Zero `.chain/` paths are blockers at the head. The 18 that remain are present at
the base unchanged — they arrive with `origin/main`'s markdown-sourced template
commits and are outside this range. The three blockers the first pass reported
(`docs/media/agents.png`, `docs/media/tasks-board.png`,
`docs/release/v0.2.0-release-notes.md`) are gone: `2b64c33` classifies them.

## Regressions rerun at the gated head

`bash scripts/merge-gate.sh --expect-head a3216c75bbcf3bd1c04dc71609ff148b696a565e`
— the gate owns its own throwaway PostgreSQL container and replaces every host
path the suites could default to with a fresh `mktemp` directory.

```
ok  frozen records append-only                     0s
ok  frozen-record checker fixtures                 4s
ok  npm ci                                        15s
ok  release documentation executable contract      1s
ok  templates release-demo harness                 0s
ok  prisma generate                                1s
ok  typecheck (all workspaces)                    15s
ok  lint (biome + type-aware no-floating-promises) 23s
ok  build (all workspaces)                        26s
ok  migrate the gate schema                        1s
ok  unit tests (all workspaces)                   39s
ok  database preflight tests                      62s
ok  api database tests                            58s
ok  verify the gated commit did not drift          0s

MERGE GATE: PASS a3216c75bbcf3bd1c04dc71609ff148b696a565e
```

Per-suite counts inside that run:

| Suite | Result |
| --- | ---: |
| unit `@agentos/api` | 409 tests, 408 pass, 1 skipped, 0 fail |
| unit `@agentos/db` | 197 tests, 197 pass, 0 fail |
| unit `@agentos/web` | 368 tests, 368 pass, 0 fail |
| unit `@agentos/runner` | 152 pass, 0 fail |
| unit `@agentos/merge-executor` | 70 tests, 69 pass, 1 skipped, 0 fail |
| unit `@agentos/github-client` / `build-info` / `inbox` | 29 / 26 / 5 pass, 0 fail |
| `packages/db` dbtests | 67 tests, 67 pass, 0 fail |
| `packages/api` dbtests | 330 tests, 330 pass, 0 fail |
| `node scripts/public-snapshot-scan.mjs` | exit 1, 18 blockers, all present at base |

Against the brief's declared baselines:

- dbtest db **67/67** and api **330/330** — the db baseline is met exactly and the
  api suite has grown past its 320 baseline with nothing failing. The four
  `preflight-goal-execution` failures the earlier passes reported are gone; they
  were branch staleness and the rebase carried in the fix (`ac0e6f7`).
- unit db **197** and api **409**, above the brief's 192 and 406. No file under
  `packages/db` other than `src/workflow.ts` is touched in this range and no db
  test file is touched at all, so the db delta arrives with `origin/main`; the api
  delta is this range's own added tests.

The snapshot scan is not a gate stage; it is reported here because MFX-04 turns
on it, and it is non-zero at the base for reasons this range does not cause.

## Newly observed, non-blocking (P2)

Neither is a P0 or P1, so by the adjudication's own rule they are recorded and do
not return the chain to the fix phase.

- **RV-01** — a **single-step** template instantiated with `autoStart: true` now
  resolves `run.branch = null` where it previously received `branchName`: step ①'s
  `targetBranch` is the repository default and there is no sibling to recover the
  head from, so the runner falls back to `agentos/<taskId>/run-1`
  (`packages/runner/src/workspace.ts:159-160`). Not reachable today — no route
  creates a template, and both templates the repository seeds from
  `agents/templates/` have twelve and six steps. Related: step ①'s head is now
  derived from a sibling's mutable `targetBranch`, and `taskPatch`
  (`packages/api/src/app.ts:318`, field at `:278`) accepts `targetBranch` as
  nullable, so an operator who blanks every later step's target before step ①
  starts moves step ①'s head. Persisting the head on the chain at instantiation,
  rather than inferring it from a sibling row, would close both.
- **RV-02** — `withStartFlow`'s `startStatus = 201` default is never exercised, so
  the successful `confirm` path (`setRequest(null)` then `reload()`) is uncovered,
  and the MFX-02 wiring is asserted through the pure `moveAction` predicate rather
  than through `TasksPage`, so a future re-cross of `move` and `drop` would not be
  caught. REC-08 also stands: `origin` and `status` are both literals at
  `moveAction`'s only production call site.

## Verdict

Every must-fix ID is accounted for and closed. Each defect is verified shut
against the code and, where the defect was behavioural, against a test that
executed green inside the authoritative gate. The fix preserves the
specification — §1's deferred-start rule, §2's drop-only confirmation and
verbatim error surfacing, and §3's shared server-side predicate are all still
satisfied — and the combined fixes introduce no regression in any suite.

`a3216c75bbcf3bd1c04dc71609ff148b696a565e` carries a `MERGE GATE: PASS`. The
head this record is committed at is the head eligible for human review; its only
difference from the gated commit is this file and `sessions.md`, and the
re-gate at that exact head is recorded in the task output.
