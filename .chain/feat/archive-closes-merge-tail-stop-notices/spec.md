Goal: Archiving a chain closes the merge-tail stop notices still OPEN on its tasks, so an archived chain leaves nothing pending in the Inbox.

Background: `openMergeTailStopNotice` in packages/api/src/merge-tail-actions.ts upserts an InboxMessage with `taskId` set to the stopped merge-tail task and `dedupeKey` `merge-tail-stop:<taskId>:<sha256(reason)>`; the base-drift recovery stop path writes the same shape. Nothing closes these messages when the operator gives up on the chain: `POST /tasks/:taskId/archive` (packages/api/src/routes/tasks.ts, the archive handler) archives every task of the chain and touches no InboxMessage. After the 2026-09-03 word-factory recovery (legacy chain 3a8aee90-89cc-477d-a81a-7329769b5e38, archived after its canonical successor merged), two OPEN stop notices (`cmtlex48g000nmp7r1nrd0vab`, `cmtlegafy08vdmp2ol48kiwcb`) remain on regression task cmtl7r6ks001hmp2ojtj58wal with no lifecycle that will ever close them. The operator policy forbids clearing them through generic Task PATCH or database writes, so the archive route is the only correct owner.

Changes:
1. In the archive handler, inside the same transaction that archives the tasks, set `status: CLOSED` and `answeredAt` on every InboxMessage whose `taskId` is one of the archived task ids, whose `status` is OPEN, and whose `dedupeKey` starts with `merge-tail-stop:`. Other OPEN messages on those tasks (questions, gate cards, alerts with other keys) are untouched.
2. Record one control-plane TaskActivity on each affected task naming the closed message ids, so the closure is auditable from the task.
3. Unarchive (`POST /tasks/:taskId/unarchive`) does not reopen closed notices; a later stop writes a new notice through the existing upsert path.
4. Tests for the archive route: archiving a chain whose regression task carries two OPEN merge-tail-stop notices and one OPEN unrelated message leaves the two notices CLOSED with `answeredAt` set, the unrelated message OPEN, and one activity per affected task; archiving a chain with no notices writes nothing; the existing refusal for active runs still precedes any Inbox write.
5. docs/operator-api.md: state under `POST /tasks/:taskId/archive` that merge-tail stop notices on the archived tasks are closed, and update the "Recovering a merge tail stopped after its repair budget" step (d) sentence accordingly.

Out of scope: closing notices from any other route or worker; changing how notices are opened or keyed; Inbox UI; messages not keyed `merge-tail-stop:`; backfilling notices on chains archived before this change (the two word-factory messages are closed by re-running archive on that chain only if the route is made idempotent for already-archived tasks, which is a separate decision and not part of this brief).

Constraints: The Inbox update happens in the archive transaction or not at all. No new configuration. Fail loud on any inconsistency; no silent skip.

Acceptance:
- `npm run test -w @anneal/api` is green including the cases in Change 4; `npm run typecheck -w @anneal/api` and `npm run lint -w @anneal/api` pass.
- With the fixture in Change 4, `SELECT status, "answeredAt" FROM "InboxMessage" WHERE "dedupeKey" LIKE 'merge-tail-stop:%'` shows CLOSED with a non-null timestamp after the archive call, and the unrelated message is still OPEN.
- docs/operator-api.md describes the closure in both places named in Change 5.