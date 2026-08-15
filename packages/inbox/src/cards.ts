export type Choice = { id: string; label: string };

// Gate cards now carry an artifact preview; Feishu rejects oversized cards, so
// the rendered body is capped independently of whatever the producer wrote.
const CARD_BODY_LIMIT = 3_000;

const cardBody = (body: string): string =>
  body.length <= CARD_BODY_LIMIT ? body : `${body.slice(0, CARD_BODY_LIMIT)}\n…（消息过长已截断，完整内容见 Inbox 页）`;

export const questionCard = (message: { id: string; body: string; choices: Choice[] }): Record<string, unknown> => ({
  config: { wide_screen_mode: true },
  header: {
    template: "blue",
    title: { tag: "plain_text", content: message.choices.length > 0 ? "AgentOS 需要你的决策" : "AgentOS 任务提问" },
  },
  elements: [
    { tag: "div", text: { tag: "lark_md", content: cardBody(message.body) } },
    ...(message.choices.length > 0 ? [{
      tag: "action",
      actions: message.choices.map((choice) => ({
        tag: "button",
        type: choice.id === "approve" ? "primary" : choice.id === "reject" ? "danger" : "default",
        text: { tag: "plain_text", content: choice.label },
        value: { inboxMessageId: message.id, choiceId: choice.id },
      })),
    }] : []),
    { tag: "note", elements: [{ tag: "plain_text", content: "也可直接回复此消息；长连接离线期间飞书不会补投事件。" }] },
  ],
});
