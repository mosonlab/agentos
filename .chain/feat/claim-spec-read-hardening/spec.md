Claim-side specification verification survives transient network failures: it retries with backoff, reads through the local repository mirror, and only parks a task on persistent failure.

Background: Specification-fidelity verification in packages/api reads pinned spec content from GitHub at review-claim time under a 4000ms deadline. A single transient failure (TLS handshake eof, proxy flap, deadline overrun) refuses the claim as spec-transcription-unreadable and parks the task in Backlog behind an operator notification; four such refusals occurred on 2026-08-27 alone. The local repository mirror introduced by feat/runner-local-mirror (packages/runner/src/repo-mirror.ts) covers only runner workspace provisioning; the claim-side read still goes to GitHub every time.

Changes:
1. Transient read failures (timeout, transport) during claim-side spec verification retry with bounded backoff before any park decision; the classification of transient versus permanent is explicit, and a genuine content mismatch still refuses immediately without retry.
2. The claim-side spec read is served from the local repository mirror when the mirror holds the pinned commit, with the GitHub read as fallback when the mirror cannot serve it; a mirror miss is not an error.
3. A park after exhausted retries records the retry count and last failure inside failureReason so the operator can distinguish persistent failure from a single blip.

Out of scope: runner workspace provisioning and its mirror usage; the spec-transcription-mismatch content comparison itself; merge-tail readiness reads; inbox notification mechanics.

Constraints: verification stays fail-closed - content that cannot be verified after retries still parks; no silent acceptance path; no new configuration surface unless an acceptance criterion requires it.

Acceptance: tests prove (a) a transient failure followed by a successful read claims without parking, (b) persistent failure parks with retry evidence in failureReason, (c) a content mismatch refuses without retrying, (d) mirror-served verification returns the same verdict as the GitHub path for the same pinned commit; existing specification-fidelity suites stay green.
