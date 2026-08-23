/** AgentOS tools for pi.
 *
 *  pi deliberately ships no MCP client ("It intentionally does not include
 *  built-in MCP..."), so the same four AgentOS tools are registered as pi
 *  extension tools instead. The runner injects this file with `--extension`;
 *  credentials come from the inherited environment, exactly as the MCP server
 *  reads them, so the tool surface matches across all three CLIs.
 *
 *  Loaded by pi's own loader, not compiled by the runner's tsc — keep it
 *  dependency-free and self-contained. */

import { execFileSync } from "node:child_process";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

const credentials = () => {
  const apiUrl = process.env.AGENTOS_API_URL;
  const runId = process.env.AGENTOS_RUN_ID;
  const sessionToken = process.env.AGENTOS_SESSION_TOKEN;
  const fencingToken = process.env.AGENTOS_FENCING_TOKEN;
  const workspacePath = process.env.AGENTOS_WORKSPACE_PATH;
  if (!apiUrl || !runId || !sessionToken || !fencingToken || !workspacePath) {
    throw new Error("AgentOS session credentials are missing from this environment");
  }
  return { apiUrl: apiUrl.replace(/\/$/, ""), runId, sessionToken, fencingToken, workspacePath };
};

const workspaceHead = (): string => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: credentials().workspacePath,
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(head)) throw new Error(`Workspace HEAD is not a commit SHA: ${head}`);
  return head;
};

const call = async (method: string, path: string, body?: Record<string, unknown>): Promise<unknown> => {
  const session = credentials();
  const response = await fetch(`${session.apiUrl}/session/runs/${session.runId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${session.sessionToken}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify({ fencingToken: session.fencingToken, ...body }) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`AgentOS API ${response.status}: ${text.slice(0, 500)}`);
  return text.length > 0 ? JSON.parse(text) : null;
};

const said = (text: string): ToolResult => ({ content: [{ type: "text", text }], details: {} });

export default function (pi: {
  registerTool(tool: Record<string, unknown>): void;
  on(
    event: "before_provider_request",
    handler: (
      event: { type: "before_provider_request"; payload: unknown },
      context: { model?: { provider?: string }; abort(): void; shutdown(): void },
    ) => unknown,
  ): void;
}): void {
  pi.on("before_provider_request", (event, context) => {
    const provider = context.model?.provider;
    const expectsOpenAICodex = process.env.AGENTOS_PI_EXPECTS_OPENAI_CODEX === "1";
    if (provider !== "openai-codex") {
      if (!expectsOpenAICodex) return undefined;
      context.abort();
      context.shutdown();
      return { service_tier: "agentos-provider-mismatch" };
    }
    const configured = process.env.AGENTOS_CODEX_SERVICE_TIER;
    if (configured !== "default" && configured !== "fast") {
      context.abort();
      context.shutdown();
      return { service_tier: "agentos-invalid-service-tier" };
    }
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      context.abort();
      context.shutdown();
      return { service_tier: "agentos-invalid-payload" };
    }
    return {
      ...event.payload,
      // The Responses API reports Fast as `priority`; the AgentOS setting stays
      // `fast` because that is the operator-facing Codex config vocabulary.
      service_tier: configured === "fast" ? "priority" : "default",
    };
  });

  pi.registerTool({
    name: "task_activity_log",
    label: "AgentOS activity",
    description: "Record notable progress on the current AgentOS task. Routine progress channel; it never interrupts a human.",
    promptSnippet: "Record progress on the current AgentOS task",
    promptGuidelines: ["Use task_activity_log to record notable progress instead of narrating it only in your final answer."],
    parameters: {
      type: "object",
      properties: {
        body: { type: "string", description: "What happened, in one or two sentences." },
        metadata: { type: "object", description: "Optional structured detail.", additionalProperties: true },
      },
      required: ["body"],
    },
    async execute(_toolCallId: string, params: { body: string; metadata?: Record<string, unknown> }): Promise<ToolResult> {
      await call("POST", "/activity", { actorType: "agent", body: params.body, ...(params.metadata ? { metadata: params.metadata } : {}) });
      return said("Activity recorded.");
    },
  });

  pi.registerTool({
    name: "task_output",
    label: "AgentOS output",
    description: "Persist this step's deliverable as the AgentOS task output. Later chain steps read it and the approval gate shows it to the human.",
    promptSnippet: "Persist the deliverable as the AgentOS task output",
    promptGuidelines: ["Use task_output to persist the final deliverable before you finish; a deliverable that is only in your answer is not delivered."],
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Output kind, e.g. spec, plan, review, result." },
        body: { type: "string", description: "The deliverable itself, in full." },
        metadata: { type: "object", description: "Optional structured detail.", additionalProperties: true },
      },
      required: ["kind", "body"],
    },
    async execute(_toolCallId: string, params: { kind: string; body: string; metadata?: Record<string, unknown> }): Promise<ToolResult> {
      const persisted = await call("PUT", "/output", {
        kind: params.kind,
        body: params.body,
        commitSha: workspaceHead(),
        ...(params.metadata ? { metadata: params.metadata } : {}),
      }) as { predecessorOutputs?: unknown } | null;
      const predecessorOutputs = persisted?.predecessorOutputs;
      return said([
        `Output persisted as '${params.kind}' (${params.body.length} characters).`,
        ...(Array.isArray(predecessorOutputs) && predecessorOutputs.length > 0
          ? ["Predecessor step outputs are now available:", JSON.stringify(predecessorOutputs, null, 2)]
          : []),
      ].join("\n\n"));
    },
  });

  pi.registerTool({
    name: "task_status",
    label: "AgentOS status",
    description: "Read the current AgentOS task and run: status, approval gate, run number and budget, branch, and whether an output exists.",
    promptSnippet: "Read the current AgentOS task and run status",
    parameters: { type: "object", properties: {} },
    async execute(): Promise<ToolResult> {
      return said(JSON.stringify(await call("GET", "/status"), null, 2));
    },
  });

  pi.registerTool({
    name: "inbox_ask",
    label: "AgentOS inbox",
    description: "Ask the human a question through the AgentOS Inbox. SUSPENDS this session until they answer; you resume in place with their reply.",
    promptSnippet: "Ask the human a blocking question through the AgentOS Inbox",
    promptGuidelines: ["Use inbox_ask only when genuinely blocked; finish everything that does not depend on the answer first."],
    parameters: {
      type: "object",
      properties: {
        body: { type: "string", description: "The question, with enough context to answer it cold." },
        choices: {
          type: "array",
          description: "Optional fixed choices; omit for free text.",
          items: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" } },
            required: ["id", "label"],
          },
        },
      },
      required: ["body"],
    },
    async execute(_toolCallId: string, params: { body: string; choices?: Array<{ id: string; label: string }> }): Promise<ToolResult> {
      await call("POST", "/inbox/questions", {
        requestId: `pi:${credentials().runId}:${params.body.slice(0, 80)}`,
        body: params.body,
        choices: params.choices ?? [],
      });
      return said("Question sent. This session is suspended until the human answers.");
    },
  });
}
