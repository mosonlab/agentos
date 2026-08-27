export const abortReason = (signal: AbortSignal): unknown => (
  signal.reason ?? new DOMException("The operation was aborted", "AbortError")
);

/** A timer that tears itself down promptly when its owning request is cancelled. */
export const abortableDelay = (
  delayMs: number,
  signal?: AbortSignal | null,
): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(abortReason(signal));
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", aborted);
    resolve();
  }, delayMs);
  const aborted = (): void => {
    clearTimeout(timer);
    reject(signal ? abortReason(signal) : new DOMException("The operation was aborted", "AbortError"));
  };
  signal?.addEventListener("abort", aborted, { once: true });
});
