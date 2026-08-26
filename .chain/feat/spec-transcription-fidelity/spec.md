Problem: every review step in both chain shapes reads the chain workspace copy of the specification of record as its authority, but that copy is produced by agent transcription: the compound chain's materialization step transcribes the approved spec output, and the direct chain's first step transcribes the task brief. The platform never verifies the transcription, so both blind reviewers share a single unverified contamination point; a mistranscribed or tampered copy silently rewrites what the reviews judge against.

What to build: when a review step's run is claimed, the server compares the materialized specification in the pinned implementation head against the authoritative text it was transcribed from: for a compound chain the spec field of the approved spec step output, for a direct chain the task brief. Comparison is byte equality; line endings may be normalized on both sides before comparing. On mismatch the claim is refused with a named refusal reason, following the repository's fail-loudly convention; no silent pass-through and no degraded fallback.

Acceptance:
- A fixture chain whose materialized specification is tampered with after materialization is refused at review step claim, and the refusal carries the named reason.
- Normal chains with a faithful copy claim and review exactly as before.
- Both chain shapes are covered: compound (authority is the approved spec output) and direct (authority is the task brief).
Persist the final implementation output for this step through the AgentOS task output endpoint.
