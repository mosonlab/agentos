A mechanical Run whose completion the API rejected is not retried automatically after it is judged lost; its Task moves to Review with the rejection as the stated reason, so a rejected completion costs one Run and one operator decision instead of a loop of Runs and stop cards.

Depends on: chain 6fc989fd (Merge executor: contract version guard at claim, visible completion rejection) - this chain consumes the TaskActivity record that chain writes when `agentos.complete` is rejected.

Background: On 2026-09-02 between 23:09Z and 23:29Z the merge executor's `complete` call was rejected with 400 three times in a row on task `cmtjj2laz0cvimpfi11gylgtr` (completion contract drift after PR #417). Each rejected Run stayed `running` with a frozen heartbeat, was judged lost by `packages/api/src/reconcile.ts` after the stall window (`Runner heartbeat starved after ...; platform lease expired at ...`), and the lost path refunded the attempt and opened the next Run (`Run N lost; retry M queued`). Each replacement merged nothing new, hit the same rejection, and opened a `changed-underneath-me` stop that needed an operator answer. The cause was fixed by rebuilding the executor; the amplifier is that reconcile treats a rejected completion exactly like a runner that vanished. The predecessor chain makes the rejection a durable fact: the executor writes a TaskActivity on the Task naming the HTTP status and response body before it gives up. This chain acts on that fact.

Changes:
1. `packages/api/src/reconcile.ts`: before opening the automatic retry for a lost Run whose execution mode is mechanical, read the Task's activity for a completion-rejection record written for that Run (the record shape and its identifying marker are the ones the predecessor chain introduced; reuse them, do not define a second marker). When one exists, refuse the automatic retry: the Run is terminalized as lost with `failureReason` carrying the rejection status and body, no replacement Run is opened, and the Task moves to `REVIEW` with a TaskActivity line `Run N lost after its completion was rejected (<status>); automatic retry refused, operator action required`.
2. The lost-lease budget refund in the same path still applies to that Run, so an operator `retry` after fixing the cause does not need a `maxSessionsPerTask` bump.
3. Non-mechanical (agent) Runs and mechanical Runs without a rejection record keep the existing lost path unchanged.
4. `docs/operator-api.md`: the lost-Run reconciliation description names this refusal and the operator recovery (fix the cause, then `retry`).

Out of scope: the executor's own claim and completion behaviour (predecessor chain); the stall timeout and heartbeat model; the contract version guard; agent Run retry policy and the external-failure refund rules (chain 9081e383 owns `run-completion.ts` classification); any Prisma migration.

Constraints: the decision is taken inside the same transaction that terminalizes the lost Run, under the Task mutation lock the path already holds; a rejection record for a different Run of the same Task does not match. Fail loud: if the record exists but cannot be parsed, refuse the automatic retry and say so, never fall through to the retry. `*.dbtest.ts` coverage is merge gate evidence and is not run inside a Run.

Acceptance:
- `packages/api` dbtest for reconciliation: a lost mechanical Run with a completion-rejection TaskActivity for its id opens no replacement, leaves the Task in `REVIEW`, writes the refusal activity line, and its `failureReason` contains the rejection status; the same Run without the record opens the replacement as before; a lost agent Run with an unrelated activity opens the replacement as before; a rejection record naming a different Run id does not match.
- After that refusal, an operator `retry` on the Task opens a new Run without changing `maxSessionsPerTask` (budget refund preserved).
- `docs/operator-api.md` names the refusal and the recovery.
- `npm run test -w packages/api` and `-w packages/db` are green; `lint` and `typecheck` for those workspaces are green.

Route: implementation=senior-dev - the decision sits inside the lost-lease reconciliation transaction under the Task mutation lock; ordering against the runner's late salvage and the replacement open is a lease-window hazard the suite can only sample.