const DEFAULT_DELAYS_MS = Object.freeze([2_000, 5_000]);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Runs a read-only or idempotent command up to three times. A caller remains
 * responsible for classifying the final non-zero result. */
export const runCommandWithRetry = async (
  run,
  {
    delaysMs = DEFAULT_DELAYS_MS,
    wait = delay,
    onRetry = () => undefined,
    shouldRetry = (result) => result.code !== 0,
  } = {},
) => {
  let result;
  for (let attempt = 1; attempt <= delaysMs.length + 1; attempt += 1) {
    result = await run(attempt);
    if (result.code === 0) return result;
    if (!shouldRetry(result)) return result;
    const waitMs = delaysMs[attempt - 1];
    if (waitMs === undefined) return result;
    onRetry({ attempt, nextAttempt: attempt + 1, waitMs, result });
    await wait(waitMs);
  }
  return result;
};
