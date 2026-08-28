A claim refusal caused by a transient spec-content read failure re-queues itself with bounded backoff instead of latching the task in BACKLOG for manual operator recovery.

Background: claim-side pinned specification reads enforce a per-attempt server deadline; after the in-code retry budget (observed live: spec-transcription-unreadable after 3 attempts against a 1200ms deadline) the claim is refused, the run finishes FAILED, and the task drops to BACKLOG. During the 2026-08-28 09:40-09:55Z network flap this latched three review steps across two chains until an operator manually recovered each one. Routine proxy flaps last tens of seconds to minutes, far longer than the current in-claim retry budget. The pinned-fetch 20s timeout fix covered a different path; this claim-side read refusal still latches.

Changes:
1. Classify spec-read claim refusals at the refusal site: transient (read deadline exceeded, transport/network errors) versus non-transient (spec content mismatch, fidelity refusal, missing or corrupt spec). The classification is explicit in the persisted failure evidence.
2. A transient-classified refusal does not fail the run to BACKLOG. The task stays claimable and is deferred with backoff under a bounded overall budget on the order of minutes; each deferral is recorded observably on the run or task activity, never silently.
3. Each deferred attempt re-enters the normal claim path in full: claim fencing, step admission, and candidate eligibility are re-evaluated every time, and a task completed or cancelled in the meantime is never claimed again.
4. When the overall budget is exhausted, fail exactly as today: run FAILED, task BACKLOG, failure reason naming the exhausted budget and the last underlying error.
5. Non-transient refusals keep today's immediate FAILED/BACKLOG behavior unchanged.

Out of scope: the provider-stream PROTOCOL_ERROR retry path; the regression verdict handoff (owned by chain 337803d4); the auto-deploy escalation pipeline; the spec read implementation itself (mirror strategy, per-attempt deadline value).

Constraints: fail loud, no silent swallowing; deferral must not weaken claim fencing or step-admission invariants; behavior is idempotent under concurrent completion, cancellation, and repeated reconciliation.

Acceptance: DB/API tests prove a transient refusal defers and later succeeds without operator action; budget exhaustion produces today's FAILED/BACKLOG with a named reason; non-transient refusals are immediate and unchanged; every deferral leaves observable evidence; a task cancelled during deferral is not claimed. Targeted tests, typecheck, and lint pass.

Route: implementation=senior-dev — the deferral loop interacts with claim fencing and step admission inside the claim transaction; the hazard is a race the acceptance suite cannot fully witness.