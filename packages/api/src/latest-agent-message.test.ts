import assert from "node:assert/strict";
import test from "node:test";

import { RunnerKind } from "@anneal/db";

import {
  LATEST_AGENT_MESSAGE_EVENT_LIMIT,
  latestAgentMessageEventTypes,
  projectLatestAgentMessage,
  type LatestAgentMessageEvent,
} from "./latest-agent-message.js";

const at = (minute: number): Date => new Date(`2026-08-31T18:${String(minute).padStart(2, "0")}:00.000Z`);

const event = (type: string, minute: number, payload: unknown): LatestAgentMessageEvent => ({
  type,
  at: at(minute),
  payload,
});

test("the query contract bounds a session tail and skips PI deltas", () => {
  assert.equal(LATEST_AGENT_MESSAGE_EVENT_LIMIT, 2_000);
  assert.deepEqual(latestAgentMessageEventTypes(RunnerKind.PI), ["MODEL_COMPLETED", "FINAL_OUTPUT"]);
  assert.deepEqual(latestAgentMessageEventTypes(RunnerKind.CLAUDE), [
    "MODEL_DELTA", "MODEL_COMPLETED", "FINAL_OUTPUT",
  ]);
});

test("CLAUDE projects the newest delta or final-output text", () => {
  assert.deepEqual(projectLatestAgentMessage(RunnerKind.CLAUDE, [
    event("MODEL_DELTA", 1, { message: { content: [{ type: "text", text: "first" }] } }),
    event("MODEL_DELTA", 2, { message: { content: [{ type: "text", text: "second" }] } }),
    event("FINAL_OUTPUT", 3, { result: "final" }),
  ]), { body: "final", at: at(3) });
});

test("CODEX carries the newest agent message through a terminal marker", () => {
  assert.deepEqual(projectLatestAgentMessage(RunnerKind.CODEX, [
    event("MODEL_DELTA", 1, { item: { id: "one", type: "agent_message", text: "first" } }),
    event("MODEL_DELTA", 2, { item: { id: "two", type: "agent_message", text: "second" } }),
    event("FINAL_OUTPUT", 3, { type: "turn.completed" }),
  ]), { body: "second", at: at(3) });
});

test("PI ignores duplicate identities while allowing a newer assistant message", () => {
  assert.deepEqual(projectLatestAgentMessage(RunnerKind.PI, [
    event("MODEL_COMPLETED", 1, { message: { role: "assistant", timestamp: 10, content: [{ text: "first" }] } }),
    event("MODEL_COMPLETED", 2, { message: { role: "assistant", timestamp: 10, content: [{ text: "duplicate" }] } }),
    event("MODEL_COMPLETED", 3, { message: { role: "assistant", timestamp: 11, content: [{ text: "newest" }] } }),
  ]), { body: "newest", at: at(3) });
});
