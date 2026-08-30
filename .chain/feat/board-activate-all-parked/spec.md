Chains instantiated with autoStart=false sit in Todo as parked aggregate cards, each with its own Activate button (`ChainAggregateCard` in `apps/web/src/components/chain-aggregate-card.tsx`, wired through `aggregateActions.onActivate` in `apps/web/src/pages/Tasks.tsx`, which runs the startability check and then `POST /tasks/:id/start`). When an operator parks a wave of ten chains and wants them all to go after a release merges, they must click ten cards and confirm ten dialogs. There is no column-level action.

The Done column already has the precedent: `BoardColumn` in `apps/web/src/components/desktop-board.tsx` renders an `Archive All` button in the column head only when the column is non-empty. Add the same shape to the Todo column: an `Activate all` button in the head, shown only when at least one visible aggregate card is in the `parked-unactivated` state.

Required:
- One confirmation dialog listing the chains that will be activated (name and step count), not one dialog per chain.
- Activation reuses the existing per-task path exactly: startability check first, then `POST /tasks/:id/start` on each chain's activation task (`aggregate.activation.taskId`). No new API route and no new server-side bulk mutation; a chain whose startability check refuses is reported in the dialog by name with the refusal, and the rest still start. Do not stop the batch on the first refusal and do not silently skip.
- Chains in `waiting-on-predecessor` are not included; they dispatch themselves when the predecessor completes.
- Single-task parked cards (non-chain) are out of scope.

Done means:
- Web tests in the tasks-board test file cover: button absent with no parked chain; button present with parked chains; dialog lists exactly the parked chains; one refusal does not block the others and is shown by name.
- `npm run lint` and typecheck pass.

Route: implementation=frontend-dev
