// Throwaway fixture control plane for the frontend-convergence baseline
// screenshots (W0). Lives outside the repo on purpose: it exists only so the
// pages render populated instead of showing a connection ErrorNotice, and it
// never touches the shared dev database.
import { createServer } from "node:http";

const iso = (offsetMinutes) => new Date(Date.UTC(2026, 7, 16, 9, 0, 0) - offsetMinutes * 60_000).toISOString();

const project = {
  id: "prj_agentos", name: "AgentOS", slug: "agentos",
  yamlDocument: "name: AgentOS\nslug: agentos\n", maxDurationMin: 120, stallTimeoutMin: 10,
  maxSessionsPerTask: 3, spendCap: "50.00", createdAt: iso(40000), updatedAt: iso(120),
};
const project2 = {
  id: "prj_herdr", name: "Herdr", slug: "herdr",
  yamlDocument: "name: Herdr\nslug: herdr\n", maxDurationMin: 90, stallTimeoutMin: 8,
  maxSessionsPerTask: 2, spendCap: null, createdAt: iso(30000), updatedAt: iso(900),
};

const environments = [
  { id: "env_default", projectId: project.id, name: "default", networking: "LIMITED", allowedHosts: ["api.anthropic.com", "github.com"] },
  { id: "env_open", projectId: project.id, name: "open-net", networking: "OPEN", allowedHosts: [] },
];

const repos = [
  { id: "repo_agentos", projectId: project.id, credentialSecretId: "sec_github", name: "agentos", remoteUrl: "https://github.com/mosonlab/agentos.git", mountPath: "agentos", defaultBranch: "main", createdAt: iso(40000), updatedAt: iso(600) },
  { id: "repo_docs", projectId: project.id, credentialSecretId: null, name: "handbook", remoteUrl: "https://github.com/mosonlab/handbook.git", mountPath: "handbook", defaultBranch: "main", createdAt: iso(20000), updatedAt: iso(4000) },
];

const skills = [
  { id: "skl_review", projectId: project.id, name: "Code review", slug: "code-review", kind: "PROMPT", body: "Review the diff for correctness.", filePath: null, updatedAt: iso(3000) },
  { id: "skl_dispatch", projectId: project.id, name: "Dispatch", slug: "dispatch", kind: "FILE", body: null, filePath: "skills/dispatch/SKILL.md", updatedAt: iso(5000) },
];

const mcpConnections = [
  { id: "mcp_files", projectId: project.id, credentialSecretId: null, name: "filesystem", transport: "stdio", config: { command: "agentos-files" }, allowedOperations: ["files_read", "files_write", "files_list"], createdAt: iso(9000), updatedAt: iso(500), agents: [{ agentId: "agt_frontend" }, { agentId: "agt_reviewer" }] },
  { id: "mcp_feishu", projectId: project.id, credentialSecretId: "sec_feishu", name: "feishu-inbox", transport: "sse", config: { url: "https://open.feishu.cn/mcp" }, allowedOperations: ["inbox_ask"], createdAt: iso(8000), updatedAt: iso(700), agents: [{ agentId: "agt_planner" }] },
  { id: "mcp_search", projectId: project.id, credentialSecretId: null, name: "web-search", transport: "http", config: { url: "https://search.internal/mcp" }, allowedOperations: ["search"], createdAt: iso(7000), updatedAt: iso(900), agents: [] },
];

const mkAgent = (id, name, title, model, pref, inbox) => ({
  id, projectId: project.id, environmentId: "env_default", name, title, model,
  foundationalPrompt: "You are an AgentOS worker. Stay inside the task's stated scope.",
  rolePrompt: `You are the ${title.toLowerCase()}. Implement the assigned work in the granted repo, then finish.`,
  runnerPreference: pref, inboxAccess: inbox, createdAt: iso(20000), updatedAt: iso(300), archivedAt: null,
  skills: [{ skillId: "skl_review", skill: skills[0] }],
  mcpConnections: [{ mcpConnectionId: "mcp_files", mcpConnection: mcpConnections[0] }],
  repoAccess: [{ agentId: id, repoId: "repo_agentos", projectId: project.id, mountPath: "agentos", permissions: "GIT_WRITE" }],
  secretGrants: [{ secretId: "sec_github", envVar: "GITHUB_TOKEN", secret: { id: "sec_github", name: "github-token", purpose: "REPO", description: null, ciphertextVersion: 1, keyId: "k1", rotatedAt: null, disabledAt: null, createdAt: iso(30000), updatedAt: iso(30000) } }],
  filesystemGrants: [{ id: `fsg_${id}`, agentId: id, folderPath: "docs", canRead: true, canWrite: true, canDelete: false }],
  collaborators: [{ allowedAgentId: "agt_reviewer" }],
});

const agents = [
  mkAgent("agt_frontend", "frontend-dev", "Frontend developer", "claude-opus-5", "CLAUDE", false),
  mkAgent("agt_reviewer", "code-reviewer", "Code reviewer", "claude-sonnet-5", "AUTO", false),
  mkAgent("agt_planner", "planner", "Planner", "claude-opus-5", "INHERIT", true),
];

const secrets = [
  { id: "sec_github", name: "github-token", purpose: "REPO", description: "Push access for the agentos remote", ciphertextVersion: 3, keyId: "key-2026-05", rotatedAt: iso(4000), disabledAt: null, createdAt: iso(30000), updatedAt: iso(4000), agentGrants: [{ agentId: "agt_frontend", envVar: "GITHUB_TOKEN", agent: { id: "agt_frontend", name: "frontend-dev" } }] },
  { id: "sec_feishu", name: "feishu-app-secret", purpose: "MCP", description: null, ciphertextVersion: 1, keyId: "key-2026-05", rotatedAt: null, disabledAt: null, createdAt: iso(25000), updatedAt: iso(25000), agentGrants: [] },
  { id: "sec_old", name: "legacy-webhook", purpose: "WEBHOOK", description: "Retired 2026-06", ciphertextVersion: 2, keyId: "key-2025-11", rotatedAt: iso(90000), disabledAt: iso(9000), createdAt: iso(120000), updatedAt: iso(9000), agentGrants: [] },
];

const mkRun = (id, taskId, n, status, extra = {}) => ({
  id, projectId: project.id, taskId, goalId: null, agentId: "agt_frontend", repoId: "repo_agentos",
  runNumber: n, status, runner: "CLAUDE", runnerId: "runner-local", model: "claude-opus-5",
  leaseGeneration: 1, workspacePath: `/Users/leohe/.agentos/runs/${id}`, workspaceRetained: false,
  targetBranch: "main", branch: `agentos/${id}/run-${n}`, baseSha: "3f712b5", headSha: "82b1de5",
  pushStatus: "PUSHED", pullRequestUrl: status === "SUCCEEDED" ? "https://github.com/mosonlab/agentos/pull/9" : null,
  maxDurationMin: 240, stallTimeoutMin: 10, maxRunsPerTask: 5,
  failureClass: null, failureReason: null, retryable: null, retryAt: null, terminationReason: null,
  queuedAt: iso(400), claimedAt: iso(398), startedAt: iso(397), endedAt: status === "RUNNING" ? null : iso(120),
  session: {
    id: `ses_${id}`, runId: id, projectId: project.id, taskId, goalId: null,
    agentId: "agt_frontend", runner: "CLAUDE",
    executionStatus: status === "RUNNING" ? "RUNNING" : "SUCCEEDED", cleanupStatus: "DONE",
    providerConversationId: "conv_1", waitingOnMessageId: null, resumeAttempt: 0,
    requestedAt: iso(399), startedAt: iso(397), endedAt: status === "RUNNING" ? null : iso(120),
    terminationReason: null, exitCode: status === "RUNNING" ? null : 0, costUsd: "1.42",
    // Null while the run is live: usage lands with FINAL_OUTPUT, so the Tokens
    // column shows both a real count and the `—` that means "never reported".
    ...(status === "RUNNING"
      ? { inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null }
      : { inputTokens: 4_820, outputTokens: 48_010, cachedInputTokens: 1_204_880, totalTokens: 52_830 }),
    failureReason: null,
  },
  ...extra,
});

const mkTask = (id, name, status, assigneeType, agentId, runs, description) => ({
  id, projectId: project.id, assigneeAgentId: agentId, repoId: "repo_agentos",
  templateId: "tpl_frontend", templateStepId: `tps_${id}`, followUpTaskId: null,
  name, description, workingDirectory: null, targetBranch: "main", failureReason: null,
  status, assigneeType, approvalGate: status === "REVIEW", scheduleKind: "NOW",
  maxDurationMin: 240, stallTimeoutMin: 10, maxSessionsPerTask: 5,
  createdAt: iso(2000), updatedAt: iso(100),
  assigneeAgent: agents.find((a) => a.id === agentId) ?? null,
  repo: repos[0], runs,
});

const tasks = [
  mkTask("tsk_spec", "Frontend SPEC: convergence onto shadcn/ui", "DONE", "AGENT", "agt_planner", [mkRun("run_spec", "tsk_spec", 1, "SUCCEEDED")], "Write the batch spec for retiring the legacy stylesheet.\n\nCover every legacy class selector and the acceptance checklist."),
  mkTask("tsk_plan", "Frontend PLAN: implementation plan", "DONE", "AGENT", "agt_planner", [mkRun("run_plan", "tsk_plan", 1, "SUCCEEDED")], "Produce the implementation plan against the approved spec."),
  mkTask("tsk_impl", "Frontend IMPLEMENT: convergence per the revised plan", "DOING", "AGENT", "agt_frontend", [mkRun("run_impl", "tsk_impl", 1, "RUNNING")], "Implement the revised plan at docs/plans/batch-frontend-convergence-plan.md.\n\nRun the tests that touch your changes and fix what you broke."),
  mkTask("tsk_review", "Frontend REVIEW: three-lens review of the implementation", "REVIEW", "AGENT", "agt_reviewer", [mkRun("run_review", "tsk_review", 1, "SUCCEEDED")], "Review the implementation against the spec, the plan, and the code."),
  mkTask("tsk_wiki", "Librarian: refresh the layering reference", "TODO", "AGENT", "agt_planner", [], "docs/reference/frontend-css-layering.md goes partly obsolete when the batch merges."),
  mkTask("tsk_gate", "Approve the frontend convergence batch", "TODO", "HUMAN", null, [], "Read the PR description and decide."),
  mkTask("tsk_failed", "Repair: stale dist ordering gap", "TODO", "AGENT", "agt_frontend", [mkRun("run_failed", "tsk_failed", 2, "FAILED", { failureClass: "TOOL_FAILED", failureReason: "npm run test exited 1", retryable: true })], "styles.test.tsx reads dist without detecting a stale artifact."),
];

const taskTemplates = [{
  id: "tpl_frontend", projectId: project.id, name: "Frontend chain",
  description: "Spec → plan → review → implement → review → apply → librarian",
  variables: ["batch", "branch"],
  steps: [
    { id: "tps_1", stepIndex: 0, name: "SPEC", assigneeType: "AGENT", prompt: "Write the spec for {{batch}}.", approvalGate: true, outputKind: "spec", runner: "CLAUDE", assigneeAgentId: "agt_planner", assigneeAgent: agents[2] },
    { id: "tps_2", stepIndex: 1, name: "PLAN", assigneeType: "AGENT", prompt: "Plan the implementation of {{batch}}.", approvalGate: true, outputKind: "plan", runner: "CLAUDE", assigneeAgentId: "agt_planner", assigneeAgent: agents[2] },
    { id: "tps_3", stepIndex: 2, name: "IMPLEMENT", assigneeType: "AGENT", prompt: "Implement {{batch}} on {{branch}}.", approvalGate: false, outputKind: "result", runner: "CLAUDE", assigneeAgentId: "agt_frontend", assigneeAgent: agents[0] },
  ],
}];

const goals = [
  {
    id: "goal_frontend", projectId: project.id, title: "Retire the legacy stylesheet",
    spec: "Every page in apps/web renders from shadcn/ui primitives and the design tokens, with no unlayered class rules left in styles.css.",
    dodApproved: true, status: "ACTIVE", spendCap: "40.00", spendUsd: "12.40",
    maxDurationMin: 240, stallTimeoutMin: 10, stuckThreshold: 19, runnerPreference: "CLAUDE",
    sharedFolderPath: "docs/plans", startedAt: iso(6000), endedAt: null, createdAt: iso(6200), updatedAt: iso(100),
    definitionOfDone: [
      { id: "dod_1", goalId: "goal_frontend", itemIndex: 0, text: "styles.css contains no class selector but .dark", done: false },
      { id: "dod_2", goalId: "goal_frontend", itemIndex: 1, text: "The layer test asserts zero unlayered class rules", done: false },
      { id: "dod_3", goalId: "goal_frontend", itemIndex: 2, text: "Baseline screenshots captured before the first code commit", done: true },
    ],
    progressLog: [
      { id: "gpl_1", goalId: "goal_frontend", sessionId: "ses_run_plan", body: "Plan rev 2 landed with the gate rulings threaded through.", createdAt: iso(400) },
      { id: "gpl_2", goalId: "goal_frontend", sessionId: "ses_run_impl", body: "Baseline captured; starting Section A.", createdAt: iso(110) },
    ],
  },
  {
    id: "goal_files", projectId: project.id, title: "Files path and authorization boundary",
    spec: "FilesystemGrant is enforced on every path the API resolves.",
    dodApproved: true, status: "COMPLETED", spendCap: null, spendUsd: "8.05",
    maxDurationMin: null, stallTimeoutMin: 10, stuckThreshold: 19, runnerPreference: "AUTO",
    sharedFolderPath: null, startedAt: iso(50000), endedAt: iso(9000), createdAt: iso(52000), updatedAt: iso(9000),
    definitionOfDone: [{ id: "dod_f1", goalId: "goal_files", itemIndex: 0, text: "Path traversal is rejected before the store is touched", done: true }],
    progressLog: [{ id: "gpl_f1", goalId: "goal_files", sessionId: null, body: "Merged as PR #9.", createdAt: iso(9000) }],
  },
  {
    id: "goal_stuck", projectId: project.id, title: "Runner lease renewal under clock skew",
    spec: "A runner whose clock drifts must not lose a lease it still holds.",
    dodApproved: false, status: "STOPPED_STUCK", spendCap: "20.00", spendUsd: "19.80",
    maxDurationMin: 120, stallTimeoutMin: 10, stuckThreshold: 19, runnerPreference: "CODEX",
    sharedFolderPath: null, startedAt: iso(70000), endedAt: iso(20000), createdAt: iso(71000), updatedAt: iso(20000),
    definitionOfDone: [], progressLog: [],
  },
];

const inboxMessages = [
  {
    id: "inb_gate", from: "AGENT", agentId: "agt_planner", sessionId: "ses_run_plan", taskId: "tsk_plan",
    goalId: "goal_frontend", gateTaskId: "tsk_plan", threadId: "thr_gate", replyToMessageId: null,
    kind: "MULTIPLE_CHOICE",
    body: "计划已就绪，请在闸门上裁决 §7 的两个开放问题。\n\n- **Q-1** 验收检查脚本是仓库产物还是只写在 PR 描述里？\n- **Q-2** spec assumption 4 是否维持外观 100% 不变？",
    choices: [{ id: "c1", label: "维持 assumption 4，检查脚本进仓库" }, { id: "c2", label: "收敛到 shadcn 默认几何" }],
    selectedChoiceId: null, status: "OPEN", channel: "FEISHU", deliveryStatus: "DELIVERED",
    deliveryAttempts: 1, lastDeliveryError: null, createdAt: iso(180), answeredAt: null,
    decisions: [], replies: [],
  },
  {
    id: "inb_q", from: "AGENT", agentId: "agt_frontend", sessionId: "ses_run_impl", taskId: "tsk_impl",
    goalId: null, gateTaskId: null, threadId: "thr_q", replyToMessageId: null, kind: "TEXT",
    body: "Section A 的 `shadow` 不对称要保留还是归一？两种都能通过验收。",
    choices: null, selectedChoiceId: null, status: "ANSWERED", channel: "FEISHU",
    deliveryStatus: "DELIVERED", deliveryAttempts: 1, lastDeliveryError: null,
    createdAt: iso(1200), answeredAt: iso(1100), decisions: [],
    replies: [{
      id: "inb_q_r", from: "HUMAN", agentId: null, sessionId: null, taskId: "tsk_impl", goalId: null,
      gateTaskId: null, threadId: "thr_q", replyToMessageId: "inb_q", kind: "TEXT",
      body: "保留。R-1 要求外观 100% 不变。", choices: null, selectedChoiceId: null,
      status: "CLOSED", channel: "FEISHU", deliveryStatus: "DELIVERED", deliveryAttempts: 1,
      lastDeliveryError: null, createdAt: iso(1100), answeredAt: iso(1100),
    }],
  },
  {
    id: "inb_old", from: "AGENT", agentId: "agt_reviewer", sessionId: null, taskId: "tsk_review",
    goalId: null, gateTaskId: null, threadId: "thr_old", replyToMessageId: null, kind: "TEXT",
    body: "评审完成，7 条 must-fix、3 条 should-fix。", choices: null, selectedChoiceId: null,
    status: "CLOSED", channel: "FEISHU", deliveryStatus: "FAILED", deliveryAttempts: 3,
    lastDeliveryError: "chat not found", createdAt: iso(5000), answeredAt: iso(4800),
    decisions: [], replies: [],
  },
];

const activity = [
  { id: "act_1", taskId: "tsk_impl", actorType: "AGENT", actorId: "agt_frontend", body: "Fast-forwarded the branch to the revised plan and calibrated the acceptance checker.", metadata: null, createdAt: iso(150) },
  { id: "act_2", taskId: "tsk_impl", actorType: "AGENT", actorId: "agt_frontend", body: "Captured the W0 baseline screenshots.", metadata: { files: 18 }, createdAt: iso(120) },
  { id: "act_3", taskId: "tsk_impl", actorType: "SYSTEM", actorId: null, body: "Run claimed by runner-local.", metadata: null, createdAt: iso(398) },
];

const output = { id: "out_impl", taskId: "tsk_impl", runId: "run_impl", kind: "result", body: "# Result\n\nSection A landed.\n\n1. `buttonVariants` gained four legacy variants\n2. `input`/`textarea` carry the legacy geometry\n\nSee `docs/plans/legacy-class-check.sh` for the acceptance sweep.", createdAt: iso(120), updatedAt: iso(110) };

// The real event vocabulary and the real CLAUDE payload shapes, so `normalize`
// (web/src/lib/session-stream.ts) actually produces a stream. The pre-batch
// fixtures used invented type names, which the raw Debug table rendered happily
// but the message stream normalizes to nothing — a session frame with an empty
// stream would document the wrong thing.
const mkEvent = (index, type, payload, toolCallId = null, source = "CLAUDE") => ({
  id: `evt_${index}`, sessionId: "ses_run_impl", runId: "run_impl", seq: index + 1,
  at: iso(400 - index * 12), source, type, toolCallId, payload,
});

const events = [
  mkEvent(0, "PROCESS_STARTED", { pid: 40_112 }, null, "RUNNER"),
  mkEvent(1, "MODEL_DELTA", { message: { content: [{ type: "text", text: "Reading the plan, then starting Section A.\n\nThe four legacy `buttonVariants` land first: they are what every other section links against." }] } }),
  mkEvent(2, "TOOL_STARTED", { id: "call_read", name: "Read", input: { file_path: "/Users/leohe/repo/apps/web/src/components/ui/button.tsx" } }, "call_read"),
  mkEvent(3, "TOOL_COMPLETED", { tool_use_id: "call_read", content: "export const buttonVariants = cva(…)  // 84 lines" }, "call_read"),
  mkEvent(4, "MODEL_DELTA", { message: { content: [{ type: "text", text: "`buttonVariants` already carries the shape. Adding the legacy variants:\n\n```ts\nlegacy: \"h-[26px] rounded-[5px] px-[9px] text-[12px]\",\n```\n\nSee the [plan](https://github.com/mosonlab/agentos/blob/main/docs/plans/batch-frontend-convergence-plan.md) for the full table." }] } }),
  mkEvent(5, "TOOL_STARTED", { id: "call_edit", name: "Edit", input: { file_path: "/Users/leohe/repo/apps/web/src/components/ui/button.tsx" } }, "call_edit"),
  mkEvent(6, "TOOL_COMPLETED", { tool_use_id: "call_edit", content: "Applied 1 edit." }, "call_edit"),
  mkEvent(7, "TOOL_STARTED", { id: "call_build", name: "Bash", input: { command: "npm run build -w @agentos/web" } }, "call_build"),
  mkEvent(8, "TOOL_COMPLETED", { tool_use_id: "call_build", content: "dist/assets/index-BhXLlOrV.css  43.55 kB\n✓ built in 1.74s" }, "call_build"),
  mkEvent(9, "TOOL_STARTED", { id: "call_test", name: "Bash", input: { command: "npm test -w @agentos/web" } }, "call_test"),
  // An error state, so the frame carries the red tool row too.
  mkEvent(10, "TOOL_COMPLETED", { tool_use_id: "call_test", content: "styles.test.tsx: 1 failing — read dist before build", is_error: true }, "call_test"),
  mkEvent(11, "PROVIDER_RAW", { line: "{\"type\":\"assistant\"}" }),
  // Never returns: reads `running` while live, `incomplete` once terminal.
  mkEvent(12, "TOOL_STARTED", { id: "call_open", name: "Edit", input: { file_path: "/Users/leohe/repo/apps/web/src/tests/styles.test.tsx" } }, "call_open"),
  mkEvent(13, "FINAL_OUTPUT", {
    type: "result", result: "Section A landed: the four legacy variants are in `buttonVariants` and the build is green.",
    total_cost_usd: 1.42,
    usage: { input_tokens: 4_820, output_tokens: 48_010, cache_read_input_tokens: 1_204_880, cache_creation_input_tokens: 0 },
  }),
];

// GET /sessions and /sessions/:id return the session with its relations
// attached (api/src/app.ts `sessionInclude`); the session nested inside a Run
// carries none of them, so the two shapes are built separately on purpose.
const sessions = tasks.flatMap((task) => task.runs.map((run) => ({
  ...run.session,
  agent: { id: run.agentId, title: agents.find((agent) => agent.id === run.agentId)?.title ?? "Agent" },
  task: { id: task.id, name: task.name },
  goal: null,
  run: {
    id: run.id, runNumber: run.runNumber, model: run.model, branch: run.branch,
    pullRequestUrl: run.pullRequestUrl, workspacePath: run.workspacePath,
    repo: { id: repos[0].id, name: repos[0].name, remoteUrl: repos[0].remoteUrl },
  },
})));

// The paged envelope GET /runs/:runId/events now returns. The harness serves
// the whole fixture in one page; the client tolerates a bare array too, but the
// reference frames should be shot against the shape the real API returns.
const eventEnvelope = (rows) => ({ events: rows, nextAfterSeq: rows.at(-1)?.seq ?? null, hasMore: false, total: rows.length });

const health = { status: "ok", database: "reachable", checkedAt: iso(0) };

const routes = new Map([
  ["/health", health],
  ["/projects", [project, project2]],
  [`/projects/${project.id}`, project],
  [`/projects/${project.id}/agents`, agents],
  [`/projects/${project.id}/environments`, environments],
  [`/projects/${project.id}/repos`, repos],
  [`/projects/${project.id}/skills`, skills],
  [`/projects/${project.id}/mcp-connections`, mcpConnections],
  [`/projects/${project.id}/goals`, goals],
  [`/projects/${project.id}/task-templates`, taskTemplates],
  ["/secrets", secrets],
  ["/inbox/messages", inboxMessages],
  ["/tasks", tasks],
  ["/tasks/tsk_impl", tasks[2]],
  ["/tasks/tsk_impl/activity", activity],
  ["/tasks/tsk_impl/output", output],
  ["/runs/run_impl/events", eventEnvelope(events)],
  ["/agents/agt_frontend", agents[0]],
  ["/sessions", sessions],
]);

for (const session of sessions) routes.set(`/sessions/${session.id}`, session);

for (const agent of agents) routes.set(`/agents/${agent.id}`, agent);
for (const goal of goals) routes.set(`/goals/${goal.id}`, goal);
for (const task of tasks) {
  routes.set(`/tasks/${task.id}`, task);
  if (!routes.has(`/tasks/${task.id}/activity`)) routes.set(`/tasks/${task.id}/activity`, activity.map((entry) => ({ ...entry, taskId: task.id })));
  if (!routes.has(`/tasks/${task.id}/output`)) routes.set(`/tasks/${task.id}/output`, { ...output, taskId: task.id });
  for (const run of task.runs) routes.set(`/runs/${run.id}/events`, eventEnvelope(events.map((event) => ({ ...event, runId: run.id, sessionId: `ses_${run.id}` }))));
}

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }

  let body = routes.get(url.pathname);
  if (url.pathname === "/tasks" && url.searchParams.has("projectId")) body = tasks;
  if (body === undefined) { response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not implemented" })); return; }
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}).listen(8787, "127.0.0.1", () => console.log("mock control plane on http://127.0.0.1:8787"));
