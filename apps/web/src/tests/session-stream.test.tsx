import assert from "node:assert/strict";
import test from "node:test";

import { clampLines, normalize, projectStream, TEXT_NODE_MAX_LINES, TOOL_OUTPUT_MAX_LINES } from "../lib/session-stream";
import type { RunnerKind, SessionEvent } from "../lib/types";

/* Fixtures are pasted from spikes/cli-capabilities/samples/, so the mapping is
 * proved against payloads the CLIs actually emitted. */

let seq = 0;
const event = (type: string, payload: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => {
  seq += 1;
  return {
    id: `e${seq}`, sessionId: "s1", runId: "r1", seq, at: "2026-08-15T10:02:22.876Z",
    source: "CLAUDE", type, toolCallId: null, payload, ...extra,
  };
};

const run = (events: SessionEvent[], runner: RunnerKind, terminal = false) => normalize(events, runner, terminal);

const CLAUDE_TOOL_USE = { type: "tool_use", id: "toolu_01BPSeDbvAzAH7ZKo8SpqiqB", name: "Bash", input: { command: "printf 3", description: "Print 3" } };
const CLAUDE_TOOL_RESULT = { tool_use_id: "toolu_01BPSeDbvAzAH7ZKo8SpqiqB", type: "tool_result", content: "3", is_error: false };
const CLAUDE_TOOL_ONLY_ASSISTANT = { type: "assistant", message: { role: "assistant", content: [CLAUDE_TOOL_USE] } };
const CLAUDE_TEXT_ASSISTANT = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "3" }] } };

const PI_TOOL_START = { type: "tool_execution_start", toolCallId: "call_GHK5", toolName: "bash", args: { command: "printf 3" } };
const PI_TOOL_END = { type: "tool_execution_end", toolCallId: "call_GHK5", toolName: "bash", result: { content: [{ type: "text", text: "3" }] }, isError: false };
const PI_THINKING_TURN = {
  type: "message_end",
  message: { role: "assistant", content: [{ type: "thinking", thinking: "**Executing bash printf 3 command**" }, { type: "toolCall" }], timestamp: 1786788182370 },
};
const PI_TEXT_MESSAGE = {
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "3", textSignature: '{"v":1,"id":"msg_0dd98960899ddcb3016a80395bbff0819983b8f0dfac065616","phase":"final_answer"}' }], timestamp: 1786788186733 },
};
const PI_TEXT_TURN_END = { ...PI_TEXT_MESSAGE, type: "turn_end" };

test("CLAUDE: a tool-only assistant message yields no text, a text one yields one", () => {
  const { items, counts } = run([
    event("MODEL_DELTA", CLAUDE_TOOL_ONLY_ASSISTANT),
    event("MODEL_DELTA", CLAUDE_TEXT_ASSISTANT),
  ], "CLAUDE");
  assert.equal(counts.messages, 1);
  assert.deepEqual(items.map((item) => item.kind), ["text"]);
});

test("CLAUDE: a tool_use/tool_result pair becomes one tool item with the extracted result", () => {
  const { items, counts } = run([
    event("TOOL_STARTED", CLAUDE_TOOL_USE, { toolCallId: CLAUDE_TOOL_USE.id }),
    event("TOOL_COMPLETED", CLAUDE_TOOL_RESULT, { toolCallId: CLAUDE_TOOL_USE.id }),
  ], "CLAUDE");
  assert.equal(items.length, 1);
  const tool = items[0] as Extract<typeof items[number], { kind: "tool" }>;
  assert.equal(tool.kind, "tool");
  assert.equal(tool.name, "Bash");
  assert.equal(tool.primaryArg, "printf 3");
  assert.equal(tool.state, "ok");
  // The extracted display string, not the raw payload.
  assert.equal(tool.result, "3");
  assert.equal(counts.toolCalls, 1);
});

test("CLAUDE: a failed tool_result is red, and file paths come from file_path only", () => {
  const failed = run([event("TOOL_COMPLETED", { ...CLAUDE_TOOL_RESULT, is_error: true }, { toolCallId: "t1" })], "CLAUDE");
  assert.equal((failed.items[0] as { state: string }).state, "error");

  const { files, counts } = run([
    event("TOOL_STARTED", { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/repo/src/a.ts" } }, { toolCallId: "t2" }),
    event("TOOL_STARTED", { type: "tool_use", id: "t3", name: "Glob", input: { path: "/repo/src", pattern: "*.ts" } }, { toolCallId: "t3" }),
  ], "CLAUDE");
  assert.deepEqual(files, [{ path: "/repo/src/a.ts", count: 1 }]);
  assert.equal(counts.files, 1);
  assert.equal(counts.toolCalls, 2);
});

test("CLAUDE is not deduplicated: two identical messages both survive", () => {
  const { counts } = run([
    event("MODEL_DELTA", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
    event("MODEL_DELTA", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
  ], "CLAUDE");
  assert.equal(counts.messages, 2);
});

test("CODEX: one item id arriving twice yields one item carrying the later text", () => {
  const { items, counts } = run([
    event("MODEL_DELTA", { type: "item.started", item: { id: "item_0", type: "agent_message", text: "partial" } }),
    event("MODEL_DELTA", { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "3" } }),
  ], "CODEX");
  assert.equal(counts.messages, 1);
  assert.equal((items[0] as { text: string }).text, "3");
});

test("CODEX: aggregated_output is extracted, file_change paths are collected, reasoning is excluded", () => {
  const { items, files, counts } = run([
    event("MODEL_DELTA", { type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking out loud" } }),
    event("MODEL_DELTA", { type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "/repo/b.ts", kind: "update" }] } }),
    event("TOOL_COMPLETED", { id: "c1", type: "command_execution", command: "printf 3", aggregated_output: "3\n", exit_code: 0 }, { toolCallId: "c1" }),
  ], "CODEX");
  assert.equal(counts.messages, 0);
  assert.deepEqual(files, [{ path: "/repo/b.ts", count: 1 }]);
  assert.equal((items.at(-1) as { result: string }).result, "3\n");
});

test("PI: the captured turn pair yields exactly one text item", () => {
  const { items, counts } = run([
    event("MODEL_COMPLETED", PI_THINKING_TURN),
    event("MODEL_COMPLETED", { ...PI_THINKING_TURN, type: "turn_end" }),
    event("MODEL_COMPLETED", PI_TEXT_MESSAGE),
    event("MODEL_COMPLETED", PI_TEXT_TURN_END),
  ], "PI");
  // [thinking, toolCall] contributes none; the text message contributes one and
  // its turn_end echo (same message.timestamp) is suppressed.
  assert.equal(counts.messages, 1);
  assert.equal((items[0] as { text: string }).text, "3");
});

test("PI dedup does not eat a genuine repeated message", () => {
  const repeat = (timestamp: number) => event("MODEL_COMPLETED", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp },
  });
  assert.equal(run([repeat(1), repeat(2)], "PI").counts.messages, 2);
  // No identity at all means no dedup either.
  const anonymous = () => event("MODEL_COMPLETED", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
  assert.equal(run([anonymous(), anonymous()], "PI").counts.messages, 2);
});

test("PI: tool result content is extracted, isError drives the red marker, non-assistant roles are ignored", () => {
  const ok = run([event("TOOL_STARTED", PI_TOOL_START, { toolCallId: "call_GHK5" }), event("TOOL_COMPLETED", PI_TOOL_END, { toolCallId: "call_GHK5" })], "PI");
  const tool = ok.items[0] as { primaryArg: string; state: string; result: string };
  assert.equal(tool.primaryArg, "printf 3");
  assert.equal(tool.state, "ok");
  assert.equal(tool.result, "3");

  const failed = run([event("TOOL_COMPLETED", { ...PI_TOOL_END, isError: true }, { toolCallId: "call_GHK5" })], "PI");
  assert.equal((failed.items[0] as { state: string }).state, "error");

  const user = run([event("MODEL_COMPLETED", { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } })], "PI");
  assert.equal(user.items.length, 0);
});

test("ADAPTER_ERROR becomes an inline error item in stream order", () => {
  const { items } = run([
    event("MODEL_DELTA", CLAUDE_TEXT_ASSISTANT),
    event("ADAPTER_ERROR", { type: "error", message: "stream disconnected" }),
    event("MODEL_DELTA", CLAUDE_TEXT_ASSISTANT),
  ], "CLAUDE");
  assert.deepEqual(items.map((item) => item.kind), ["text", "error", "text"]);
  assert.equal((items[1] as { message: string }).message, "stream disconnected");
});

test("ADAPTER_ERROR falls back through error, error.message, then compact JSON", () => {
  const invalidJson = run([event("ADAPTER_ERROR", { error: "invalid-json", line: "not json" })], "CLAUDE");
  assert.equal((invalidJson.items[0] as { message: string }).message, "invalid-json");

  const nested = run([event("ADAPTER_ERROR", { error: { message: "boom" } })], "CODEX");
  assert.equal((nested.items[0] as { message: string }).message, "boom");

  const neither = run([event("ADAPTER_ERROR", { code: 7 })], "PI");
  assert.equal((neither.items[0] as { message: string }).message, '{"code":7}');
});

test("counts derive from rendered items: orphans count, duplicates do not, keyless events stay distinct", () => {
  const orphan = run([event("TOOL_COMPLETED", CLAUDE_TOOL_RESULT, { toolCallId: "orphan-1" })], "CLAUDE");
  assert.equal(orphan.counts.toolCalls, 1);
  assert.equal(orphan.items.length, 1);
  assert.equal((orphan.items[0] as { args: unknown }).args, null);

  const duplicate = run([
    event("TOOL_STARTED", CLAUDE_TOOL_USE, { toolCallId: "dup" }),
    event("TOOL_COMPLETED", CLAUDE_TOOL_RESULT, { toolCallId: "dup" }),
    event("TOOL_COMPLETED", { ...CLAUDE_TOOL_RESULT, content: "later", is_error: true }, { toolCallId: "dup" }),
  ], "CLAUDE");
  assert.equal(duplicate.counts.toolCalls, 1);
  assert.equal((duplicate.items[0] as { result: string; state: string }).result, "later");
  assert.equal((duplicate.items[0] as { state: string }).state, "error");

  const keyless = run([
    event("TOOL_COMPLETED", CLAUDE_TOOL_RESULT),
    event("TOOL_COMPLETED", CLAUDE_TOOL_RESULT),
  ], "CLAUDE");
  assert.equal(keyless.counts.toolCalls, 2);
});

test("an unfinished tool reads running while live and incomplete once terminal", () => {
  const started = [event("TOOL_STARTED", CLAUDE_TOOL_USE, { toolCallId: "live" })];
  assert.equal((run(started, "CLAUDE", false).items[0] as { state: string }).state, "running");
  assert.equal((run(started, "CLAUDE", true).items[0] as { state: string }).state, "incomplete");
});

test("FINAL_OUTPUT builds a Result card for CLAUDE and CODEX but never for PI", () => {
  const claude = run([event("FINAL_OUTPUT", { type: "result", result: "all done", total_cost_usd: 0.1 })], "CLAUDE");
  assert.equal(claude.items.length, 1);
  assert.equal((claude.items[0] as { kind: string; text: string }).text, "all done");

  const codex = run([
    event("MODEL_DELTA", { type: "item.completed", item: { id: "m1", type: "agent_message", text: "3" } }),
    event("FINAL_OUTPUT", { type: "turn.completed", usage: { input_tokens: 1 } }),
  ], "CODEX");
  assert.deepEqual(codex.items.map((item) => item.kind), ["text", "final"]);

  // agent_settled is literally {"type":"agent_settled"} — no text anywhere.
  const pi = run([event("FINAL_OUTPUT", { type: "agent_settled" })], "PI");
  assert.equal(pi.items.length, 0);
});

test("noise event types produce no items", () => {
  const noise = ["PROVIDER_RAW", "PROVIDER_STATUS", "STDERR", "MODEL_STARTED", "TOOL_PROGRESS", "PROCESS_STARTED", "SOMETHING_NEW"];
  for (const runner of ["CLAUDE", "CODEX", "PI"] as const) {
    const { items, counts } = run(noise.map((type) => event(type, CLAUDE_TEXT_ASSISTANT)), runner);
    assert.equal(items.length, 0, `${runner} ${items.length}`);
    assert.deepEqual(counts, { messages: 0, toolCalls: 0, files: 0 });
  }
});

test("normalize is total over malformed payloads", () => {
  const types = ["MODEL_DELTA", "MODEL_COMPLETED", "TOOL_STARTED", "TOOL_COMPLETED", "ADAPTER_ERROR", "FINAL_OUTPUT"];
  for (const runner of ["CLAUDE", "CODEX", "PI"] as const) {
    for (const payload of [null, 42, "text", [], {}, { message: null }, { item: 7 }, { args: "x" }]) {
      assert.doesNotThrow(() => run(types.map((type) => event(type, payload)), runner), `${runner} ${JSON.stringify(payload)}`);
    }
  }
});

test("files are alphabetical and carry per-path touch counts", () => {
  const { files } = run([
    event("TOOL_STARTED", { type: "tool_use", id: "1", name: "Read", input: { file_path: "/z.ts" } }, { toolCallId: "1" }),
    event("TOOL_STARTED", { type: "tool_use", id: "2", name: "Edit", input: { file_path: "/a.ts" } }, { toolCallId: "2" }),
    event("TOOL_STARTED", { type: "tool_use", id: "3", name: "Edit", input: { file_path: "/a.ts" } }, { toolCallId: "3" }),
  ], "CLAUDE");
  assert.deepEqual(files, [{ path: "/a.ts", count: 2 }, { path: "/z.ts", count: 1 }]);
});

test("the projection groups only maximal consecutive tool runs", () => {
  const first = event("TOOL_STARTED", { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/a.ts" } }, {
    toolCallId: "read-1", at: "2026-08-15T10:00:00.000Z",
  });
  const second = event("TOOL_COMPLETED", { tool_use_id: "read-1", content: "a", is_error: false }, {
    toolCallId: "read-1", at: "2026-08-15T10:00:01.000Z",
  });
  const third = event("TOOL_STARTED", { type: "tool_use", id: "run-1", name: "Bash", input: { command: "npm test" } }, {
    toolCallId: "run-1", at: "2026-08-15T10:00:02.000Z",
  });
  const fourth = event("TOOL_COMPLETED", { tool_use_id: "run-1", content: "ok", is_error: false }, {
    toolCallId: "run-1", at: "2026-08-15T10:00:03.000Z",
  });
  const message = event("MODEL_DELTA", CLAUDE_TEXT_ASSISTANT, { at: "2026-08-15T10:00:04.000Z" });
  const fifth = event("TOOL_STARTED", { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "/b.ts" } }, {
    toolCallId: "edit-1", at: "2026-08-15T10:00:05.000Z",
  });

  const { nodes } = projectStream([first, second, third, fourth, message, fifth], "CLAUDE", false);
  assert.deepEqual(nodes.map((node) => node.kind), ["tools", "text", "tools"]);
  assert.equal(nodes[0]?.kind, "tools");
  if (nodes[0]?.kind === "tools") {
    assert.equal(nodes[0].calls.length, 2);
    assert.equal(nodes[0].at, first.at);
    assert.deepEqual(nodes[0].calls.map((call) => call.name), ["Read", "Bash"]);
  }
  assert.equal(nodes[2]?.kind, "tools");
  if (nodes[2]?.kind === "tools") assert.deepEqual(nodes[2].calls.map((call) => call.name), ["Edit"]);
});

test("projection merges consecutive assistant prose with the earliest timestamp", () => {
  const first = event("MODEL_DELTA", CLAUDE_TEXT_ASSISTANT, { at: "2026-08-15T10:00:00.000Z" });
  const second = event("MODEL_DELTA", {
    type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "second paragraph" }] },
  }, { at: "2026-08-15T10:00:01.000Z" });

  const { nodes, counts } = projectStream([first, second], "CLAUDE", false);
  assert.equal(nodes.length, 1);
  assert.deepEqual(nodes[0], {
    kind: "text", id: first.id, at: first.at, text: "3\n\nsecond paragraph", final: false,
  });
  assert.deepEqual(counts, { messages: 1, toolCalls: 0, files: 0 });
});

test("projection does not merge prose separated by a tool call", () => {
  const first = event("MODEL_DELTA", CLAUDE_TEXT_ASSISTANT);
  const tool = event("TOOL_STARTED", {
    type: "tool_use", id: "read-between", name: "Read", input: { file_path: "/a.ts" },
  }, { toolCallId: "read-between" });
  const second = event("MODEL_DELTA", {
    type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "after tool" }] },
  });

  const { nodes } = projectStream([first, tool, second], "CLAUDE", false);
  assert.deepEqual(nodes.map((node) => node.kind), ["text", "tools", "text"]);
  assert.equal(nodes[0]?.kind, "text");
  assert.equal(nodes[2]?.kind, "text");
  if (nodes[0]?.kind === "text" && nodes[2]?.kind === "text") {
    assert.equal(nodes[0].text, "3");
    assert.equal(nodes[2].text, "after tool");
  }
});

test("projection drops empty and whitespace-only assistant prose", () => {
  const events = [
    event("MODEL_DELTA", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "   \n\t" }] } }),
    event("MODEL_DELTA", CLAUDE_TEXT_ASSISTANT),
    event("MODEL_DELTA", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "" }] } }),
  ];
  const { nodes } = projectStream(events, "CLAUDE", false);
  assert.deepEqual(nodes.map((node) => node.kind), ["text"]);
  if (nodes[0]?.kind === "text") assert.equal(nodes[0].text, "3");
});

test("projection drops a repeated final output but keeps a distinct final output", () => {
  const repeated = projectStream([
    event("MODEL_DELTA", CLAUDE_TEXT_ASSISTANT),
    event("FINAL_OUTPUT", { type: "result", result: "3" }),
  ], "CLAUDE", true);
  assert.deepEqual(repeated.nodes.map((node) => node.kind), ["text"]);
  assert.equal(repeated.nodes[0]?.kind, "text");
  if (repeated.nodes[0]?.kind === "text") assert.equal(repeated.nodes[0].final, false);

  const distinct = projectStream([
    event("MODEL_DELTA", CLAUDE_TEXT_ASSISTANT),
    event("FINAL_OUTPUT", { type: "result", result: "all done" }),
  ], "CLAUDE", true);
  assert.deepEqual(distinct.nodes.map((node) => node.kind), ["text", "text"]);
  assert.equal(distinct.nodes[1]?.kind, "text");
  if (distinct.nodes[1]?.kind === "text") {
    assert.equal(distinct.nodes[1].text, "all done");
    assert.equal(distinct.nodes[1].final, true);
  }
});

test("projection turns adapter and prompt-delivery failures into error markers in stream order", () => {
  const adapterError = event("ADAPTER_ERROR", { message: "stream disconnected" }, { source: "CLAUDE" });
  const promptFailure = event("PROMPT_DELIVERY_FAILED", { message: "broken pipe", code: "EPIPE" }, { source: "RUNNER" });
  const projection = projectStream([
    event("MODEL_DELTA", CLAUDE_TEXT_ASSISTANT),
    adapterError,
    event("MODEL_DELTA", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "after error" }] } }),
    promptFailure,
  ], "CLAUDE", true);

  assert.deepEqual(projection.nodes.map((node) => node.kind), ["text", "marker", "text", "marker"]);
  assert.equal(projection.nodes[1]?.kind, "marker");
  assert.equal(projection.nodes[3]?.kind, "marker");
  if (projection.nodes[1]?.kind === "marker" && projection.nodes[3]?.kind === "marker") {
    assert.deepEqual(projection.nodes[1], {
      kind: "marker", id: adapterError.id, at: adapterError.at, variant: "error", text: "stream disconnected",
    });
    assert.deepEqual(projection.nodes[3], {
      kind: "marker", id: promptFailure.id, at: promptFailure.at, variant: "error", text: "broken pipe",
    });
  }
});

test("projection marks only the second and later process starts as resume boundaries", () => {
  const starts = [
    event("PROCESS_STARTED", {}, { source: "RUNNER" }),
    event("MODEL_DELTA", CLAUDE_TEXT_ASSISTANT),
    event("PROCESS_STARTED", {}, { source: "RUNNER" }),
    event("MODEL_DELTA", { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "resumed" }] } }),
  ];
  const projection = projectStream(starts, "CLAUDE", true);
  assert.deepEqual(projection.nodes.map((node) => node.kind), ["text", "marker", "text"]);
  assert.equal(projection.nodes[1]?.kind, "marker");
  if (projection.nodes[1]?.kind === "marker") {
    assert.equal(projection.nodes[1].variant, "info");
    assert.equal(projection.nodes[1].text, "sessions.stream.resumed");
  }
});

test("projection counts derive from the nodes it returns", () => {
  const events = [
    event("MODEL_DELTA", CLAUDE_TEXT_ASSISTANT),
    event("TOOL_STARTED", { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/a.ts" } }, { toolCallId: "read-1" }),
    event("TOOL_COMPLETED", { tool_use_id: "read-1", content: "a", is_error: false }, { toolCallId: "read-1" }),
    event("TOOL_STARTED", { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "/b.ts" } }, { toolCallId: "edit-1" }),
    event("TOOL_COMPLETED", { tool_use_id: "edit-1", content: "b", is_error: false }, { toolCallId: "edit-1" }),
    event("FINAL_OUTPUT", { type: "result", result: "done" }),
  ];
  const projection = projectStream(events, "CLAUDE", true);
  assert.deepEqual(projection.counts, { messages: 2, toolCalls: 2, files: 2 });
  assert.equal(projection.nodes.filter((node) => node.kind === "text").length, projection.counts.messages);
  assert.equal(projection.nodes.filter((node) => node.kind === "tools").reduce((sum, node) => sum + node.calls.length, 0), projection.counts.toolCalls);
  assert.equal(projection.files.length, projection.counts.files);
});

test("projection drops noise, unknown events and malformed payloads without throwing", () => {
  const noise = ["MODEL_STARTED", "PROVIDER_STATUS", "PROVIDER_RAW", "STDERR", "TOOL_PROGRESS", "PROCESS_STARTED", "NOT_A_REAL_EVENT"];
  const malformed = [null, 42, "text", []];
  for (const runner of ["CLAUDE", "CODEX", "PI"] as const) {
    const events = noise.map((type) => event(type, { unexpected: true }));
    for (const payload of malformed) events.push(event("MODEL_DELTA", payload));
    events.push(event("MODEL_COMPLETED", null), event("TOOL_STARTED", null), event("TOOL_COMPLETED", null), event("FINAL_OUTPUT", null));
    assert.doesNotThrow(() => projectStream(events, runner, true), runner);
    const projection = projectStream(events, runner, true);
    assert.deepEqual(projection.nodes, [], runner);
    assert.deepEqual(projection.counts, { messages: 0, toolCalls: 0, files: 0 }, runner);
  }
});

test("line clamp keeps the first N lines and reports withheld lines", () => {
  assert.deepEqual(clampLines("one\ntwo\nthree\nfour", 2), { text: "one\ntwo", dropped: 2 });
  const short = "one\ntwo";
  assert.deepEqual(clampLines(short, 2), { text: short, dropped: 0 });
  assert.equal(TOOL_OUTPUT_MAX_LINES, 40);
  assert.equal(TEXT_NODE_MAX_LINES, 12);
});
