# Sol code review findings

## Authority

- implementation base: `00b94f9861861d19c5bdc78b57cb5949d82bd730`
- delivered head: `e4bc4f05b987a0d44c8761727175cf08a48b425f`
- reviewed range: `00b94f9861861d19c5bdc78b57cb5949d82bd730...e4bc4f05b987a0d44c8761727175cf08a48b425f`
- specification: `.chain/board-activity-ordering-card-info/spec.md`
- revised plan: none; this is a direct chain
- range verification: both commits resolve, base is an ancestor of head, and checkout `HEAD` equalled delivered head before review

## Finding counts

| Severity | Count |
| --- | ---: |
| P0 | 0 |
| P1 | 3 |
| P2 | 6 |

## Findings

### SOL-SPEC-001 — P1 — Chain filtering makes Archive All confirm one scope and mutate another

- Location: `apps/web/src/pages/Tasks.tsx:183-184`, `apps/web/src/pages/Tasks.tsx:246-247`, `apps/web/src/pages/Tasks.tsx:338-345`
- Governing specification: “Out of scope: ... archive behavior.”
- Problem: activating a chain filter narrows `tasks`, which also narrows `latest.current` and the Done count shown by the confirmation. The request still calls the project-wide archive endpoint.
- Evidence: with one visible Done task in the selected chain and twenty hidden Done tasks elsewhere in the project, the UI confirms “Archive 1 done tasks?” and then posts to `/projects/:projectId/tasks/archive-done`; that endpoint selects every unarchived Done task in the project at `packages/api/src/app.ts:3041-3043`, so all twenty-one are archived. This changes archive behavior and understates the mutation the user approves.
- Required direction: preserve the project-wide confirmation count and make that scope explicit, or add an endpoint whose mutation scope is the visible chain or explicit task IDs. Add an interaction regression with visible and hidden Done tasks that proves the confirmation and mutation scopes agree.

### SOL-SPEC-002 — P1 — Running duration freezes when the task payload is unchanged

- Location: `apps/web/src/components/task-card.tsx:132-136`, `apps/web/src/components/task-card.tsx:228-236`
- Governing specification: “a card whose latest run is running shows elapsed time since that run's start”.
- Problem: elapsed time is computed from `Date.now()` only during render, but no clock drives another render.
- Evidence: unchanged polls are discarded by `usePoll` (`apps/web/src/lib/hooks.ts:91-99`), unchanged rows retain object identity (`apps/web/src/pages/Tasks.tsx:68-94`), and `TaskCard` is memoized. A RUNNING card can therefore keep showing its initial `running 12m` until some serialized field changes or the run ends, rather than showing current elapsed time.
- Required direction: give visible RUNNING cards a bounded clock tick or pass a periodically updated `now`, while avoiding rerenders of inactive cards. Add a fake-timer mounted-component test that keeps props unchanged, advances time, and observes the duration advance.

### SOL-SPEC-003 — P1 — API-created non-template chains retain their shared title prefix

- Location: `packages/api/src/board.ts:92-100`, `apps/web/src/components/task-card.tsx:126-129`
- Governing specification: “a chained card's title renders without the chain-name prefix shared by the chain's tasks”.
- Problem: `taskChainName` returns a chain name only when `templateStep` exists. Direct/API-created chains are supported with `chainId` plus `chainIndex` but cannot set `templateStepId`, so their titles are never de-duplicated.
- Evidence: `taskInput` accepts a paired `chainId` and `chainIndex` (`packages/api/src/app.ts:294-317`), the create route explicitly describes these as “API-created chains” and cannot set `templateStepId` (`packages/api/src/app.ts:2281-2299`), and `cardTitle` leaves the name unchanged whenever `chainName` is null. Two supported tasks named `Release: Build` and `Release: Review` in the same direct chain therefore render those full prefixed titles.
- Required direction: derive one verified shared display prefix for every returned chain, not only template-instantiated chains, while leaving stored names unchanged. Add an API plus card test for a non-template chain with a shared prefix.

### SOL-SPEC-004 — P2 — The filter acceptance test does not exercise activation or clearing

- Location: `apps/web/src/tests/tasks-board.test.tsx:209-221`
- Governing specification: “Automated test: the chain badge filter shows only that chain's tasks and can be cleared”.
- Problem: the test calls `tasksForChain` directly and renders a clear control with `onClear={noop}`. It never clicks the badge or clear button through `TasksPage` state.
- Evidence: the test would remain green if `actions.onFilterChain` stopped updating page state or if the clear button did nothing, because neither callback is invoked.
- Required direction: mount the board with two chains, click the real badge, assert the other chain disappears, click the real clear control, and assert it reappears.

### SOL-SPEC-005 — P2 — The ordering acceptance test covers only two of five columns and does not model createdAt

- Location: `packages/api/src/app.test.ts:1486-1501`
- Governing specification: “Automated test: the board view yields each column newest-activity-first; a Done task that finished later than another appears above it even when created earlier.”
- Problem: the test supplies only DONE and TODO tasks, despite its “every status” name, and its rows do not carry `createdAt` evidence.
- Evidence: BACKLOG, DOING, and REVIEW can regress without this acceptance test failing, and the named Done fixtures prove only that activity wins over `updatedAt`, not that later completion wins over the former `createdAt` ordering.
- Required direction: provide reverse-activity pairs for all five statuses and give the two Done fixtures opposing `createdAt` and completion-event order.

### SOL-SPEC-006 — P2 — Missing-timestamp evidence covers only the both-null case

- Location: `apps/web/src/tests/tasks-board.test.tsx:224-235`
- Governing specification: “if a run lacks the timestamps a rendering needs, omit that rendering rather than showing a wrong value”.
- Problem: the negative test supplies `startedAt:null` and `endedAt:null` together, leaving every one-sided missing-timestamp case unproved.
- Evidence: the required omission would not be protected if terminal handling later rendered with only a start or only an end, or if a RUNNING row without a start began fabricating elapsed time.
- Required direction: separately cover terminal start-only, terminal end-only, and RUNNING-without-start rows, asserting each renders time-ago without a duration.

### SOL-STD-001 — P2 — Activity ordering makes a global count poll scan every historical run

- Location: `packages/api/src/app.ts:2089-2109`
- Problem: `latestRunActivity` fetches one result row for every historical Run of every returned task, then reduces to a task maximum in application memory.
- Evidence: `ProjectsPage` polls global `/tasks?enrich=false` every 2.5 seconds only to count rows (`apps/web/src/pages/Projects.tsx:72-83`). The new ordering query still scans and materializes all historical Runs for that count-only consumer, so query and transfer cost grow without bound as run history accumulates.
- Direction: aggregate `MAX(SessionEvent.at)` by task in the database and give count-only consumers a representation that does not pay for unused task ordering. Preserve the full and board view ordering contract.

### SOL-STD-002 — P2 — New chain-position copy bypasses the locale dictionaries

- Location: `apps/web/src/lib/chain.ts:19-25`
- Problem: the newly visible word `step` is hard-coded in the formatter, so the Chinese board renders an English chain-position label while adjacent new card and filter copy is localized.
- Evidence: `tasks.card.filterChain`, `tasks.card.runningDuration`, `tasks.filter.chain`, and `tasks.filter.clear` were added to both locale dictionaries; no locale key exists for the chain-position label, and the formatter has no `Translate` input.
- Direction: localize a `tasks.card.chainStep` template or return position data from the helper and format it in the component through `t`.

### SOL-STD-003 — P2 — De-duplicated title links lose their chain context from the accessible name

- Location: `apps/web/src/components/task-card.tsx:159-177`
- Problem: visually de-duplicating titles also changes the link's accessible name to the bare step name. Common steps such as `Review` and `Implementation` then produce indistinguishable links across chains.
- Evidence: the code comment says the title link gives the card its accessible name, but the separate chain badge button does not participate in that link name. Link-only keyboard or screen-reader navigation sees repeated `Review` links without their chain context.
- Direction: keep the short visual title while giving the link the full stored task name through `aria-label` or equivalent visually hidden context, and add an accessibility assertion for two chains with the same step name.

No Fowler smell finding was accepted. The harness reported no separate smell-only candidate with sufficient behavioral evidence.

## Harness and verification

Both required candidate-finding passes ran concurrently from delivered `HEAD` and exited 0:

```text
codex exec review -m gpt-5.6-sol -c model_reasoning_effort=high -c service_tier="standard" "Review the changes from 00b94f9861861d19c5bdc78b57cb5949d82bd730 to e4bc4f05b987a0d44c8761727175cf08a48b425f. This is the Standards axis only. ..." </dev/null > /tmp/cmt2fud9q073tmp45y82mixoc-standards.log 2>&1 &
codex exec review -m gpt-5.6-sol -c model_reasoning_effort=high -c service_tier="standard" "Review the changes from 00b94f9861861d19c5bdc78b57cb5949d82bd730 to e4bc4f05b987a0d44c8761727175cf08a48b425f. This is the Specification axis only. ... [approved spec text carried in full]" </dev/null > /tmp/cmt2fud9q073tmp45y82mixoc-spec.log 2>&1 &
```

The CLI identified both sessions as `gpt-5.6-sol` with `high` reasoning. It warned that `standard` was not advertised for the model and omitted the tier override; the required command-line override was nevertheless supplied, and no fallback model or effort was used.

Fresh-checkout bootstrap and coordinator regressions:

```text
npm install
npm run db:generate
npm run build -w @agentos/db
RUNNER_WORKSPACE_ROOT=$(mktemp -d /tmp/agentos-sol-api.XXXXXX) node --import tsx --test --test-name-pattern 'GET /tasks|board and full task views order|tasks sort newest run-event activity|chain names are derived|projection drops|assignee carries' packages/api/src/app.test.ts packages/api/src/board.test.ts
# 7 passed, 0 failed
RUNNER_WORKSPACE_ROOT=$(mktemp -d /tmp/agentos-sol-web.XXXXXX) TSX_TSCONFIG_PATH=apps/web/tsconfig.app.json node --import tsx --test --test-name-pattern 'cards in one chain|chain badges filter|running, ended, and absent runs|assignee is one line' apps/web/src/tests/tasks-board.test.tsx
# 4 passed, 0 failed
node scripts/public-snapshot-scan.mjs
# 0 blockers, 0 unclassified, 0 overlaps
git diff --check
# passed
```

The Specification harness additionally ran the three changed test files together: 113 passed, 0 failed. The Standards harness ran three targeted web and three targeted API tests: 6 passed, 0 failed. One earlier coordinator test attempt stopped before loading tests because the fresh clone lacked `tsx`; after the mandated bootstrap, the same targeted tests passed. No database test or custom reproduction was run, and no live database was contacted. The implementation step's persisted output records the pre-review full API, Web, and scratch-PostgreSQL suites as green; this review did not duplicate those completed full-suite checks.
