Contract ID: PC-spec-transcription-fidelity-v2
Version: 1

Goal: Review-step claims verify that the materialized specification at the pinned implementation head faithfully matches the chain's authoritative specification.

Background: Direct and compound review steps read a workspace specification file produced by an earlier agent transcription. The control plane currently trusts that copy, so a mistranscribed or tampered file can silently change the authority used by every blind reviewer. The previous implementation attempt in PR #134 was closed without merge because its branch no longer matched current main.

Changes:
1. At review-step claim, read the materialized specification from the pinned implementation commit and compare it with the authoritative text.
2. Resolve authority by chain shape: the approved specification step output for a compound chain, and the task brief for a direct chain.
3. Compare by byte equality after optionally normalizing line endings on both sides; refuse a mismatch with one named, operator-visible reason before a Run is claimed.
4. Cover faithful and tampered specifications for both direct and compound chains, including the repository read at the pinned commit and the claim refusal surface.

Out of scope: Reusing or rebasing PR #134; changing review findings, adjudication, merge authorization, or unrelated task-creation behavior; adding degraded fallback when authoritative text or repository evidence is unavailable.

Constraints: Implement against current main. Historical Run and task outputs remain immutable. Missing authority, unreadable pinned evidence, and mismatches fail loudly. Normal faithful chains retain their existing claim and review behavior.

Acceptance:
- A tampered compound-chain specification is refused at review claim with the named reason.
- A tampered direct-chain specification is refused at review claim with the named reason.
- Faithful direct and compound chains claim and review as before.
- Tests prove that comparison reads the pinned implementation head and that refusal reaches the operator-facing API without silently blocking unrelated claims.

Dependencies and prerequisites: Start from the latest origin/main at execution time. No dependency on the abandoned PR #134 branch.

Risks, authority, and stopping conditions: This chain may change API, repository-read, task-template, and web task-creation surfaces needed by the acceptance criteria. Stop and report if current main makes the authoritative source ambiguous or if satisfying the contract would require rewriting historical Run data.

Routing Contract: v1.3
Tier: Direct
Implementation Agent: senior-dev-luna
Critical: no
Reason: The requirement is enumerable; Direct blind review and exact-head merge authorization remain intact.
