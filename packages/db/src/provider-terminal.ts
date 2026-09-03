/**
 * Codex reports reconnect progress through the same event shape as errors.
 *
 * The counter may be followed by a parenthesised cause: a run whose stream
 * dropped four times reported `Reconnecting... 2/5 (stream disconnected before
 * completion: tls handshake eof)`. An anchored counter-only pattern rejected
 * that, so an ordinary reconnect notice latched the session's error flag and a
 * run that reconnected, finished its turn, and committed its work was completed
 * as PROTOCOL_ERROR. Codex can also report a reconnect while it waits for the
 * network without a retry counter. Both forms are status events, so they must
 * not latch the session's error flag. Anything else is still a real provider
 * error.
 */
export const isCodexReconnectStatus = (message: string | null): boolean =>
  /^Reconnecting\.\.\. (?:\d+\/\d+(?: \([^\n]*\))?|waiting for network \([^\n]*\))$/u.test(
    message?.trim() ?? "",
  );
