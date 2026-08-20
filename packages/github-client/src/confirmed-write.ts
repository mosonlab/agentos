/**
 * The idempotent-write engine: **never decide a write's fate from its error.**
 *
 * The operator discipline this replaces was "a GitHub write that errors gets
 * read back before anything is resent". It worked, when it was remembered. On
 * the night of 2026-08-18 it was executed by hand five times; twice — PR #147
 * and PR #150 — the read-back is what stopped a duplicate merge, because the
 * POST that reported EOF had already merged. A discipline that is only as good
 * as the operator's attention is not a property of the system, so this module
 * makes it one.
 *
 * The loop, in full:
 *
 *   1. Attempt the write.
 *   2. If it reports `applied`, that is the end of it.
 *   3. Otherwise — refused OR lost, no exceptions — read back.
 *   4. Read-back found it applied  -> applied. Nothing is resent.
 *   5. Read-back could not be read -> INDETERMINATE. Nothing is resent, ever.
 *      A write whose fate is unknown is a human's problem, not a retry's.
 *   6. Read-back positively found nothing:
 *        - the attempt was refused        -> refused. A resend cannot help.
 *        - the caller allows resending    -> resend, from step 1.
 *        - the caller forbids resending   -> not-applied.
 *
 * Step 5 is the rule the hand-run discipline kept implicitly and code usually
 * gets wrong: a failed *read-back* is not a licence to retry the *write*. The
 * runner's pull-request creation had exactly that hole — its confirmation probe
 * threw on a flaky link, the enclosing retry loop saw a transient error and
 * sent a second `gh pr create`.
 *
 * `resend: "never"` is how a non-idempotent operation is expressed. A comment
 * has no natural key, so a second POST is a second comment; such a write is
 * read back and then either accepted or reported, but never repeated. Where a
 * key can be carried in the payload instead, see `idempotency.ts` — that is
 * what turns a comment into something a read-back can recognise.
 */

/** What one attempt at the write reported. See classify.ts for the taxonomy. */
export type WriteAttempt<T> =
  | { status: "applied"; value: T }
  | { status: "refused"; reason: string }
  | { status: "lost"; reason: string };

/**
 * What a read of the durable state found. `absent` is a positive finding — "I
 * looked, and the write is not there" — and is the ONLY thing that may license
 * a resend. A read that could not be completed is `unreadable`, never `absent`.
 */
export type ReadBack<T> =
  | { status: "applied"; value: T }
  | { status: "absent" }
  | { status: "unreadable"; reason: string };

/**
 * `after-confirmed-absent` — the write may be sent again, but only once a
 * read-back has positively established that it did not land.
 * `never` — the operation is not idempotent (a comment, a notification); one
 * send, then read back and report.
 */
export type ResendPolicy = "after-confirmed-absent" | "never";

export type ConfirmedWriteResult<T> =
  /** The write is on the platform. `confirmedBy` says which observation established that. */
  | { status: "applied"; value: T; attempts: number; confirmedBy: "attempt" | "read-back" }
  /** The platform answered "no", and a read-back agreed nothing landed. */
  | { status: "refused"; reason: string; attempts: number }
  /** Nothing landed, and nothing more may be sent — the policy, the attempt
   *  budget or the caller's deadline stopped it. Safe to report as a failure. */
  | { status: "not-applied"; reason: string; attempts: number }
  /** The write's fate is unknown and this process may not resolve it. NOT a
   *  failure and NOT a success: an operator has to look. */
  | { status: "indeterminate"; reason: string; attempts: number };

export type ConfirmedWriteOptions<T> = {
  /** Performs the write once. Must classify its own outcome and must not throw. */
  attempt: (attemptNumber: number) => Promise<WriteAttempt<T>>;
  /** Reads the durable state the write would have produced. Must not throw. */
  readBack: () => Promise<ReadBack<T>>;
  resend: ResendPolicy;
  /** Ceiling on sends, counting the first. Default 1 — a caller that wants
   *  retries has to say so. */
  attempts?: number;
  /** Backoff between a confirmed-absent read-back and the next send. */
  wait?: (attemptNumber: number) => Promise<void>;
  /**
   * The caller's budget, consulted before every send and given the number of
   * the send it is being asked about. A false answer ends the loop; it never
   * shortens the read-back that has already happened.
   *
   * The argument matters because the first send and a resend are not the same
   * question. A caller may reasonably spend its last milliseconds on the one
   * send that publishes the work, while refusing to start a resend it cannot
   * finish — which is what the runner's delivery deadline does.
   */
  canSend?: (attemptNumber: number) => boolean;
};

const describe = <T>(outcome: WriteAttempt<T> & { status: "refused" | "lost" }): string =>
  `${outcome.status}: ${outcome.reason}`;

export const confirmedWrite = async <T>(options: ConfirmedWriteOptions<T>): Promise<ConfirmedWriteResult<T>> => {
  const maxAttempts = Math.max(1, options.attempts ?? 1);
  const canSend = options.canSend ?? ((): boolean => true);
  const wait = options.wait ?? (async (): Promise<void> => undefined);
  let attempts = 0;

  for (;;) {
    if (!canSend(attempts + 1)) {
      // Nothing has been sent since the last read-back said `absent` (or since
      // the caller's budget was checked for the first send), so this is a
      // determinate "it did not happen", not an unknown.
      return {
        status: "not-applied",
        reason: attempts === 0
          ? "the caller's budget was exhausted before the write was sent"
          : `the caller's budget was exhausted after ${attempts} send(s), the last of which was confirmed not to have landed`,
        attempts,
      };
    }

    attempts += 1;
    const outcome = await options.attempt(attempts);
    if (outcome.status === "applied") {
      return { status: "applied", value: outcome.value, attempts, confirmedBy: "attempt" };
    }

    // The error is never the verdict. Whatever it said, ask the platform.
    const confirmation = await options.readBack();
    if (confirmation.status === "applied") {
      return { status: "applied", value: confirmation.value, attempts, confirmedBy: "read-back" };
    }
    if (confirmation.status === "unreadable") {
      // The one branch that must never fall through to a resend: we do not know
      // whether the write landed, and sending it again is how one merge becomes
      // two.
      return {
        status: "indeterminate",
        reason: `${describe(outcome)}; the read-back that would have settled it could not be completed: ${confirmation.reason}`,
        attempts,
      };
    }

    // `absent`: the write demonstrably did not land.
    if (outcome.status === "refused") {
      return { status: "refused", reason: outcome.reason, attempts };
    }
    if (options.resend === "never") {
      return {
        status: "not-applied",
        reason: `${outcome.reason} (this operation is not idempotent, so it was read back and left alone)`,
        attempts,
      };
    }
    if (attempts >= maxAttempts) {
      return { status: "not-applied", reason: `${outcome.reason} (${attempts} attempts)`, attempts };
    }
    await wait(attempts);
  }
};
