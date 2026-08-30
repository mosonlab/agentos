Implement this task on fix/board-archived-chain-aggregate directly from the feature brief below — a direct chain carries no spec or plan phase, so the brief is the specification of record. The platform materializes `.chain/fix/board-archived-chain-aggregate/spec.md` as the specification of record; leave it untouched. The platform pins native child threads to Luna max and limits the session to eight concurrent children. Use them only when the brief contains independent, safely parallel work; group related change points instead of creating one child per item. In the controlled resource limit, fill as many slots as can execute safely in parallel. Give every concurrent writer its own branch and git worktree, and keep coupled work in your own context. When at least two child-writer branches need integration, start one long-lived merger after the first result is ready; integrate a sole child-writer branch yourself. The merger integrates completed branches in dependency-safe order, resolves only mechanical conflicts, reruns affected narrow tests, and reports semantic conflicts to you. Follow the platform-pinned Implementation proof boundary after integration. Give a failed child one bounded correction in the same thread, then take over its assignment yourself. A child must not perform irreversible external actions. Commit the result and persist exactly one JSON object as the task output: `{"schemaVersion":1,"headSha":"<final HEAD>","baseSha":"<starting HEAD>","summary":"<what changed>","testsRun":["<command>"]}`. Leave publication and pull-request creation to the platform. Complete when the brief's behavior is demonstrably delivered and tests are green at the recorded head.
<!-- agentos:task-brief:v1 length=2461 -->
An archived chain reappears on the board as an aggregate card.

## What is wrong

The chain `Merge lease hold duration` (chainId `b85cd64b-1e0b-4070-82dd-008ae4c0320c`)
is fully archived, yet the board renders it as an aggregate card in the Backlog
column, showing `Step 5/7 - Idle`, `run 8 - cancelled` and the cancellation
reason `Operator approved cancellation: PR #219 superseded the chain product
contract; archive and rebrief from current main`.

## Established facts

Every one of its seven rows has a non-null `archivedAt`:

    1|done|archived     Implementation
    2|done|archived     Code review (Sol)
    3|done|archived     Code review (Opus blind)
    4|done|archived     Apply review fixes
    5|backlog|archived  Regression verification
    6|todo|archived     Merge authorization
    7|todo|archived     Merge execution

`GET /tasks` does not return any of them, and neither does
`GET /tasks?includeArchived=true`. The card's detail link points at
`cmtcfr4kc0001mpk9xk3t0sl9`, which is `chainIndex` 1 with
`archivedAt = 2026-08-28 08:46:06.757`.

The database holds more than a dozen other chains that are also fully archived
while still carrying non-DONE steps, and none of those appear on the board. So
the archive filter is mostly working; this chain hits a boundary the others do
not.

## Where to look

`packages/api/src/board.ts`, the aggregate assembly near line 860. Its own
comment states the intent:

> Include the complete chain lookup first so archived siblings contribute to
> progress, costs and terminal placement. Visible rows then fill malformed
> one-row chains and retain the exact card-side run projection.

Archived siblings are meant to contribute progress and cost only. Emission is
meant to follow visible rows (`rows.map` at the end of the same function). Find
why this chain still reaches emission, and fix the boundary rather than adding
a special case for it.

## Introduced by

PR #256 (`9f6712be feat(web): collapse board chains into aggregate cards`),
deployed to production in `ff4a4e6376d1dbb533018b93ad94a6ed554042bc` on
2026-08-29. Before aggregation the chain rendered no card at all, so this is a
regression the aggregate view introduced, not a pre-existing leak.

## Done means

An archived chain renders no aggregate card, with a regression test that fails
on the current build. Chains that are only partly archived keep their existing
progress and cost behaviour.

Route: implementation=senior-dev

<!-- /agentos:task-brief:v1 -->
Persist the final implementation output for this step through the Anneal task output endpoint.