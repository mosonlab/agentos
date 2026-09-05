/**
 * The one ref a single Run owns: `agentos/<taskId>/run-<n>`.
 *
 * Two facts are spelled with this name and they must stay the same string, so
 * it is derived here and nowhere else:
 *
 *   - the head a Run publishes when nothing else declares one, written to
 *     `Run.branch` at Run birth by `resolveRunBranches` (`run-open.ts`);
 *   - the WIP salvage ref a *failed* Run pushes instead of its declared head
 *     (`packages/runner/src/delivery.ts`), which the control plane authorizes
 *     by recomputing it (`packages/api/src/run-fence.ts` and
 *     `packages/api/src/workspace-reclaim.ts`).
 *
 * Uniqueness comes from the pair: `taskId` is a database id and `runNumber` is
 * unique within a Task, so no two Runs can be handed the same ref and a plain
 * `git push` is enough to publish it. That is what lets salvage refuse to force:
 * a rejection means something else is there.
 *
 * It is deliberately not the shared chain branch (`chain-branch.ts`): a failed
 * run's half-finished tree must never reach the ref every later step clones.
 */
export const runOwnedHead = (taskId: string, runNumber: number): string =>
  `agentos/${taskId}/run-${runNumber}`;
