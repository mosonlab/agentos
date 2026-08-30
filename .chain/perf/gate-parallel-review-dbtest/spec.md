Implement this task on perf/gate-parallel-review-dbtest directly from the feature brief below — a direct chain carries no spec or plan phase, so the brief is the specification of record. The platform materializes `.chain/perf/gate-parallel-review-dbtest/spec.md` as the specification of record; leave it untouched. The platform pins native child threads to Luna max and limits the session to eight concurrent children. Use them only when the brief contains independent, safely parallel work; group related change points instead of creating one child per item. In the controlled resource limit, fill as many slots as can execute safely in parallel. Give every concurrent writer its own branch and git worktree, and keep coupled work in your own context. When at least two child-writer branches need integration, start one long-lived merger after the first result is ready; integrate a sole child-writer branch yourself. The merger integrates completed branches in dependency-safe order, resolves only mechanical conflicts, reruns affected narrow tests, and reports semantic conflicts to you. Follow the platform-pinned Implementation proof boundary after integration. Give a failed child one bounded correction in the same thread, then take over its assignment yourself. A child must not perform irreversible external actions. Commit the result and persist exactly one JSON object as the task output: `{"schemaVersion":1,"headSha":"<final HEAD>","baseSha":"<starting HEAD>","summary":"<what changed>","testsRun":["<command>"]}`. Leave publication and pull-request creation to the platform. Complete when the brief's behavior is demonstrably delivered and tests are green at the recorded head.
<!-- agentos:task-brief:v1 length=1801 -->
Merge gate wall-clock, next cut. Context: PR #315/#316/#317 removed about 123 core-seconds from the concurrent db wave but only 13 seconds of wall-clock (192s to 179s), because the wave is bounded by its longest file. Reducing core-seconds spread across short files does not move the wall-clock; only the top file does. The runbook baseline and the per-file timing instrumentation from PR #317 are on main.

The per-file report (78 files, 905 core-seconds, concurrent run) names the new single longest file: `packages/api/src/parallel-review.dbtest.ts` at 75.7s. Next: `merge-integrator-seed` 51.6s, `chain-branch` 40.5s, `chain` 33.1s.

## Required

- Reduce the wall-clock of `parallel-review.dbtest.ts` without removing any assertion or case. Look first at what the prior rounds found elsewhere: per-case process spawns (`npx prisma ...`, `migrate deploy` where an in-process path exists), fixture setup repeated per case instead of per file, and fixed waits or retention intervals that can be shortened through the existing env overrides (`SERVICE_LOCK_RETENTION_INTERVAL_MS` pattern). Splitting the file into two so the scheduler can run them in parallel is acceptable only if the split is by subject, not by half.
- Measure with alternating A/B runs, several rounds each; this machine's single-run noise has produced the opposite conclusion before. Report before/after per-file numbers from the PR #317 timing output, not from a stopwatch.
- Do not touch `affected-tests-only`, lanes, or worker sizing; those were rejected.

## Done means

- The file's per-file timing drops measurably (target: it is no longer the longest file in the wave), case count unchanged, all green.
- The PR description carries the alternating A/B table.
- `npm run lint` passes.

Route: implementation=senior-dev

<!-- /agentos:task-brief:v1 -->
Persist the final implementation output for this step through the Anneal task output endpoint.