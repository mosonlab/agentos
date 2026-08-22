/**
 * The merge credential must not appear in a log line, an error message, a task
 * activity, a run output, or a completion body. The token is held in one
 * module-private constant (`preconditions.ts`) and passed only to the HTTPS
 * request builder — but an error thrown from deep inside `fetch`, or a
 * well-meant `JSON.stringify(requestInit)` in a future debug line, can still
 * carry it outward.
 *
 * So every outbound string passes through a redactor built from the token
 * itself. This is a backstop, not the design: the design is that the value is
 * never placed anywhere it could travel from.
 */

export const REDACTED = "[redacted-merge-credential]";

export type Redactor = (value: unknown) => string;

const stringify = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * Secrets shorter than this are refused as redaction inputs: a two-character
 * "secret" would blank out unrelated substrings of every message and make the
 * logs useless, which is its own failure mode.
 */
const MINIMUM_REDACTABLE_LENGTH = 8;

export const makeRedactor = (...secrets: Array<string | null | undefined>): Redactor => {
  const values = secrets
    .filter((secret): secret is string => typeof secret === "string" && secret.trim().length >= MINIMUM_REDACTABLE_LENGTH)
    .map((secret) => secret.trim())
    // Longest first, so a token that contains a shorter secret still redacts whole.
    .sort((left, right) => right.length - left.length);
  return (value: unknown): string => {
    let text = stringify(value);
    for (const secret of values) text = text.split(secret).join(REDACTED);
    return text;
  };
};

/** A console bound to a redactor. The daemon uses only this, never `console`. */
export type ExecutorLog = {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
  /** Derive a logger for a run-scoped secret without changing the sink. */
  withSecrets: (...secrets: Array<string | null | undefined>) => ExecutorLog;
};

export const makeLog = (redact: Redactor, sink: Pick<Console, "log" | "warn" | "error"> = console): ExecutorLog => {
  const line = (message: string, context?: Record<string, unknown>): string =>
    context === undefined ? redact(message) : `${redact(message)} ${redact(context)}`;
  return {
    info: (message, context) => { sink.log(line(message, context)); },
    warn: (message, context) => { sink.warn(line(message, context)); },
    error: (message, context) => { sink.error(line(message, context)); },
    withSecrets: (...secrets) => {
      const secretRedactor = makeRedactor(...secrets);
      return makeLog((value) => redact(secretRedactor(value)), sink);
    },
  };
};
