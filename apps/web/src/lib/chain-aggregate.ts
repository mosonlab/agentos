import type { BoardTask, ChainAggregate } from "./types";

/**
 * The one place the client reads an operator-facing answer off a Chain
 * aggregate: which control action is admissible on it, and which Step number
 * its card names.
 *
 * "Can this Chain be held right now?" used to be answered twice — once by the
 * aggregate card, which read `activation.state`, and once by the Doing column
 * head, which read only `activation.hold`. The two rules disagreed for a
 * `settled` or `idle` Chain with a non-null `activation.taskId`: the column
 * swept it into the Hold-all wave while its own card offered no Hold button.
 * One module, one answer, three renders.
 */

export type ChainControlActionKind = "activate" | "hold" | "resume";

/** At most one action is admissible at a time: the states that admit Activate
 *  are disjoint from those that admit Hold or Resume, so the card, the column
 *  head and the page all decide from the same single answer. `taskId` is the
 *  activation Task every chain control route is addressed to; it names the
 *  first primary Step, which keeps the request independent of whichever
 *  frontier happens to be visible. */
export type ChainControlAction = { kind: ChainControlActionKind; taskId: string };

/**
 * The action an operator may take on this Chain, or `null` for none.
 *
 * The full matrix of `activation.state` by `activation.hold`:
 *
 * | state                  | hold null | hold set |
 * | ---------------------- | --------- | -------- |
 * | parked-unactivated     | activate  | none     |
 * | waiting-on-predecessor | hold      | none     |
 * | running                | hold      | resume   |
 * | held                   | none      | resume   |
 * | idle                   | none      | none     |
 * | settled                | none      | none     |
 *
 * Half of that matrix the board projection cannot produce: it derives `held`
 * from a persisted hold and `running` from an active member, so a non-null
 * `hold` never arrives on any other state. Those cells offer nothing rather
 * than guessing an action for a shape the projection forbids.
 *
 * `settled` matches the server, which refuses a Hold on a completed Chain
 * outright ("there is nothing left to hold"). `idle` is the narrower client
 * rule: the server would accept a Hold there, but an `idle` Chain has no
 * admitted layer in flight and no predecessor about to release it, and the
 * board offers Hold all on Doing only, which an `idle` aggregate never reaches.
 */
export const chainControlAction = (
  activation: ChainAggregate["activation"],
): ChainControlAction | null => {
  const { hold, state, taskId } = activation;
  if (taskId === null) return null;
  if (hold === null) {
    if (state === "parked-unactivated") return { kind: "activate", taskId };
    if (state === "waiting-on-predecessor" || state === "running") return { kind: "hold", taskId };
    return null;
  }
  // A hold on a Chain that is still running is a barrier after the current
  // layer, not a cancellation: the Run keeps going, so the only thing left to
  // offer is lifting the barrier.
  if (state === "held" || state === "running") return { kind: "resume", taskId };
  return null;
};

/**
 * The dense one-based Step number the aggregate card names, counting down three
 * sources in order of directness: the position the projection computed, the
 * position carried by the frontier member itself, and finally the count of
 * settled Steps. The last is a floor, not a measurement — a Chain whose
 * frontier is missing from the rendered members still says which Step it is on
 * rather than saying nothing.
 */
export const chainStepPosition = (
  aggregate: ChainAggregate,
  members: readonly BoardTask[],
): number => {
  const fromFrontier = aggregate.frontier.position;
  if (fromFrontier !== null && fromFrontier !== undefined) return fromFrontier;
  const frontier = members.find((member) => member.id === aggregate.frontier.taskId);
  const fromMember = frontier === undefined
    ? null
    : frontier.chainProgress?.position ?? (frontier.chainIndex === null ? null : Math.min(aggregate.stepCount, frontier.chainIndex + 1));
  if (fromMember !== null && fromMember !== undefined) return fromMember;
  const done = aggregate.statusCounts.DONE;
  return aggregate.stepCount === 0 ? 0 : Math.min(aggregate.stepCount, done + 1);
};
