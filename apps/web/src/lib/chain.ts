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
  // the response and nothing here reads it.
  progress: Pick<ChainProgress, "done" | "total" | "activeStepName" | "activeStatus"> | null | undefined,
): string | null => {
  if (!progress) return null;
  return `${progress.done}/${progress.total} · ${progress.activeStepName} · ${progress.activeStatus}`;
};
