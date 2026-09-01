Make the fixed-implementation sibling validator accept a review output that a later successful Run of the same task validated, instead of demanding the Run that first wrote it.

Background: `packages/api/src/canonical-task-output.ts` (`fixed-implementation` refusal, the check that returns `sibling output is not backed by a successful completed Run`) requires `stepOutput.run.status === SUCCEEDED` for each `sol-findings` / `blind-findings` sibling. Review outputs are immutable once persisted, so the output row stays bound to the Run that first wrote it. When that Run is later LOST (runner heartbeat starved) and a retry Run completes successfully against the same head, completion now accepts the prior-Run output (PR chain 9f3501e0, commit 48b9352d) and the review task goes DONE, but the sibling validator still sees the LOST Run and refuses every `fixed-implementation` write with HTTP 409. Chain 2a97bb93 hit this on 2026-09-01 and was unblocked by rebinding the output row to Run 5 by hand; the validator must not depend on that surgery.

Changes:
1. In the sibling check, replace the `output.run.status !== SUCCEEDED` condition with: the output belongs to the sibling task (`output.run.taskId === sibling.id`, keep) and the sibling task has at least one SUCCEEDED Run whose `headSha` equals `output.commitSha`. The Run that wrote the output need not be that Run.
2. Keep every other condition (exactly one sibling per kind, immutable kind match, sourceHead equality against `commitSha`, `headSha`, `reviewedHead`, reviewedBase agreement, disposition coverage) unchanged.
3. Apply the same rule to `packages/api/src/regression-repair-handoff.ts` only if its `output.run.status` check can hit the same LOST-then-retried shape for review-fix outputs; if it cannot (repair outputs are written by the Run that pushes them), leave it and say why in the activity log.

Out of scope: any change to run completion, output immutability, retry semantics, or the web client.

Constraints: one grouped query for the sibling Runs, not one per sibling. Run `npm run lint` (not `npx biome`) before handing off.

Acceptance:
- A dbtest seeds a chain whose sol-findings output is bound to a LOST Run while a later Run of the same task is SUCCEEDED with matching `headSha`; a valid `fixed-implementation` write is accepted.
- A dbtest where the only Run with matching `headSha` is FAILED still refuses with the existing message.
- A dbtest where the output's `commitSha` differs from every SUCCEEDED Run's `headSha` refuses.
- Existing canonical-task-output dbtests pass unchanged; `npm run lint` and `packages/api` dbtests pass.
