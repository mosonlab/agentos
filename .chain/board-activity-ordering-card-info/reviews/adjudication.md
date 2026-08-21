# Adjudication — board activity ordering and card info

Closed. Every finding from both reports carries a disposition below. No open-ended
review instruction remains.

## Authority

- implementation base: `00b94f9861861d19c5bdc78b57cb5949d82bd730`
- delivered head: `e4bc4f05b987a0d44c8761727175cf08a48b425f`
- verification: both resolve, base is an ancestor of head, `spec.md` is reachable
  at head, no `slices/` (direct chain, so `spec.md` is the whole authority)
- report A (first reviewer): `.chain/board-activity-ordering-card-info/reviews/sol-findings.md`,
  coordinator run `cmt2fud9q073tmp45y82mixoc`, harness `gpt-5.6-sol` at `high`
  reasoning, two axes run as separate sessions
  (`01a0228d-6992-7932-a729-117c6a8bc1c4` standards,
  `01a0228d-69a8-78b3-b178-f58932ee6998` specification)
- report B (blind, this coordinator): `.chain/board-activity-ordering-card-info/reviews/opus-blind-findings.md`,
  committed as `7ed6749` **before** `sol-findings.md` was opened; run
  `cmt2gd12x08vkmp45aocvq44u`, Opus 5

## Merge matrix applied

19 raw findings (10 B, 9 A) → 16 after three same-defect merges. No finding was
identified by one report and explicitly rejected with evidence by the other, so
no contradiction was escalated to Inbox.

| Rule | Applied to |
| --- | --- |
| Reported by both, adopted at the higher severity | MF-2, MF-4, P2-1 |
| Independent (B) finding retained by default | MF-5, P2-6…P2-11 |
| A-only, entered after verification against code and authority | MF-1, MF-3, P2-2, P2-3, P2-4, P2-5 |

Every A-only finding was verified against the tree at head before adoption; the
verification is recorded inline with each one.

## Must-fix (P0/P1)

No P0.

### MF-1 — P1 — Archive All confirms the filtered scope and mutates the project scope

- Source: A `SOL-SPEC-001` (A-only, verified). B did not find it.
- Location: `apps/web/src/pages/Tasks.tsx:184`, `:246-247`, `:338-345`;
  `packages/api/src/app.ts:3038-3043`
- Governing specification: "Out of scope: ... archive behavior."
- Verified: `tasks` is now the chain-filtered list (`:184`); `latest.current = tasks`
  (`:247`); `archiveDone` builds `done` from `latest.current` and confirms with
  `t("tasks.confirm.archiveDone", { n: done.length })` (`:339-340`), then posts to
  `/projects/:projectId/tasks/archive-done` (`:344`), whose selection is
  `{ projectId, status: DONE, archivedAt: null }` — the entire project
  (`app.ts:3041-3043`). With a chain filter active and one visible Done card, the
  operator approves "Archive 1 done tasks?" and every unarchived Done task in the
  project is archived. Before this diff `tasks` was unfiltered, so the two scopes
  agreed; the diff introduces the divergence, which is a change to archive
  behaviour the specification placed out of scope.
- Required fix: make the confirmed scope and the mutated scope the same. Either
  count the unfiltered project-wide Done set for the confirmation and say so in
  the prompt, or send explicit task ids / a chain scope to an endpoint that
  honours them. Add an interaction regression with visible and hidden Done tasks
  asserting the confirmation count equals what is archived.

### MF-2 — P1 — The running-elapsed duration is painted once and then frozen

- Source: both. A `SOL-SPEC-002` (P1), B `O-2` (P1). Adopted at P1.
- Location: `apps/web/src/components/task-card.tsx:130-137`, `:228-236`;
  `apps/web/src/pages/Tasks.tsx:68-95`; `apps/web/src/lib/hooks.ts:91-99`
- Governing specification: "a card whose latest run is running shows elapsed time
  since that run's start (e.g. \"running 12m\")", and "never fabricate a
  duration - if a run lacks the timestamps a rendering needs, omit that rendering
  rather than showing a wrong value".
- Both reports reach the same mechanism: `cardTime` resolves `Date.now()` inside
  render (`format.ts:75`), which the memo cannot see. `usePoll` drops an unchanged
  response, `stableRows` preserves the previous row object for an unchanged
  serialization, and `TaskCard` is `memo(TaskCardBody)` under the invariant stated
  at `task-card.tsx:228-235`. B adds the reason nothing ever changes during a run:
  `Task.updatedAt` is not written by run heartbeats or event batches,
  `latestRun.status` stays `RUNNING`, `startedAt`/`endedAt` are fixed, and
  `Session.costUsd` is only recomputed on `FINAL_OUTPUT`
  (`packages/api/src/app.ts:3696-3698`). So the card can display its first-paint
  elapsed value for the whole run — a wrong duration, which is the case the
  constraint names.
- Required fix: drive the displayed value from something the memo compares — a
  bounded clock tick owned by `TasksPage`, or a minute-bucketed `now` passed as a
  prop — without waking cards that have no running run. Add a fake-timer test that
  mounts the card, leaves its props otherwise unchanged, advances the clock, and
  asserts the rendered duration advanced.

### MF-3 — P1 — API-created chains never lose their shared title prefix

- Source: A `SOL-SPEC-003` (A-only, verified). B's report explicitly reasoned only
  about template-instantiated chains and did not consider this route, so this is a
  gap in B, not a rejection; no contradiction arises.
- Location: `packages/api/src/board.ts:92-100`;
  `apps/web/src/components/task-card.tsx:126-130`
- Governing specification: "a chained card's title renders without the chain-name
  prefix shared by the chain's tasks; the stored task name is unchanged (display
  only)." Unqualified — it governs every chained card, not only template ones.
- Verified: `taskInput` accepts `chainId` and `chainIndex` as a supported pair,
  with a `superRefine` requiring them together (`packages/api/src/app.ts:311-317`).
  The create route's own comment says "API-created chains arrive one task at a
  time" (`:2296`) and "This route cannot set `templateStepId` at all" (`:2282`).
  `taskChainName` returns null whenever `templateStep` is null
  (`board.ts:96`), so for this supported chain kind `chainName` is null, `cardTitle`
  returns the stored name unchanged, and the badge degrades to
  `chainId.slice(0, 8)`. Spec §Changes 4 and 5 are both unmet for it.
- Required fix: derive one verified shared display prefix per chain from the rows
  the response already returns — a prefix is only removable if every task of that
  chain in the response carries it — rather than from `templateStep` alone. Stored
  names stay unchanged. Add an API test and a card test for a non-template chain
  with a shared prefix. This fix also closes P2-8 and largely closes P2-11.

### MF-4 — P1 — `enrich=false` no longer stops the caller paying for the board's extra queries

- Source: both. A `SOL-STD-001` (P2), B `O-1` (P1). **Same defect reported by
  both → adopted at the higher severity, P1.**
- Location: `packages/api/src/app.ts:2089-2109`, called unconditionally at `:2211`
  and `:2230`; `apps/web/src/pages/Projects.tsx:72-83`, `:140`
- The documented standard is stated in the same function at `:2111-2125`:
  "`chainProgress` / `recurringLastFiredAt` / `position` cost two extra queries
  over the whole task table, and `Projects.tsx` polls this endpoint globally every
  2.5 s purely to count tasks per project — it renders none of them.
  `?enrich=false` lets that caller stop paying for it." `chainProgressLookup`
  (`:2165`) and the recurring `groupBy` (`:2236`) are both gated on `enrich`;
  `latestRunActivity` is not.
- B's escalation to P1, which this adjudication adopts: the ungated query is the
  most expensive of the three, not a peer of them. It reads **every** historical
  `Run` of every task in scope, and per run runs a nested `take: 1` over
  `SessionEvent` — the highest-volume table in the schema, written in batches by
  the runner event ingest (`app.ts:3685`). Prisma implements a nested relation
  `take` as a window function over the whole restricted partition set, so
  `@@index([runId, at])` (`schema.prisma:902`) is not reduced to one indexed
  lookup per run. The worst case is the unfiltered global poll: every run of every
  task in the installation, every 2.5 seconds, growing without bound as run
  history accumulates. A documented cost opt-out that silently stops opting out is
  a must-fix, not a note.
- Required fix: (a) gate `latestRunActivity` on `enrich`, letting the `orderBy`
  the query already requests stand as the order for a caller that renders no rows
  — which also makes P2-6 moot; and (b) compute the maximum in the database, e.g.
  `db.sessionEvent.groupBy({ by: ["runId"], where: { runId: { in } }, _max: { at: true } })`
  or an equivalent single aggregate keyed to task, instead of materialising every
  historical run row and reducing in application memory. The board and full-view
  ordering contract must be preserved.

### MF-5 — P1 — The model spec re-opens the documented assignee-truncation regression and has no reveal of its own

- Source: B `O-3`. Retained by default; A did not report it and did not reject it.
- Location: `apps/web/src/components/task-card.tsx:219`, against `:45` (`TASK_FOOT`)
  and `apps/web/src/tests/tasks-board.test.tsx:296-302`
- Governing specification: "agent-assigned cards show the assignee agent's model
  string (e.g. \"gpt-5.6-sol:medium\") with the assignee."
- The new element is a bare `<span className="truncate …">` added inside the one
  shrinkable group of `TASK_FOOT`, a single flex row whose other members
  (`money`, `cardTime`) are `whitespace-nowrap`. It has no `title` and no
  disclosure. The repository's recorded position on exactly this row is at
  `tasks-board.test.tsx:296-299`: "59 of 112 cards truncated this name with no
  reveal at all: `title` is a hover affordance, which is none on touch and none
  from the keyboard" — which is why `Assignee` is a keyboard-reachable disclosure
  button. The change puts a second string into the same 170px content box (the
  measurement is recorded at `:30-31`), shortens the assignee further, and gives
  the new string strictly less affordance than the one whose truncation was
  already judged unacceptable. With a cost present and the time cell grown to
  `8m 0s · 3h ago`, the assignee-plus-model group is left roughly 30-40px.
- Required fix: give the model its own `TASK_META` row — the meta grid is
  `minmax(0,1fr)` and already bounded — or route it through the same `Assignee`
  disclosure so it inherits the keyboard-reachable reveal. `title` alone is the
  affordance this row already rejected. Add a rendering assertion that the model
  is reachable without hover.

## Recorded, non-blocking (P2)

These do not block the fix phase. Fixing any of them is at the implementer's
discretion; none may be treated as an open review question.

- **P2-1** — Filter acceptance test never exercises activation or clearing.
  Both reports (A `SOL-SPEC-004`, B `O-8`), both P2 → P2.
  `apps/web/src/tests/tasks-board.test.tsx:206-221`. The test calls `tasksForChain`
  directly and renders `ChainFilterControl` with `onClear={noop}`; nothing clicks
  the real badge or asserts `event.stopPropagation()` stops the card's navigate.
  Direction: mount the board with two chains, click the real badge, assert the
  other chain disappears and no navigation occurred, click the real clear control,
  assert it reappears.
- **P2-2** — Ordering acceptance test covers two of five columns. A
  `SOL-SPEC-005`, verified: `packages/api/src/app.test.ts:1486-1501` supplies only
  DONE and TODO rows. Direction: reverse-activity pairs for all five statuses. The
  report's second half (fixtures carry no `createdAt`) is accepted as
  acceptance-text fidelity only — the sort no longer reads `createdAt` at all.
- **P2-3** — Missing-timestamp evidence covers only the both-null case. A
  `SOL-SPEC-006`, verified: `apps/web/src/tests/tasks-board.test.tsx:224-235`.
  Direction: separately cover terminal start-only, terminal end-only, and
  RUNNING-without-start, each asserting time-ago with no duration.
- **P2-4** — `step i/N` bypasses the locale dictionaries. A `SOL-STD-002`,
  verified: `apps/web/src/lib/chain.ts:19-25` hard-codes the English word `step`
  while the same change added four keys to both `en.ts` and `zh.ts`. The
  pre-existing `chainMarker` formats only data, so this is the first English
  string in the file. Direction: a `tasks.card.chainStep` template, or return the
  position data and format it through `t` in the component.
- **P2-5** — De-duplicated titles strip chain context from the link's accessible
  name. A `SOL-STD-003`, verified: `task-card.tsx:172-177`; the comment at
  `:173-175` records that the link is what gives the card its accessible name,
  and the badge button does not participate in it. Repeated `Review` links across
  chains become indistinguishable. Direction: keep the short visual title and give
  the link the full stored name via `aria-label` or visually hidden context.
- **P2-6** — The `orderBy` change is inert. B `O-4`, retained.
  `packages/api/src/app.ts:2087`: `{ createdAt: "asc" }` became
  `[{ updatedAt: "desc" }, { id: "asc" }]`, but both result sets are fully
  re-sorted by a total comparator (`board.ts:105-110`) and neither query
  paginates, so nothing observable depends on it. Adopting MF-4's `enrich` gate
  makes it load-bearing and resolves this.
- **P2-7** — Unreachable fallback in the chain label. B `O-5`, retained.
  `task-card.tsx:163-164`, `:172`: `title={chainTitle ?? chainName}` cannot reach
  its right-hand side, since `chainName` is non-null exactly when `chainTitle` is.
  Direction: one derivation instead of two.
- **P2-8** — The chain-prefix contract is implemented three times.
  B `O-6`, retained. `packages/api/src/board.ts:92-100` strips the suffix,
  `task-card.tsx:126-130` strips the prefix back off, and
  `packages/api/src/templates.ts:154` owns the format both encode. Coupler /
  shotgun surgery. **Subsumed by MF-3's fix**, which puts the derivation in one
  place; no separate work is expected once MF-3 lands.
- **P2-9** — `duration()` has no hour unit. B `O-7`, retained.
  `apps/web/src/lib/format.ts:73-80` renders `Xm Ys` above a minute, so the card
  shows `running 240m 0s` at the default `maxDurationMin` of 240 and
  `8m 0s · 3h ago` against the spec's illustrations `running 12m` and
  `8m · 3h ago`. Not a correctness defect — the spec's strings are "e.g." and no
  timestamp is invented — but it is the change that pushes the footer over the
  width budget MF-5 describes. Direction: a compact card formatter; leave
  `duration()` alone for the detail page.
- **P2-10** — A just-retried task sinks to the bottom of its column. B `O-9`,
  retained. `app.ts:2091-2107` uses `max(SessionEvent.at)` and falls back to
  `updatedAt` only when the map has no entry at all, so a task whose fresh run is
  QUEUED with no events keeps its predecessor's stale timestamp. This conforms to
  the specification as written — "Last activity is the task's most recent run
  event timestamp when it has runs, otherwise the task's `updatedAt`" — and the
  code comments the choice deliberately, so it is recorded rather than must-fix.
  Direction if Leo wants the other reading: `max(latest event, latest run's queuedAt)`,
  not `max(…, updatedAt)`, which would collapse back to the proxy this change
  replaced.
- **P2-11** — Badge and filter banner disagree about the chain label. B `O-10`,
  retained. `task-card.tsx:163` renders `chainId.slice(0, 8)` while
  `Tasks.tsx:330` sets the banner name to the full `chainId`, so an 8-character
  badge produces a full-uuid banner. Largely closed by MF-3, which removes the
  fallback for the chain kind that triggers it; any residual fallback should be
  derived once and passed to both.

## Checked and cleared

Neither report found a defect here; recorded so the fix phase does not re-open them.

- `taskChainName`'s suffix rule matches template instantiation exactly
  (`packages/api/src/templates.ts:153-155` sets both `templateStepId` and the
  `"<chain>: <step>"` name). The gap is the API-created chain route only (MF-3).
- The no-runs constraint holds: `byLatestRunActivity` falls back to `updatedAt`
  with a total comparator, so such a task can neither crash nor drop out.
  Covered at `packages/api/src/board.test.ts:96-106`.
- `cardTime` omits rather than invents when a timestamp is missing. Covered for
  the both-null case; the one-sided cases are P2-3.
- `chainMarker` is not dead code — `Archived.tsx:38` and `Triggers.tsx:240` still
  use it, and the specification permits `chainProgress` to remain.
- Board `chainProgress` is never null for a chained card (`enrich` is forced true
  for `view=board` at `app.ts:2125`), so gating the badge on it is safe.
- `chainName` being board-only mirrors `mergeOutcome`, which is already board-only.

## Tooling at head

Fresh `npm install` on the delivered tree, `RUNNER_WORKSPACE_ROOT` at a scratch dir:

- `npm run build` — pass (covers `tsc -b` / `tsc -p` for every workspace)
- `npm run lint` (biome + eslint, 379 files) — pass
- `npm run test -w @agentos/api` — 411 pass, 0 fail, 1 skipped
- `npm run test -w @agentos/web` — 371 pass, 0 fail (`bundle-secrets` and `styles`
  need a built bundle; both pass after `npm run build`)
- `npm run test:db` — not run; no scratch PostgreSQL reachable from this
  workspace. The diff touches no `*.dbtest.ts`, so nothing in the range is
  covered only there. The implementation step's persisted output records the
  scratch-PostgreSQL suite as green at this head.

Acceptance 5 holds on every suite runnable here. No lint, type, or format failure
was observed, so none is reported.
