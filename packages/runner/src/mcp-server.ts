/** AgentOS MCP server (stdio).
 *
 *  Spawned by the CLI the runner starts, not by the runner itself, so it never
 *  sees a token the agent does not already hold: credentials arrive through the
 *  inherited child environment (AGENTOS_API_URL / AGENTOS_SESSION_TOKEN /
 *  AGENTOS_RUN_ID / AGENTOS_FENCING_TOKEN) and never through argv, where any
 *  local process could read them.
 *
 *  Hand-rolled JSON-RPC rather than the MCP SDK: the runner package ships with
 *  no runtime dependencies, and the surface here is eight tools. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, "2025-03-26", "2024-11-05"]);
const SERVER_INFO = { name: "agentos", title: "AgentOS", version: "1.0.0" };

export type SessionCredentials = {
  apiUrl: string;
  runId: string;
  sessionToken: string;
  fencingToken: string;
  workspacePath: string;
};

const credentialsFile = (argv: string[]): Record<string, unknown> => {
  const at = argv.indexOf("--credentials");
  const path = at >= 0 ? argv[at + 1] : undefined;
  if (!path) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
};

/**
 * Credentials come from the environment where the CLI passes it through (claude,
 * pi) and from a 0600 file next to the workspace where it does not: codex spawns
 * MCP servers with a scrubbed environment (only PATH/HOME/USER survive). The
 * file path is safe in argv; the tokens themselves never are.
 */
export const readCredentials = (environment: NodeJS.ProcessEnv, argv: string[] = []): SessionCredentials => {
  const file = argv.length > 0 ? credentialsFile(argv) : {};
  const apiUrl = environment.AGENTOS_API_URL ?? asString(file.apiUrl) ?? undefined;
  const runId = environment.AGENTOS_RUN_ID ?? asString(file.runId) ?? undefined;
  const sessionToken = environment.AGENTOS_SESSION_TOKEN ?? asString(file.sessionToken) ?? undefined;
  const fencingToken = environment.AGENTOS_FENCING_TOKEN ?? asString(file.fencingToken) ?? undefined;
  const workspacePath = environment.AGENTOS_WORKSPACE_PATH ?? asString(file.workspacePath) ?? undefined;
  const missing = [
    ...(apiUrl ? [] : ["AGENTOS_API_URL"]),
    ...(runId ? [] : ["AGENTOS_RUN_ID"]),
    ...(sessionToken ? [] : ["AGENTOS_SESSION_TOKEN"]),
    ...(fencingToken ? [] : ["AGENTOS_FENCING_TOKEN"]),
    ...(workspacePath ? [] : ["AGENTOS_WORKSPACE_PATH"]),
  ];
  if (missing.length > 0) throw new Error(`AgentOS MCP server is missing ${missing.join(", ")}`);
  return {
    apiUrl: apiUrl!.replace(/\/$/, ""),
    runId: runId!,
    sessionToken: sessionToken!,
    fencingToken: fencingToken!,
    workspacePath: workspacePath!,
  };
};

const workspaceHead = (credentials: SessionCredentials): string => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: credentials.workspacePath,
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(head)) {
    throw new Error(`Workspace HEAD is not a commit SHA: ${head}`);
  }
  return head;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

const asString = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value : null;

export const TOOLS = [
  {
    name: "task_activity_log",
    title: "Append to the task activity log",
    description: "Record notable progress on the current AgentOS task. This is the routine progress channel — "
      + "it never interrupts a human. Use it whenever you finish a meaningful step or make a decision worth auditing.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "What happened, in one or two sentences." },
        metadata: { type: "object", description: "Optional structured detail stored alongside the entry.", additionalProperties: true },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  {
    name: "task_output",
    title: "Persist the task output",
    description: "Persist this step's deliverable as the AgentOS task output. Later steps in the chain read it, and "
      + "the approval gate shows it to the human. Call it once the deliverable is final; calling it again replaces the stored output.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Output kind, e.g. spec, plan, review, result." },
        body: { type: "string", description: "The deliverable itself, in full." },
        metadata: { type: "object", description: "Optional structured detail, e.g. branch or commit.", additionalProperties: true },
      },
      required: ["kind", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "task_status",
    title: "Read the task and run status",
    description: "Read the current AgentOS task and run: name, status, approval gate, run number and budget, branch, "
      + "and whether an output has already been persisted.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "inbox_ask",
    title: "Ask the human a question",
    description: "Ask the human a question through the AgentOS Inbox. This SUSPENDS the session until they answer, and "
      + "you resume in place with their reply — so finish everything that does not depend on the answer first. "
      + "Routine progress belongs in task_activity_log, not here.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "The question, with enough context for a human to answer it cold." },
        choices: {
          type: "array",
          description: "Optional fixed choices. Omit for a free-text question.",
          items: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" } },
            required: ["id", "label"],
            additionalProperties: false,
          },
        },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  {
    name: "files_list",
    title: "List files",
    description: "List one granted Files Root directory non-recursively.",
    inputSchema: {
      type: "object",
      properties: { dir: { type: "string", description: "Files-Root-relative POSIX directory path; empty means root." } },
      required: ["dir"], additionalProperties: false,
    },
  },
  {
    name: "files_read",
    title: "Read a file",
    description: "Read one granted file; binary content is returned with encoding base64.",
    inputSchema: {
      type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
    },
  },
  {
    name: "files_write",
    title: "Write a file",
    description: "Write one granted file, creating parent directories as needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" }, content: { type: "string" }, encoding: { type: "string", enum: ["utf8", "base64"] },
      },
      required: ["path", "content"], additionalProperties: false,
    },
  },
  {
    name: "files_delete",
    title: "Delete a file",
    description: "Delete one granted file or empty directory.",
    inputSchema: {
      type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
    },
  },
] as const;

const call = async (
  credentials: SessionCredentials,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>,
): Promise<unknown> => {
  const url = new URL(`/session/runs/${credentials.runId}${path}`, credentials.apiUrl);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${credentials.sessionToken}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`AgentOS API ${response.status}: ${text.slice(0, 500)}`);
  return text.length > 0 ? JSON.parse(text) as unknown : null;
};

export const invokeTool = async (
  credentials: SessionCredentials,
  name: string,
  rawArguments: Record<string, unknown>,
): Promise<ToolResult> => {
  const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
  if (name === "task_activity_log") {
    const body = asString(rawArguments.body);
    if (!body) throw new Error("task_activity_log requires a non-empty body");
    await call(credentials, "POST", "/activity", {
      fencingToken: credentials.fencingToken,
      actorType: "agent",
      body,
      ...(rawArguments.metadata ? { metadata: asRecord(rawArguments.metadata) } : {}),
    });
    return text("Activity recorded.");
  }
  if (name === "task_output") {
    const kind = asString(rawArguments.kind);
    const body = asString(rawArguments.body);
    if (!kind || !body) throw new Error("task_output requires kind and body");
    const persisted = await call(credentials, "PUT", "/output", {
      fencingToken: credentials.fencingToken,
      kind,
      body,
      commitSha: workspaceHead(credentials),
      ...(rawArguments.metadata ? { metadata: asRecord(rawArguments.metadata) } : {}),
    }) as { predecessorOutputs?: unknown } | null;
    const predecessorOutputs = persisted?.predecessorOutputs;
    return text([
      `Output persisted as '${kind}' (${body.length} characters).`,
      ...(Array.isArray(predecessorOutputs) && predecessorOutputs.length > 0
        ? ["Predecessor step outputs are now available:", JSON.stringify(predecessorOutputs, null, 2)]
        : []),
    ].join("\n\n"));
  }
  if (name === "task_status") {
    return text(JSON.stringify(await call(credentials, "GET", "/status"), null, 2));
  }
  if (name === "inbox_ask") {
    const body = asString(rawArguments.body);
    if (!body) throw new Error("inbox_ask requires a non-empty body");
    const choices = Array.isArray(rawArguments.choices)
      ? rawArguments.choices.flatMap((choice) => {
        const record = asRecord(choice);
        const choiceId = asString(record.id);
        const label = asString(record.label);
        return choiceId && label ? [{ id: choiceId, label }] : [];
      })
      : [];
    await call(credentials, "POST", "/inbox/questions", {
      fencingToken: credentials.fencingToken,
      // Idempotency key: a retried tool call must not queue a second question.
      requestId: `mcp:${credentials.runId}:${body.slice(0, 80)}`,
      body,
      choices,
    });
    return text("Question sent. This session is suspended until the human answers; you will resume with their reply.");
  }
  if (name === "files_list") {
    const dir = typeof rawArguments.dir === "string" ? rawArguments.dir : null;
    if (dir === null) throw new Error("files_list requires dir");
    return text(JSON.stringify(await call(credentials, "GET", "/files", undefined, { dir }), null, 2));
  }
  if (name === "files_read") {
    const path = asString(rawArguments.path);
    if (!path) throw new Error("files_read requires path");
    return text(JSON.stringify(await call(credentials, "GET", "/files/content", undefined, { path }), null, 2));
  }
  if (name === "files_write") {
    const path = asString(rawArguments.path);
    const content = typeof rawArguments.content === "string" ? rawArguments.content : null;
    const encoding = rawArguments.encoding === undefined ? "utf8" : rawArguments.encoding;
    if (!path || content === null || (encoding !== "utf8" && encoding !== "base64")) {
      throw new Error("files_write requires path, content, and optional encoding utf8 or base64");
    }
    return text(JSON.stringify(await call(credentials, "PUT", "/files/content", { path, content, encoding }), null, 2));
  }
  if (name === "files_delete") {
    const path = asString(rawArguments.path);
    if (!path) throw new Error("files_delete requires path");
    return text(JSON.stringify(await call(credentials, "DELETE", "/files", undefined, { path }), null, 2));
  }
  throw new Error(`Unknown tool ${name}`);
};

const write = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};

export const handleRequest = async (
  credentials: SessionCredentials,
  request: JsonRpcRequest,
): Promise<Record<string, unknown> | null> => {
  const isNotification = request.id === undefined || request.id === null;
  const respond = (result: Record<string, unknown>): Record<string, unknown> | null =>
    isNotification ? null : { id: request.id, result };
  if (request.method === "initialize") {
    const requested = asString(asRecord(request.params).protocolVersion);
    return respond({
      protocolVersion: requested && SUPPORTED_PROTOCOLS.has(requested) ? requested : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: "AgentOS control plane for the current task: log progress, persist the deliverable, read status, ask the human.",
    });
  }
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return null;
  if (request.method === "ping") return respond({});
  if (request.method === "tools/list") return respond({ tools: TOOLS });
  if (request.method === "tools/call") {
    const params = asRecord(request.params);
    const name = asString(params.name) ?? "";
    try {
      return respond(await invokeTool(credentials, name, asRecord(params.arguments)) as unknown as Record<string, unknown>);
    } catch (error: unknown) {
      // Tool failures are results, not protocol errors: the model must see them.
      return respond({
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      });
    }
  }
  if (isNotification) return null;
  return { id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
};

export const serve = (credentials: SessionCredentials, input: NodeJS.ReadableStream): void => {
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        write({ id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      void handleRequest(credentials, request)
        .then((message) => { if (message) write(message); })
        .catch((error: unknown) => {
          if (request.id === undefined || request.id === null) return;
          write({ id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
        });
    }
  });
};

// `node dist/mcp-server.js` is the command the CLIs are configured to spawn;
// importing this module from a test must not start reading stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve(readCredentials(process.env, process.argv.slice(2)), process.stdin);
}
