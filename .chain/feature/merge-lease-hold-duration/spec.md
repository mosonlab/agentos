Rebrief from current main be608ae96b2812c83a39e53563a2261b2be3e36a after PR #219 superseded chain b85cd64b-1e0b-4070-82dd-008ae4c0320c and PR #213.

Problem
ADR-0003 moved merge-lease acquisition out of Regression and into merge readiness. The old hold-duration branch instruments the previous ownership shape and now conflicts in merge-lease.ts and merge-readiness-worker.ts. We still need durable evidence for the new window: readiness acquisition through release after drift/requeue/stop/failure, or through the authorization handoff and merge completion.

Required behavior
- Start from current main; do not merge or transplant PR #213 wholesale. Reuse only still-valid tests or calculations after re-deriving them against readiness-owned acquisition.
- A confirmed lease release exposes the lease ref, blob SHA, and acquiredAt from the deleted blob without weakening compare-and-swap release semantics.
- Record one project-scoped chain activity marker for each confirmed released lease. Identity is (projectId, chainId), and the lease blob SHA makes recording idempotent.
- Record acquiredAt, releasedAt, and non-negative whole heldForSeconds. Do not record not-held, skipped, refused, contended, or unreachable attempts as successful holds.
- Cover every current readiness-owned release path, including post-acquire drift/requeue/stop, cancellation/reconciliation, and the merge execution handoff. A recording failure must be observable; it must not silently claim evidence was stored.
- Do not change STALE_SECONDS or MERGE_LEASE_TIMEOUT_MINUTES. This card creates evidence for a later threshold decision.

Acceptance
1. Unit tests parse the confirmed release contract and calculate invalid, clock-skew, and normal durations.
2. DB tests prove project-scoped attribution and idempotence for two projects sharing a chainId.
3. Readiness and merge-tail tests prove retained authorization is measured only when the final consumer releases it, while non-retained paths record their own confirmed release.
4. Existing lease deferral, exact-head recheck, cancellation, and reconciliation tests remain green.
5. Targeted tests, typecheck, lint, and the exact merge gate pass.

Preserved evidence
- Superseded chain: b85cd64b-1e0b-4070-82dd-008ae4c0320c.
- Superseded PR: #213, branch feat/merge-lease-hold-duration at 1d28ce9c1e0c20c2b5bc08e0a70144f1d90a0c7b.
- Replacement architecture: PR #219 and docs/adr/0003-acquire-merge-lease-in-readiness.md.

Route: implementation=senior-dev