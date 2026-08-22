# Legacy merge-integrator stop recovery

This runbook is the operator procedure for a merge-integrator stop recorded
before AgentOS owned the complete recovery identity. It documents recovery; it
does not authorize an operator, script, or migration to manufacture missing
identity.

## Definition and boundary

A legacy stop is the newest `mergeIntegrator.result` activity for a mechanical
merge task when that result says `outcome: stopped` but lacks the server-owned
`sourceRunId`, or when no server-owned `mergeIntegrator.intent` can bind the
stopped attempt to its source Run and authorization. The Task being in `REVIEW`,
a failed Run, or an old chain shape is not enough by itself to classify a stop
as legacy.

AgentOS rejects generic start, retry, and status-change requests while this
stop is unresolved. That fail-closed behavior is intentional: neither a Task
status nor a plausible pull request can replace the missing identity.

The only supported recovery is the Inbox re-authorization protocol introduced
with PR #54. It obtains fresh evidence, asks the operator to judge that
evidence, and only then creates a new authorization and mechanical Run. It does
not repair the old identity or reinterpret the old stop as trusted evidence.

## Before answering

1. Open the mechanical merge Task and its Activity history. Confirm the newest
   `mergeIntegrator.result` is a stop and record its Task id, activity id,
   condition, and evidence. Confirm the legacy definition above from the
   server-returned metadata; do not infer missing fields from prose.
2. Find the OPEN Inbox message whose dedupe key is
   `merge-stop:<stop-activity-id>` and whose Task id is the same mechanical
   merge Task. Verify its displayed condition and evidence match the activity.
3. Verify the card actually offers `re-authorize`. Conditions such as ordinary
   `base-drift`, `target-unresolvable`, or a post-merge incident deliberately
   offer different dispositions. This runbook must not be used to add or
   simulate a choice the server did not offer.
4. Confirm there is no active mechanical Run for the Task. If one is active,
   leave it alone and diagnose that inconsistent state separately.

Any identity mismatch, ambiguous target, unrelated-chain evidence source, or
missing same-chain Run and Session is a stop. Preserve the records and diagnose
the producer; do not select a nearby record as a substitute.

## Re-authorize through Inbox

1. Choose `re-authorize` on the original stop card. Use the ordinary Inbox UI
   or its authenticated decision endpoint. Do not start or patch the
   integrator Task directly.
2. If the original card was already answered `re-authorize` but no confirmation
   card exists, replay the same decision on that same message. The PR #54
   recovery path reads the append-only `refresh-requested` disposition under
   the integrator Task lock and creates the missing request idempotently. Do not
   create a replacement Inbox message.
3. Verify this first decision creates exactly one OPEN confirmation card and
   one `mergeIntegrator.evidenceRequest` activity with
   `purpose: confirmation`. The request must name the same integrator Task and
   target repository and pull request. Its `sourceRunId` must identify a real
   preceding Run with a Session in the same chain.
4. Before the confirmation card is filled, verify there is no new
   `mergeIntegrator.authorization` activity and no new mechanical Run. The
   placeholder is a request for evidence, not permission to merge.
5. Wait for the control-plane evidence worker to fill the confirmation card.
   Read the repository, pull request number, exact head and base SHAs, checks,
   mergeability, and authorization status on the filled card. If collection
   failed or any identity is stale or ambiguous, do not approve it.
6. Approve only the filled, matching confirmation card. Approval must produce
   one fresh server-owned authorization activity and one new QUEUED mechanical
   Run bound to that authorization. A rejection instead requeues the
   regression step; it must not run the server-owned readiness step as a model
   task.
7. Follow the normal merge-executor evidence checks in
   `docs/runbooks/merge-executor.md`. Completion requires the recorded merge
   result, exact merge parents, the base ref at that commit, and no `.chain/` in
   the landed tree. Task or Run status alone is not completion evidence.

Repeated decision submissions are allowed only as an idempotent replay of the
same message and choice. They must not produce duplicate evidence requests,
authorizations, or Runs.

## Prohibited recovery methods

- Do not add, edit, or copy a `sourceRunId`, `mergeIntegrator.intent`,
  authorization activity, decision, review, or gate result.
- Do not write directly to PostgreSQL, including a one-off repair or backfill.
- Do not approve a placeholder, stale, failed, or ambiguously bound evidence
  card.
- Do not bypass the GitHub App merge path with a user token, direct base-branch
  push, manual merge, or a different executor identity.
- Do not broaden automatic recovery to conflicts, check failures, review
  rejection, identity uncertainty, payload mismatch, external incidents, or
  post-merge incidents.

There is deliberately no automatic migration for legacy stops. A migration
cannot reconstruct server-owned identity that was never recorded, and choosing
a plausible historical Run would fabricate authority. Existing legacy stops
remain fail closed until an operator completes the fresh Inbox
re-authorization protocol above or selects another disposition the original
server-issued stop card offers.
