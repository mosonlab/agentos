import { RunnerKind } from "@anneal/db";
import { asRecord, asString, contentText, textSignatureId } from "@anneal/db/agent-message";

export type LatestAgentMessage = { body: string; at: Date };
export type LatestAgentMessageEvent = { type: string; at: Date; payload: unknown };

/** A task detail poll reads only one session and only its bounded tail. */
export const LATEST_AGENT_MESSAGE_EVENT_LIMIT = 2_000;

export const latestAgentMessageEventTypes = (runner: RunnerKind): string[] => (
  runner === RunnerKind.PI
    ? ["MODEL_COMPLETED", "FINAL_OUTPUT"]
    : ["MODEL_DELTA", "MODEL_COMPLETED", "FINAL_OUTPUT"]
);

const visible = (text: string): boolean => text.trim().length > 0;

/** Project the text-producing runner branches used by the session stream.
 * Events must be supplied oldest-first. */
export const projectLatestAgentMessage = (
  runner: RunnerKind,
  events: LatestAgentMessageEvent[],
): LatestAgentMessage | null => {
  let lastCodexAgentText = "";
  let latest: LatestAgentMessage | null = null;
  const piSeen = new Set<string>();

  for (const event of events) {
    const payload = asRecord(event.payload);

    if (event.type === "MODEL_DELTA") {
      if (runner === RunnerKind.CLAUDE) {
        const text = contentText(asRecord(payload?.message)?.content);
        if (visible(text)) latest = { body: text, at: event.at };
      } else if (runner === RunnerKind.CODEX) {
        const item = asRecord(payload?.item);
        if (asString(item?.type) === "agent_message") {
          const text = asString(item?.text) ?? "";
          if (visible(text)) {
            lastCodexAgentText = text;
            latest = { body: text, at: event.at };
          }
        }
      }
      continue;
    }

    if (event.type === "MODEL_COMPLETED" && runner === RunnerKind.PI) {
      const message = asRecord(payload?.message);
      if (asString(message?.role) !== "assistant") continue;
      const content = message?.content;
      const text = contentText(content);
      if (!visible(text)) continue;
      const timestamp = message?.timestamp;
      const identity = typeof timestamp === "number" || typeof timestamp === "string"
        ? String(timestamp)
        : textSignatureId(content);
      if (identity !== null) {
        if (piSeen.has(identity)) continue;
        piSeen.add(identity);
      }
      latest = { body: text, at: event.at };
      continue;
    }

    if (event.type !== "FINAL_OUTPUT") continue;
    const text = runner === RunnerKind.CLAUDE
      ? asString(payload?.result) ?? ""
      : runner === RunnerKind.CODEX ? lastCodexAgentText : "";
    if (visible(text)) latest = { body: text, at: event.at };
  }

  return latest;
};
