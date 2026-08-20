import type { MergeOutcome } from "./types";

/**
 * §SF-1 — the one place the client turns a merge outcome into a badge.
 *
 * A mechanical merge that refused to merge still ends its run `SUCCEEDED`: the
 * executor did exactly what its contract says, and the protocol status says so.
 * Every run-centric surface that reads only that status therefore shows an
 * operator a green *Done* for a merge that never happened. This badge is what
 * those surfaces read instead. Nothing about run semantics moves: the status
 * enum, its `status.run.*` labels and the DTO's `status` field are untouched,
 * and every run that is not a mechanical merge renders exactly as before.
 *
 * Only `stopped` is overridden. `merged` is a Done that is honestly a Done, and
 * `malformed` never reaches the client — the server projection returns null for
 * any step output that is not a `merge-result`.
 *
 * The label is returned as a key, not as text: `RunPill` and the board card
 * translate through the React `useT`, the sessions mappings through `formatT`,
 * and a helper that resolved the string itself would have to pick one.
 */
export type MergeBadge = { tone: "amber" | "red"; key: string };

export const mergeBadge = (outcome: MergeOutcome | null | undefined): MergeBadge | null => {
  if (!outcome || outcome.outcome !== "stopped") return null;
  // The two post-merge conditions are a different event from the other
  // fourteen: the merge landed and *then* the world disagreed with it. Amber
  // reads "nothing happened, look when you can"; red reads "something did".
  return outcome.incident
    ? { tone: "red", key: "status.merge.incident" }
    : { tone: "amber", key: "status.merge.stopped" };
};
