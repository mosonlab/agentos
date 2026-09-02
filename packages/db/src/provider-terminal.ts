/** Codex reports reconnect progress through the same event shape as errors. */
export const isCodexReconnectStatus = (message: string | null): boolean =>
  /^Reconnecting\.\.\. \d+\/\d+$/u.test(message?.trim() ?? "");
