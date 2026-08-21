# Blind review — board activity ordering and card info (Opus)

Written and committed before opening `sol-findings.md`.

## Range

- base `00b94f9861861d19c5bdc78b57cb5949d82bd730`
- head `e4bc4f05b987a0d44c8761727175cf08a48b425f`
- both resolve; base is an ancestor of head; the single commit in the range is
  `e4bc4f0 feat(tasks): order board cards by activity`
- authority carried by the chain: `.chain/board-activity-ordering-card-info/spec.md`,
  added by `e4bc4f0` and reachable at head. No `slices/` — direct chain, so the
  brief in `spec.md` is the whole specification of record.

## Tooling observed at head (not re-derived per finding)

Run from a clean `npm install` at `1bee5a2` with the delivered tree, `RUNNER_WORKSPACE_ROOT`
pointed at a scratch dir:

- `npm run build` — pass (includes `tsc -b` / `tsc -p` for every workspace)
- `npm run lint` (biome + eslint, 379 files) — pass
- `npm run test -w @agentos/api` — 411 pass, 0 fail, 1 skipped
- `npm run test -w @agentos/web` — 371 pass, 0 fail (`bundle-secrets` and `styles`
  fail without a built bundle; both pass after `npm run build`)
- `npm run test:db` not run: no scratch PostgreSQL is reachable from this
  workspace. The diff touches no `*.dbtest.ts`, so nothing in the range is
  covered only there.

Acceptance 5 holds on the suites that can run here.

## Findings

### O-1 — P1 — `enrich=false` no longer stops the caller paying for the board's extra queries

`packages/api/src/app.ts:2089-2109`, called unconditionally at `:2211` and `:2230`.

`latestRunActivity` is invoked on every `GET /tasks`, both shapes, with no
`enrich` gate — unlike `chainProgressLookup` (`:2165`) and the recurring
`groupBy` (`:2236`), which are both gated.

The standard it breaks is documented in the same function, at `:2111-2125`:

> `chainProgress` / `recurringLastFiredAt` / `position` cost two extra queries
> over the whole task table, and `Projects.tsx` polls this endpoint globally
> every 2.5 s purely to count tasks per project — it renders none of them.
> `?enrich=false` lets that caller stop paying for it.

That caller is real and still there: `apps/web/src/pages/Projects.tsx:78`
(`/tasks?enrich=false`, global, unfiltered) and `:140`. Both now pay the new
query, and it is the most expensive of the three:

- it reads **every** `Run` of every task in scope, not the latest one, and
- per run it runs a nested `take: 1` over `SessionEvent` — the highest-volume
  table in the schema, written in batches by the runner event ingest
  (`packages/api/src/app.ts:3685 db.sessionEvent.createMany`), so a single long
  agent run contributes thousands of rows.

Prisma implements a nested relation `take` as a window function over the whole
restricted partition set, so `@@index([runId, at])`
(`packages/db/prisma/schema.prisma:902`) is not turned into one indexed lookup
per run. The unfiltered global poll is the worst case: every run of every task
in the installation, every 2.5 seconds.

Fix direction: (a) gate `latestRunActivity` on `enrich`, letting the `orderBy`
the query already asks for stand as the fallback order for a caller that renders
none of the rows; and (b) replace the per-run nested `take` with a single
aggregate — `db.sessionEvent.groupBy({ by: ["runId"], where: { runId: { in } }, _max: { at: true } })`
over the runs of the tasks in scope — so the index is used once rather than
per partition.

### O-2 — P1 — the running-elapsed duration is painted once and then frozen for the life of the run

`apps/web/src/components/task-card.tsx:130-133` (`cardTime`), against
`:236 export const TaskCard = memo(TaskCardBody)`.

Spec §Changes 3: *"a card whose latest run is running shows elapsed time since
that run's start (e.g. "running 12m")"*. Spec §Constraints: *"never fabricate a
duration - if a run lacks the timestamps a rendering needs, omit that rendering
rather than showing a wrong value"*.

`cardTime` reads the wall clock — `duration(run.startedAt, null)` resolves `to`
to `Date.now()` (`apps/web/src/lib/format.ts:75`). That is an input the memo
cannot see, and the card is memoized under an invariant the file states
explicitly at `:228-235`:

> A card re-renders only when its own row changed. … `TasksPage` keeps the
> previous object for a row whose serialization did not change, so an unchanged
> card's `task` prop keeps its identity across a poll and this comparison
> short-circuits.

`useStableRows` / `stableRows` (`apps/web/src/pages/Tasks.tsx:74-95`) enforce
exactly that, keyed on `JSON.stringify(row)`.

Nothing in the card's payload changes while a run runs:

- `Task.updatedAt` is `@updatedAt` on the *task* row; run heartbeats and event
  batches write `Run` and `SessionEvent`, not `Task`.
- `latestRun.status` stays `RUNNING`.
- `latestRun.costUsd` comes from `Session.costUsd`, which the ingest route
  recomputes on `FINAL_OUTPUT` (`packages/api/src/app.ts:3696-3698`) — i.e. at
  the end, not during.
- `startedAt` / `endedAt` are fixed for the run.

So the card renders `running 3m 0s` at first paint and still says `running 3m 0s`
four hours later. That is not an omitted duration, it is a wrong one, which is
the case the constraint names.

Fix direction: make the displayed value a function of props the memo compares.
Either lift a coarse tick into `TasksPage` (one `setInterval` at minute
granularity feeding a value threaded to the cards or supplied by context), or
pass a minute-bucketed `now` as a prop so the memo comparison changes exactly
when the rendered string must change. Whichever is chosen, it needs a test that
advances the clock and asserts the card's rendered elapsed value moved.

### O-3 — P1 — the model spec re-opens the truncation hole the assignee reveal was built to close, and has no reveal of its own

`apps/web/src/components/task-card.tsx:219`.

Spec §Changes 6: *"agent-assigned cards show the assignee agent's model string
(e.g. "gpt-5.6-sol:medium") with the assignee."*

The new element is `<span className="truncate text-[color:var(--faint)]">{task.assigneeAgent.model}</span>`,
added inside the one shrinkable group of `TASK_FOOT` — a single flex row
(`:45`) whose other members (`money`, `cardTime`) are `whitespace-nowrap`. It
carries no `title` and no disclosure.

The repository has a measured, documented position on precisely this, recorded
at `apps/web/src/tests/tasks-board.test.tsx:296-299`:

> 59 of 112 cards truncated this name with no reveal at all: `title` is a hover
> affordance, which is none on touch and none from the keyboard.

which is why `Assignee` is a keyboard-reachable disclosure button rather than a
`title`. The change puts a second competing string into that same 170px content
box (`:30-31` records the measurement) and gives it strictly less affordance
than the thing whose truncation was judged unacceptable. At 11.5px, once the
time cell grows to `8m 0s · 3h ago` (O-7) and a cost is present, the assignee +
model group is left roughly 30-40px: both strings become unreadable, and the
model has no way to be read at all.

Judgement call, named fix: give the model its own `TASK_META` row (the meta grid
is `minmax(0,1fr)` and already bounded), or route it through the same `Assignee`
disclosure so it inherits the keyboard-reachable reveal. `title={model}` alone
is the minimum and is explicitly the affordance the repository already rejected
for this row.

### O-4 — P2 — the `orderBy` change is inert and reads as if it were the ordering contract

`packages/api/src/app.ts:2087`.

`{ createdAt: "asc" }` became `[{ updatedAt: "desc" }, { id: "asc" }]`, but both
result sets are then fully re-sorted by `byLatestRunActivity`
(`packages/api/src/board.ts:105-110`), whose comparator is total: activity
descending with an `id.localeCompare` tie-break. Neither query paginates, so no
observable behaviour depends on the database order. A reader of `:2087` will
believe it does.

Dispensable / misleading change. Fix direction: revert it, or — better — make it
load-bearing by adopting O-1's `enrich` gate, at which point the new `orderBy`
becomes the genuine fallback ordering for un-enriched callers and should say so
in a comment.

### O-5 — P2 — two near-identical chain labels, one with an unreachable fallback

`apps/web/src/components/task-card.tsx:163-164`, used at `:172`.

```
const chainName = task.chainName ?? (task.chainId === null ? null : task.chainId.slice(0, 8));
const chainTitle = task.chainName ?? task.chainId;
…
title={chainTitle ?? chainName}
```

The `?? chainName` fallback cannot fire: `chainName` is non-null only when
`task.chainName` or `task.chainId` is non-null, which is exactly the condition
that makes `chainTitle` non-null. Two locals derived from the same two fields,
plus a branch that is unreachable by construction.

Dispensable. Fix direction: one derivation — `const chainLabel = task.chainName ?? task.chainId?.slice(0, 8) ?? null` —
and `title={task.chainName ?? task.chainId ?? undefined}` with no second
fallback.

### O-6 — P2 — the chain-name prefix contract is implemented twice, on both sides of the wire

`packages/api/src/board.ts:92-100` (`taskChainName`) strips `": " + templateStep.name`
off the task name to produce `chainName`; `apps/web/src/components/task-card.tsx:126-130`
(`cardTitle`) then strips `chainName + ": "` back off to produce the title. The
format both halves encode is owned by a third place —
`packages/api/src/templates.ts:154`, `` name: `${input.name ?? template.name}: ${step.name}` ``.

Three copies of one string contract across two packages. A change to
instantiation breaks the pair silently: `taskChainName` returns null, the badge
degrades to a cuid fragment, and titles keep their prefix, with every test still
green because both tests use synthetic names built to the old format.

Coupler / shotgun surgery. Judgement call, named fix: the API already holds the
answer — where `taskChainName` is non-null, `templateStep.name` *is* the
de-prefixed title. Emit the display title from `boardCard` next to `chainName`,
and let `cardTitle` collapse to reading it, so exactly one place knows the
format.

### O-7 — P2 — the card reuses a formatter with no hour unit, in the densest row on the board

`apps/web/src/lib/format.ts:73-80`, reached from `task-card.tsx:130-137`.

`duration()` renders `Xm Ys` above a minute and never rolls up to hours. On a
card that means `running 240m 0s` at the default `maxDurationMin` of 240
(`packages/db/prisma/schema.prisma`), and `8m 0s · 3h ago` where the spec's own
illustrations are `running 12m` and `8m · 3h ago`.

Not a correctness defect — the spec's strings are prefixed "e.g." and the
timestamps are real, so nothing is fabricated. But `duration()` was written for
the task detail page, which has room; the board footer does not (see O-3), and
this is the change that pushes it over.

Judgement call, named fix: a compact card formatter (`3h 12m`, `8m`, `42s` —
drop seconds above a minute) rather than reusing the detail page's `duration()`
verbatim. Leave `duration()` alone for the detail page.

### O-8 — P2 — acceptance 4's wiring is asserted at both ends and nowhere in the middle

`apps/web/src/tests/tasks-board.test.tsx:206-219`.

Acceptance 4: *"the chain badge filter shows only that chain's tasks and can be
cleared"*. The test proves `tasksForChain` filters, that `ChainFilterControl`
renders its two strings, and that the badge carries
`aria-label="Show only chain Release"`. It never exercises the connection:
that clicking the badge reaches `actions.onFilterChain`, that
`Tasks.tsx:329-331` is what turns that into `chainFilter`, or that
`event.stopPropagation()` (`task-card.tsx:171`) stops the click from also
firing the card's `onClick` navigate (`:170`).

Dropping the `stopPropagation` call, or misrouting `onFilterChain`, leaves every
test green while the badge navigates to the task instead of filtering.

Test-coverage gap. Fix direction: one DOM test (`installDom` is already
imported) that dispatches a click on `[aria-label^="Show only chain"]` and
asserts both that the handler fired and that the card's navigation did not.

### O-9 — P2 — a just-retried task sinks to the bottom of its column

`packages/api/src/app.ts:2091-2107` with `packages/api/src/board.ts:105-110`.

The activity map takes `max(SessionEvent.at)` across a task's runs, and
`byLatestRunActivity` falls back to `updatedAt` only when that map has **no**
entry. A task retried seconds ago has a fresh QUEUED run with no events yet, so
its predecessor's hours-old last event still decides its place — and it sorts
below tasks nobody has touched since.

This conforms to the letter of the spec, which says *"Last activity is the
task's most recent run event timestamp when it has runs, otherwise the task's
`updatedAt`"*, and the code comments the choice deliberately at `:2089-2091`.
Recorded, not must-fix.

Fix direction if Leo wants the other reading: take
`max(latest event, latest run's queuedAt)` — not `max(…, updatedAt)`, which
would collapse back to the `updatedAt` proxy the change set out to replace.

### O-10 — P2 — the badge and the filter banner disagree about the chain's name

`apps/web/src/components/task-card.tsx:163` and `apps/web/src/pages/Tasks.tsx:330`.

When `chainName` is null the badge renders `task.chainId.slice(0, 8)` — eight
characters of a `randomUUID()` (`packages/api/src/templates.ts:107`). Clicking it
sets the filter to `name: task.chainName ?? task.chainId`, the **full** uuid, so
the banner then reads `Showing chain 3f2b1c94-…-…` for a badge that said
`3f2b1c94`.

Spec §Changes 4 asks for *"a compact badge identifying the chain"*. A uuid
fragment identifies it to the machine; two different renderings of the same
fallback identify it to nobody.

Fix direction: derive one label in one place and pass it to both — either the
same truncation in both, or a translated word plus the id only in `title`.

## Not findings

Checked and clear:

- `taskChainName`'s suffix rule matches real instantiation exactly
  (`packages/api/src/templates.ts:153-155` sets both `templateStepId` and the
  `"<chain>: <step>"` name), including for direct chains, which go through the
  same `instantiateTemplate`. Verified against this session's own task row.
- The no-runs constraint holds: `byLatestRunActivity` falls back to `updatedAt`,
  and the sort is total, so such a task can neither crash nor drop out.
  Covered at `packages/api/src/board.test.ts:96-106`.
- `cardTime` omits rather than invents whenever a timestamp is missing —
  RUNNING with no `startedAt`, ended with a null `endedAt`, and no run at all
  all fall through to `timeAgo`. Covered at
  `apps/web/src/tests/tasks-board.test.tsx:221-234`.
- `chainProgress` remains for `Archived.tsx:38` and `Triggers.tsx:240`, so
  `chainMarker` is not dead code; the spec permits it to stay.
- Board `chainProgress` is never null for a chained card (`enrich` is forced
  true for `view=board` at `:2125`), so gating the badge on it is safe.
- `chainName` being board-only is consistent with `mergeOutcome`, which is
  already board-only.
