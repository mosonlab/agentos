Route: implementation=senior-dev

Board UX queue. Independent backend card; may dispatch ahead of the UI cards. Route senior-dev: the change governs persisted-data deletion.

### Goal

A task that belongs to a chain can no longer be deleted individually: the API refuses it, so a chain's step structure cannot be amputated from the board menu.

### Background

`DELETE /tasks/:taskId` in `packages/api/src/app.ts` locks the task's mutation rows and deletes it with no chain awareness; the only protection is a `window.confirm` in the web client. Deleting a mid-chain step leaves successors whose predecessor rows are gone, undermining `blockingPredecessor` and `activateChainSuccessor`, which assume the chain's task set is complete. By contrast `patchTask` already refuses chain-inconsistent status writes, so deletion is the one unguarded mutation.

### Changes

1. `DELETE /tasks/:taskId` refuses with a machine-readable invalid-request refusal when the task has a `chainId` (directly or via the repair-marker chain resolution used elsewhere), naming the chain and stating that chain deletion is the supported operation.
2. Add a chain deletion operation: delete every task of a chain atomically in one transaction (steps plus chain-bound repair tasks), refused while any member has an active run. Expose it as an API route; wiring a UI entry is out of scope here.
3. The existing single-task delete path is unchanged for chain-less tasks.

### Out of scope

- No web UI changes (the aggregate-card card owns menu surfaces).
- No archive semantics changes; archiving remains the preferred retirement path.
- No cascade cleanup beyond the chain's own tasks (runs/activities follow existing relational behavior).

### Constraints

- Fail loudly with the repository's refusal-code conventions; no silent partial deletion. The whole-chain delete either removes every member or nothing.

### Acceptance

1. dbtest: deleting a chain-bound task returns the refusal; the task remains.
2. dbtest: chain delete removes all members including a chain-bound repair task, atomically.
3. dbtest: chain delete with an active run on any member is refused and deletes nothing.
4. dbtest: chain-less task deletion behaves exactly as before.
5. Existing API tests remain green; `npm run lint` passes.


---
Routing Contract: v1.4
Tier: Direct
Implementation Agent: senior-dev
Critical: yes
Reason: Governs persisted-data deletion; atomic whole-chain delete transaction.