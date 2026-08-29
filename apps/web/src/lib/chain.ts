import type { ChainProgress } from "./types";

/**
 * The one-line chain marker: `4/9 · Implementation · doing`.
 *
 * Formatting only. The arithmetic belongs to the API (`GET /tasks` assembles it
 * once for the whole board), and a second implementation here could disagree
 * with the numbers the board itself renders.
 */
export const chainMarker = (
  // The four fields it formats, not the whole payload: `position` rides along in
  // the response, but this chain-wide formatter does not read it.
  progress: Pick<ChainProgress, "done" | "total" | "activeStepName" | "activeStatus"> | null | undefined,
): string | null => {
  if (!progress) return null;
  return `${progress.done}/${progress.total} · ${progress.activeStepName} · ${progress.activeStatus}`;
};

/**
 * A board card describes its own place, not the chain's current execution.
 *
 * Step only. The execution layer is a scheduling coordinate — which steps the
 * control plane may enqueue together — and it answers a question the board is
 * not asking; the chain detail page groups its steps by layer and is where that
 * fact belongs. On the card it was a second pair of numbers per chain row,
 * pushing the title into its clamp for nothing the operator reads here.
 */
export const chainPositionMarker = (
  progress: Pick<ChainProgress, "position" | "total"> | null | undefined,
): string | null =>
  (!progress || progress.position === null ? null : `step ${progress.position}/${progress.total}`);
