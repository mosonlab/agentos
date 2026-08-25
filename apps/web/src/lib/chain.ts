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

/** A board card describes its own place, not the chain's current execution. */
export const chainPositionMarker = (
  progress: Pick<ChainProgress, "position" | "total">
    & Partial<Pick<ChainProgress, "currentLayer" | "layerCount">>
    | null
    | undefined,
): string | null => {
  if (!progress || progress.position === null) return null;
  const step = `step ${progress.position}/${progress.total}`;
  return progress.currentLayer === undefined || progress.layerCount === undefined
    ? step
    : `${step} · layer ${progress.currentLayer}/${progress.layerCount}`;
};
