/**
 * A minted installation token must not appear in a log line, an error message,
 * a task activity, a run output, or a completion body. The token is held in one
 * run-scoped value and passed only to the HTTPS request builder — but an error
 * thrown from deep inside `fetch`, or a
 * well-meant `JSON.stringify(requestInit)` in a future debug line, can still
 * carry it outward.
 *
 * So every outbound string passes through a redactor built from the token
 * itself. This is a backstop, not the design: the design is that the value is
 * never placed anywhere it could travel from.
 */

export const REDACTED = "[redacted-merge-credential]";

export type Redactor = (value: unknown) => string;

/**
 * An Error has no enumerable own properties, so `JSON.stringify` renders one as
 * `{}`. Every crash line this daemon writes passes the thrown value inside a
 * context object — `log.error("mechanical run crashed", { runId, error })` —
 * which is exactly the line an operator reads first and exactly the line that
 * said `{"runId":"...","error":{}}` until this replacer existed.
 *
 * What is returned here is walked by the same replacer, so a `cause` that is
 * itself an Error is expanded in place and the whole chain survives. An
 * `AggregateError` is unwrapped too: `fetch` reports a failed connection as an
 * otherwise message-less aggregate whose `errors` hold the only readable
 * reason.
 */
const errorReplacer = (_key: string, value: unknown): unknown => {
  if (!(value instanceof Error)) return value;
  const { name, message, stack, cause } = value;
  const aggregated = (value as { errors?: unknown }).errors;
  return {
    name,
    message,
    ...(stack === undefined ? {} : { stack }),
    ...(cause === undefined ? {} : { cause }),
    ...(Array.isArray(aggregated) ? { errors: aggregated } : {}),
  };
};

const stringify = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, errorReplacer) ?? String(value);
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
