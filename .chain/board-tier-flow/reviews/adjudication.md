# Adjudicated review — board tier-flow wiring

Closed. Every finding from both reports has a disposition below; nothing here is
an open-ended instruction to review further.

## Range and identities

- implementation base: `45584af215b1e727316caf63e900d765d727aa91`
- delivered head: `e387cac448854d0b033fada65e38024ed5e46099` (one commit,
  `feat: add confirmed board task starts`)
- authority: `.chain/board-tier-flow/spec.md` at head. No `slices/` directory —
  direct chain, the spec is the sole authority.
- Report A (first reviewer): `.chain/board-tier-flow/reviews/sol-findings.md`,
  Sol / `codex exec review -m gpt-5.6-sol`, committed `3d3129f`.
  0 P0, 5 P1, 2 P2.
- Report B (blind, independent): `.chain/board-tier-flow/reviews/opus-blind-findings.md`,
  review-coordinator-opus, session `cmt28jgrp00pdmp4597991ziz`, committed `c06079f`
  **before** `sol-findings.md` was opened. 1 P0, 1 P1, 7 P2.
- Contradictions requiring a human ruling: **none**. Neither report explicitly
  rejects a defect the other reports.

## Merge matrix applied

| Final ID | Report A | Report B | Rule | Severity |
| --- | --- | --- | --- | --- |
| MFX-01 | SOL-SPEC-001 (P1) | OP-1 (P0) | both → higher severity | **P0** |
| MFX-02 | SOL-SPEC-003 (P1) | OP-2 (P1) | both → higher severity | **P1** |
| MFX-03 | SOL-SPEC-002 (P1) | — | A only → verified, adopted | **P1** |
| MFX-04 | SOL-STD-001 (P1) | — | A only → verified, adopted | **P1** |
| REC-01 | SOL-SPEC-004 (P1) | — | A only → verified, scope narrowed against a documented standard | P2 |
| REC-02 | SOL-STD-002 (P2) | — | A only → verified, adopted | P2 |
| REC-03 | SOL-SMELL-001 (P2) | — | A only → verified, adopted | P2 |
| REC-04 | — | OP-3 (P2) | B retained by default | P2 |
| REC-05 | — | OP-4 (P2) | B retained by default | P2 |
| REC-06 | — | OP-5 (P2) | B retained by default | P2 |
| REC-07 | — | OP-6 (P2) | B retained by default | P2 |
| REC-08 | — | OP-7 (P2) | B retained by default | P2 |
| REC-09 | — | OP-8 (P2) | B retained by default (stale-error half folded into MFX-03) | P2 |
| REC-10 | — | OP-9 (P2) | B retained by default | P2 |

## Must-fix (P0/P1) — the fix phase closes all four

### MFX-01 — P0 — `autoStart: false` strands the chain branch: step ① runs on the wrong head and step ② cannot clone

Sources: OP-1 (P0) and SOL-SPEC-001 (P1), same defect, adopted at P0.
Location: `packages/api/src/templates.ts:172-175`; consequence at
`packages/db/src/workflow.ts:336-346` and `packages/runner/src/workspace.ts:159-160`.

Governing spec (§1): "When false, all step tasks are created in TODO as today but
nothing is enqueued; the chain is started later by starting its first step via
POST /tasks/:id/start (which already handles chain steps)."

The `tx.run.update({ data: { branch: branchName } })` that the diff moved inside
the `autoStart` branch was the only place `branchName` was ever persisted. Step
①'s task deliberately carries `repo.defaultBranch` in `targetBranch`
(`templates.ts:167`); steps ②..n carry `branchName`. So on the deferred path
`resolveRunBranches` computes `chainBranch = null` and returns `branch: null`.
Executed against the built `@agentos/db` with step ① and step ② shaped exactly as
`instantiateTemplate` writes them:

```
step ① first run  : { branch: null,              targetBranch: 'main' }
step ② first run  : { branch: 'board-tier-flow', targetBranch: 'board-tier-flow' }
```

The runner then names step ①'s workspace branch `agentos/<taskId>/run-1` and
pushes there; step ② runs `git clone --branch <branchName>` against a ref nobody
created and fails, every retry alike. This is the default and only operator path:
`apps/web/src/components/new-task-panel.tsx:75` sends `autoStart: false` and the
zod default is `false` (`app.ts:501`).

No test catches it because `tasks.dbtest.ts:798` stops at `run.count === 0`, and
`chain-branch.dbtest.ts:330` (T6), which does assert
`firstRun.branch === agentos/<chainId>`, was moved onto `autoStart: true` rather
than duplicated onto the new default.

Required: make the chain head survive instantiation independently of a Run
existing at that moment — persist it and have the template arm of
`resolveRunBranches` read it — so step ①'s head is the chain branch whenever it
is enqueued, while its base stays the repository default. Add a dbtest that
instantiates with `autoStart: false` **and a custom `branchName`**, starts step ①
through `POST /tasks/:id/start`, asserts `run.branch === branchName` and
`run.targetBranch === repo.defaultBranch`, then advances to step ② and asserts
its base is the same branch.

### MFX-02 — P1 — the start confirmation hijacks the card menu's "Move to → Doing" on desktop and mobile

Sources: OP-2 (P1) and SOL-SPEC-003 (P1), same defect.
Location: `apps/web/src/pages/Tasks.tsx:204-219` (`move`), wired at `Tasks.tsx:282`
(menu, via `actions.onMove`) and `Tasks.tsx:346` (drop, via `DesktopBoard`);
menu built at `apps/web/src/components/task-card.tsx:133-137`.

Governing spec (§2): "Change ONLY the case \"card dropped onto the DOING column
AND the task is startable\" ... Every other drag ... keeps today's plain PATCH
behavior — explicitly out of scope to restrict them further."

The confirmation was placed in `move`, the single handler for the desktop drop,
the desktop card menu and the mobile card menu. `moveTargets`
(`apps/web/src/lib/board.ts:123-124`) offers "Doing" from every other column, so
picking it on a startable card now opens a start dialog instead of moving the
card. There is no longer any surface that can set a startable task to DOING by
hand, and on mobile — where there is no drag at all — the plain move is gone
outright while the menu label still says "Doing".

Required: separate the two entry points — keep `actions.onMove` on the plain
PATCH and give `DesktopBoard`'s `onDrop` a distinct confirmed-start path (or pass
an explicit interaction origin into `move`). Add interaction tests proving a
startable desktop drop opens confirmation while menu movement stays PATCH-only,
that decline performs no write, and that confirm performs `POST /tasks/:id/start`
with no `PATCH /tasks/:id`.

### MFX-03 — P1 — a failed confirmed start renders its error behind the open modal

Source: SOL-SPEC-002 (P1), first reviewer only. Verified independently against
the code before adoption.
Location: `apps/web/src/pages/Tasks.tsx:221-238` and `Tasks.tsx:309-322`.

Governing spec (§2): "Surface API errors to the user verbatim (fail loudly)."

Verification: the catch at `Tasks.tsx:231-233` sets `startError` and leaves
`startRequest` non-null, so `StartTaskDialog` keeps rendering
(`Tasks.tsx:309-316`) while the `ErrorNotice` renders in the page body
(`Tasks.tsx:322`). `Modal` (`apps/web/src/components/ui.tsx:574-595`) is a Radix
`Dialog`, and `DialogContent` mounts a `DialogOverlay` of
`fixed inset-0 z-50 bg-[color:var(--scrim)]` with the content also at `z-50`
(`apps/web/src/components/ui/dialog.tsx:31-53`). The notice is therefore scrimmed
and inside the region Radix marks inert while a modal dialog is open: the
operator sees a dialog that did nothing and no message at all.

Folded in from OP-8: `startError` is cleared on cancel and on the next confirm
but not when a new drag opens the dialog for a different card, so a stale message
from card A can also appear under card B's dialog.

Required: render the exact API message inside the active dialog (or close the
dialog before showing a page-level notice), and clear `startError` when a new
start request opens. Add an interaction test that rejects the POST with a named
409 and asserts the server's own sentence is visible in the active error surface.

### MFX-04 — P1 — the chain specification the diff tracks is unclassified for the public snapshot

Source: SOL-STD-001 (P1), first reviewer only. Verified independently.
Location: `.chain/board-tier-flow/spec.md`, added by `e387cac`.

Standard: `CONTRIBUTING.md:79-85` — "`public-snapshot.json` names what may be
published. Every tracked file must be classified: a file no rule reaches is a
scan failure, not a silent inclusion."

Verification: `node scripts/public-snapshot-scan.mjs` at the current tree reports
`.chain/board-tier-flow/spec.md` as a `snapshot-scope` blocker, reason "tracked
path is not explicitly included or excluded". The same scan run in a worktree at
base `45584af` reports only `docs/media/agents.png`,
`docs/media/tasks-board.png` and `docs/release/v0.2.0-release-notes.md` — so the
`.chain` blocker is introduced by this range. `public-snapshot.json` is unchanged
in the diff.

Two corrections to the finding as filed, both widening it:

1. The whole `.chain/` directory is unclassified, not just `spec.md`. The scan
   currently blocks on `spec.md`, `sessions.md`, `sol-findings.md` and
   `opus-blind-findings.md`, and the chain process adds another file at every
   step. Classifying `spec.md` alone leaves the scan failing tomorrow. Fix at the
   directory level.
2. `scripts/merge-gate.sh` does not run `snapshot:scan` (its "snapshot" logic is
   the gate's own build/dependency cache), and the scan already fails at base on
   three pre-existing paths. So this does not change any gate verdict; it is a
   documented-standard violation with a one-rule fix, which is why it stays P1
   rather than rising.

Required: add an explicit `.chain/` exclusion to `public-snapshot.json` with a
reason, rerun `node scripts/public-snapshot-scan.mjs`, and confirm no `.chain/`
path is reported. Do not touch the three pre-existing blockers — they are outside
this range.

## Recorded, not blocking (P2)

### REC-01 — SOL-SPEC-004 — the startability panel does not route its poll error through `fatal()`

Adopted, severity reduced from P1 to P2 against a documented repository standard.
Location: `apps/web/src/pages/TaskDetail.tsx:374-378`.

Sol's mechanism is correct: `usePoll` keeps the last good `data` and sets `error`
(`apps/web/src/lib/hooks.ts:94-103`), and the new branch tests `data` first, so a
later failure leaves a stale checklist with no notice.

But the framing "no silent fallbacks" is answered by the repo's own documented
position, `apps/web/src/lib/poll-state.ts:5-12`: "`usePoll` sets `error` but keeps
the last good `data`, which is right for a transient failure and wrong for a
deletion: a 404 is authoritative even when a prior poll succeeded." The same
sentence is repeated at `TaskDetail.tsx:265-268`. Sol's concrete scenario — a
revoked grant or a newly active run while the poll is failing — is exactly the
transient case the standard calls right, and the page's three existing polls
(`task`, `chain`, `output`) all behave the same way. A documented repository
standard overrides the smell baseline, so making this a must-fix would force a
change that contradicts it.

What survives: the new branch never calls `fatal()`, so an authoritative 404
(a control plane rolled back to a build without the route) is masked the same as
a blip. The whole-page `fatal(error, task)` guard at `TaskDetail.tsx:270` already
catches the deleted-task case first, which is why the reachable window is narrow.
Direction, if taken: route through `fatal(startability.error, startability.data)`
like the task poll, or render the checklist and the error together.

### REC-02 — SOL-STD-002 — the obsolete `startable` wrapper survives its callers

Adopted at P2 as filed. `packages/api/src/chain.ts:166-168`. Verified: a
repository-wide search finds `startable(` only in
`packages/api/src/chain.test.ts`; all three production call sites now use
`taskStartability` (`app.ts:2366`, `app.ts:2921`, and the `chainStartDecisions`
mapper at `app.ts:2428`). Direction: delete the wrapper and migrate the
assertions to `taskStartability(...).startable`.

### REC-03 — SOL-SMELL-001 — the start flow deepens the `TasksPage` long-method bloater

Adopted at P2 as filed, and labelled by its author as a judgement call.
`apps/web/src/pages/Tasks.tsx:121-123, 204-243`. Direction: extract a
`useTaskStartConfirmation` state machine with explicit `request`/`confirm`/
`cancel`/`error` states. Fixing MFX-02 and MFX-03 touches the same regions, so
the fix phase may take this direction if it is the cheaper way to close them —
it is not required on its own.

### REC-04 — OP-3 — `StartTaskDialog` throws from render

`apps/web/src/pages/Tasks.tsx:91-93`. No error boundary exists anywhere in
`apps/web/src`, so a throw there blanks the whole board rather than surfacing a
message. Currently unreachable: `startable: true` implies `repoId` and
`assigneeAgentId` are set, both relations are FK-backed, and
`Repo.defaultBranch` is `String @default("main")`
(`packages/db/prisma/schema.prisma:336`). Direction: render the page's existing
refusal copy instead of throwing, or drop the guard and let the types carry it.

### REC-05 — OP-4 — `taskStartability`'s archived-assignee test is redundant and reverses the null-relation case

`packages/api/src/chain.ts:151-155`. `row.assigneeAgent?.archivedAt !== undefined`
is implied by the `=== null` that follows it — dead. Together they also change
the replaced contract: `if (row.assigneeAgent?.archivedAt) return false` passed a
`StartableRow` whose `assigneeAgent` is `null`; the new expression fails it. No
caller hits that today. Direction: pick one and say which in a comment.

### REC-06 — OP-5 — the startability route re-derives `/start`'s fact-gathering

`packages/api/src/app.ts:2331-2381` against `app.ts:2852-2916`. The predicate is
genuinely shared, which is what spec §3 asked for; the grant lookup, run
aggregate and chain-prefix query are copied. A seventh precondition added to
`/start` will compile, pass its tests, and not reach the checklist. Direction:
extract `readStartabilityFacts(client, taskId)` and call it from both.

### REC-07 — OP-6 — the checklist reports `startable: true` for tasks `/start` refuses

`packages/api/src/chain.ts:135-158` against `packages/db/src/workflow.ts:430-440`.
`enqueueTaskRun` additionally refuses on `stopStateFor` (integrator stop) and
`assertIntegratorBinding`; neither is modelled. The dialog can open for such a
task and the POST answers 409 — surfaced verbatim, so it fails loudly. Not
charged to this diff: the pre-change `startable` had the same gap and already
drove the Start button, and spec §2 enumerates only the six checklist items plus
archived/status.

### REC-08 — OP-7 — `dropAction`'s status test is dead at its only call site

`apps/web/src/pages/Tasks.tsx:51-53` and `:207-213`, test at
`apps/web/src/tests/tasks-board.test.tsx:69-74`. `move` already gates on
`status === "DOING"`, so four of the five columns the test iterates are
unreachable. The guard in `move` is defensible on its own terms (it avoids a
round-trip on every non-Doing drop), so this is a shape question. Direction: let
`dropAction` own the whole decision, or inline it and test through `move`.

### REC-09 — OP-8 — `confirmStart` hand-rolls the machinery `useAction` already provides

`apps/web/src/pages/Tasks.tsx:221-238` against `apps/web/src/lib/hooks.ts:133-155`.
Every other action on the page goes through `useAction`, and the comment at
`Tasks.tsx:288-291` states the rule: "One error surface, one information
surface." The stale-error half of this finding is a must-fix under MFX-03; the
duplication itself is recorded only. Direction: reuse `useAction` and keep the
dialog open on `run(...) === false`, or say why it cannot.

### REC-10 — OP-9 — no test covers the drop → confirm → `POST /start` wiring

`apps/web/src/tests/tasks-board.test.tsx:69-74` tests the pure helper only. The
one behaviour spec §2 wrote in capitals — "Do NOT PATCH status" — is unasserted,
as is the decline no-op. Subsumed by MFX-02's required tests; recorded so it is
not lost if MFX-02 is closed some other way.

## Verification evidence at head `e387cac`

Run by this coordinator in a clean install (`npm ci`, `npm run db:generate`,
`npm run build -w @agentos/db`), with `RUNNER_WORKSPACE_ROOT` pointed at a
`mktemp -d`:

- `npm run typecheck` — exit 0
- `npm run lint` (biome + eslint) — exit 0, 375 files
- `npm run test -w @agentos/api` — 408 tests, 407 pass, 1 skipped, 0 fail
- `npm run test -w @agentos/db` — 191 tests, 191 pass, 0 fail
- `npm run test -w @agentos/web` — 362 tests, 360 pass, 2 fail; both
  (`bundle-secrets.test.ts`, `styles.test.tsx`) refuse to run without a prior
  `npm run build -w @agentos/web` and fail identically at base. Not a finding.
- `node scripts/public-snapshot-scan.mjs` — blocks on `.chain/…` (MFX-04); the
  same scan at base blocks only on three pre-existing paths.

Not run here, and therefore not claimed: the dbtest suites. This workspace has no
PostgreSQL and the repository's testing red lines forbid pointing them elsewhere.
The first reviewer ran `packages/api/src/tasks.dbtest.ts` against an ephemeral
database (60 passed) and reports that the implementation step itself recorded an
exact-head merge-gate failure in the database preflight before the API dbtests.
The declared dbtest baselines (db 67/67, api 320/320) are therefore **unverified**
and must be established during regression verification. MFX-01 predicts no dbtest
failure, because no dbtest exercises the path it breaks — closing MFX-01 requires
adding that test, not re-running the existing ones.

`git diff --check` is clean and the two forbidden files
(`packages/db/src/merge-integrator.ts`, `packages/db/src/agent-contract.ts`) are
unchanged in the range — independently confirmed.
