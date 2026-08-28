Problem
A Regression Run can persist a valid negative regression-verification output and then finish FAILED because the provider stream disconnects. Completion currently retries the Regression Run, while claim treats the previous negative verdict as requiring a repair result that cannot exist because failed completion never opened the repair. The retry then stops with an invalid handoff.

PR #219 does not address this path. It moves merge-lease acquisition from Regression to readiness and defers merge-lease transport failures. The provider-stream PROTOCOL_ERROR path and regressionRepairHandoffForClaim are unchanged.

Required behavior
- When a Regression Run has authored a valid negative verdict bound to that same Run and exact head, and completion reports a retryable PROTOCOL_ERROR after the output write, preserve the Run as FAILED so the transport fact stays truthful.
- Do not enqueue a fresh Regression retry that will be rejected for lacking a repair.
- Consume the durable negative verdict through the existing control-plane regression completion path and open exactly one matching review-fix, gate-fix, or refresh-conflict repair.
- Repeated completion or reconciliation must be idempotent and must not create duplicate repairs.
- Do not weaken the genuine fresh-session handoff rule: a later Regression Session after repair still requires the successful repair result and exact head bindings.
- Keep PASS plus transport-failure semantics out of scope unless the implementation proves the same rule is required for correctness; otherwise fail loudly and leave it for a separate decision.

Acceptance
1. A DB test reproduces output persisted by Run 1, retryable PROTOCOL_ERROR completion, and verifies Run 1 remains FAILED while one correct repair is opened and no Regression Run 2 is queued.
2. Equivalent negative outcomes review-fail, gate-fail, and refresh-conflict follow their existing repair kinds.
3. Duplicate completion/reconcile produces no duplicate repair.
4. Existing fresh-session handoff tests remain unchanged and green.
5. Targeted DB tests, typecheck, and lint pass.

Route: implementation=senior-dev