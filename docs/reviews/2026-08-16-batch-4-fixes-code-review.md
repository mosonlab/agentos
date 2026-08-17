# Batch 4 fixes implementation code review

Reviewed implementation branch: `agentos/cmswjrnf40t4mmpyjn9u931bk/run-3`

Reviewed head: `55f092920f2ac4f972270d07b9328de3f9bb5d79`

Baseline: `aaad446bdf75a2bdcf7d518c10e823bf6840670c`

Verdict: **FAIL — 2 must-fix, 2 should-fix.** This file reconstructs the
persisted step-6 output because that review's workspace was externally removed
before it could commit or push; the AgentOS task output was its only surviving
delivery.

## Must-fix

1. The authoritative spec and revised plan still publish deploy/rollback
   commands disproved by the rehearsal while the runbook publishes another
   sequence. The spec unconditionally appends a second `?options=`, groups
   `SET lock_timeout` with `DROP INDEX CONCURRENTLY`, and prescribes
   `migrate resolve --rolled-back` for a successfully applied migration. Align
   spec, plan, and runbook with the rehearsed mechanisms: query-aware URL
   construction, one concurrent operation per psql call under `PGOPTIONS`,
   targeted history-row deletion for a successful physical rollback, and a
   batch-4-only drift baseline.
2. The runbook header lacks the mandatory implementation commit. Pin the tested
   implementation SHA (or its repaired successor) and make the restart section
   point to the same version.

## Should-fix

1. `usage.dbtest.ts` test 2b starts the contender before proving the holder
   acquired its lock, and accepts any quick `Error`. Add a holder-acquired
   barrier and assert mechanism plus a bounded elapsed time.
2. The unit named “summed-overflow session still writes” actually starts from
   all-null columns and asserts `wrote === false`; it never crosses the update
   boundary. Include a valid sibling such as `output_tokens: 9`, then assert one
   update, `wrote === true`, the overflowing input/total are null, and output 9
   survives.

## Review evidence recorded in the persisted output

Build, unit tests, typecheck, isolated database suites, drift check, and the
lock-deletion mutation passed as described by the reviewer. Browser inspection
loaded the Sessions shell in light and dark themes but the then-current
workspace lacked an operator credential, so live data rows were not verified.
No `apps/web`, `schema.prisma`, or new migration directory was in the diff.
