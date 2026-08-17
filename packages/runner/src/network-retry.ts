const TRANSIENT_NETWORK_PATTERNS = [
  /SSL_ERROR_SYSCALL/i,
  /unexpected EOF/i,
  /connection (?:reset|closed|timed out)/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /HTTP(?: response)?\s*5\d\d/i,
  /status(?: code)?\s*5\d\d/i,
  /502 Bad Gateway/i,
  /503 Service Unavailable/i,
  /504 Gateway Timeout/i,
] as const;

const DETERMINISTIC_ACCESS_PATTERNS = [
  /authentication failed/i,
  /could not read Username/i,
  /permission denied/i,
  /forbidden/i,
  /HTTP(?: response)?\s*(?:401|403)/i,
  /status(?: code)?\s*(?:401|403)/i,
  /bad credentials/i,
] as const;

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const isTransientNetworkError = (error: unknown): boolean => {
  const message = messageOf(error);
  if (DETERMINISTIC_ACCESS_PATTERNS.some((pattern) => pattern.test(message))) return false;
  return TRANSIENT_NETWORK_PATTERNS.some((pattern) => pattern.test(message));
};

export type RetryOptions = {
  attempts?: number;
  wait?: (attempt: number) => Promise<void>;
};

const defaultWait = async (attempt: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, attempt * 250));
};

/** Run an external network operation at most three times. Only errors that are
 * explicitly classified as transient are retried; authentication, permission,
 * malformed input, and ordinary command failures return immediately. */
export const retryTransientNetwork = async <T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const attempts = options.attempts ?? 3;
  const wait = options.wait ?? defaultWait;
  let attempt = 1;
  for (;;) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (attempt >= attempts || !isTransientNetworkError(error)) throw error;
      await wait(attempt);
      attempt += 1;
    }
  }
};

const RETRIED_GIT_OPERATIONS = new Set(["clone", "fetch", "push", "ls-remote"]);

/** Central command policy for delivery network calls. Keeping the allowlist
 * here prevents a later `git fetch` path from accidentally bypassing the same
 * reliability contract while ordinary command failures remain single-shot. */
export const runWithNetworkRetry = async <T>(
  executable: string,
  args: readonly string[],
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const retryableCommand = (executable === "git" && RETRIED_GIT_OPERATIONS.has(args[0] ?? ""))
    || (executable === "gh" && args[0] === "pr" && (args[1] === "list" || args[1] === "create"));
  return retryableCommand ? retryTransientNetwork(operation, options) : operation();
};
