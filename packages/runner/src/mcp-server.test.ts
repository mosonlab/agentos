import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import test from "node:test";

import { handleRequest, invokeTool, readCredentials, TOOLS, type SessionCredentials } from "./mcp-server.js";

type Received = { method: string; url: string; authorization: string | undefined; body: string };

const withApi = async (
  respond: (received: Received) => { status: number; body: string },
  callback: (credentials: SessionCredentials, received: Received[]) => Promise<void>,
): Promise<void> => {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const hit = { method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization, body };
      received.push(hit);
      const reply = respond(hit);
      response.writeHead(reply.status, { "Content-Type": "application/json" });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await callback({
      apiUrl: `http://127.0.0.1:${port}`,
      runId: "run-1",
      sessionToken: "agos_session_test",
      fencingToken: "1:run-1:token",
    }, received);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

test("the MCP handshake advertises the four AgentOS tools", async () => {
  const credentials = { apiUrl: "http://unused", runId: "run-1", sessionToken: "t", fencingToken: "f" };
  const initialize = await handleRequest(credentials, {
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" },
  });
  // The client's protocol version is echoed when supported, else ours.
  assert.equal((initialize?.result as Record<string, unknown>).protocolVersion, "2024-11-05");
  const listed = await handleRequest(credentials, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(
    ((listed?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name),
    ["task_activity_log", "task_output", "task_status", "inbox_ask"],
  );
  assert.equal(TOOLS.length, 4);
  // Notifications never get a reply.
  assert.equal(await handleRequest(credentials, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("tools carry the session token and fencing token to the session endpoints", async () => {
  await withApi(() => ({ status: 200, body: JSON.stringify({ ok: true }) }), async (credentials, received) => {
    await invokeTool(credentials, "task_output", { kind: "spec", body: "the deliverable" });
    await invokeTool(credentials, "task_activity_log", { body: "made progress" });
    assert.deepEqual(received.map((hit) => `${hit.method} ${hit.url}`), [
      "PUT /session/runs/run-1/output",
      "POST /session/runs/run-1/activity",
    ]);
    assert.ok(received.every((hit) => hit.authorization === "Bearer agos_session_test"));
    assert.ok(received.every((hit) => JSON.parse(hit.body).fencingToken === "1:run-1:token"));
  });
});

test("an API rejection is reported to the model rather than breaking the protocol", async () => {
  await withApi(() => ({ status: 409, body: JSON.stringify({ error: "Stale fencing token" }) }), async (credentials) => {
    const response = await handleRequest(credentials, {
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "task_output", arguments: { kind: "spec", body: "x" } },
    });
    const result = response?.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /409/);
    assert.equal(response?.error, undefined);
  });
});

test("credentials come from the environment or the file, and missing ones are named", () => {
  const environment = {
    AGENTOS_API_URL: "http://api/", AGENTOS_RUN_ID: "run-1",
    AGENTOS_SESSION_TOKEN: "token", AGENTOS_FENCING_TOKEN: "fence",
  };
  assert.deepEqual(readCredentials(environment), {
    apiUrl: "http://api", runId: "run-1", sessionToken: "token", fencingToken: "fence",
  });
  assert.throws(() => readCredentials({ AGENTOS_RUN_ID: "run-1" }), /AGENTOS_API_URL, AGENTOS_SESSION_TOKEN, AGENTOS_FENCING_TOKEN/);
});
