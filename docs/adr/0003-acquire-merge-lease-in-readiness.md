# Acquire the merge lease in readiness

Status: accepted (2026-08-28)

Regression persists semantic and Merge gate evidence without holding the merge
Lease. Merge readiness acquires the Lease, repeats the repository-state decision
inside that window, and either authorizes and hands the Lease to merge execution
or releases it. An unreachable Lease transport leaves readiness durably deferred
for a later mechanical tick; it does not invalidate the Regression verdict or
spend another agent Run. If `main` moves before or during acquisition, readiness
returns the Chain to Regression because the exact-base evidence is stale.

This supersedes ADR-0001's continuous `regression acquire -> merge execution`
hold. A concurrent merge can now waste one completed gate and require a fresh
Regression, but ordinary network failure can no longer replay semantic work, and
the global Lease is held only across the final repository check and merge.
