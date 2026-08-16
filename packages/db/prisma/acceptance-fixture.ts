/** Batch 0 fixture. Run db:seed first, then `npm run db:fixture -w @agentos/db`.
 * Re-running deletes and recreates all fixture-owned records. */
import { createCipheriv, randomBytes } from "node:crypto";
import {
  AssigneeType, InboxDeliveryStatus, InboxKind, InboxSender, InboxStatus, PrismaClient,
  RepoPermission, RunnerKind, RunStatus, SessionEventSource, SessionExecutionStatus, TaskStatus,
} from "@prisma/client";

const db = new PrismaClient();
const ids = {
  repo:"fixture-repo", todo:"fixture-task-todo", doing:"fixture-task-doing", review:"fixture-task-review", done:"fixture-task-done",
  historyRun:"fixture-run-history", waitingRun:"fixture-run-waiting", historySession:"fixture-session-history", waitingSession:"fixture-session-waiting",
  goal:"fixture-goal", secret:"fixture-secret", mcp:"fixture-mcp-connection", openThread:"fixture-inbox-open-thread",
  openMessage:"fixture-inbox-open-message", answeredThread:"fixture-inbox-answered-thread",
  answeredMessage:"fixture-inbox-answered-message", answeredReply:"fixture-inbox-answered-reply",
} as const;

// Wire-format owner: packages/api/src/secrets.ts.
const encryptedFixture = (): string => {
  const encoded = process.env.AGENTOS_SECRET_ENCRYPTION_KEY;
  if (!encoded) throw new Error("AGENTOS_SECRET_ENCRYPTION_KEY is required to create the acceptance fixture");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("AGENTOS_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update("fixture", "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
};

const main = async (): Promise<void> => {
  const encryptedValue = encryptedFixture();
  const project = await db.project.findUnique({ where: { slug: "agentos-example" } });
  if (!project) throw new Error("Run db:seed before db:fixture (missing agentos-example project)");
  const agents = await db.agent.findMany({ where: { projectId: project.id }, orderBy: { name: "asc" } });
  if (agents.length === 0) throw new Error("Run db:seed before db:fixture (no seeded agents found)");
  const agent = agents[0]!;

  const fixtureTasks = await db.task.findMany({
    where: { OR: [{ id: { in: [ids.todo, ids.doing, ids.review, ids.done] } }, { repoId: ids.repo }] },
    select: { id: true },
  });
  const taskIds = fixtureTasks.map(({ id }) => id);
  const threadIds = [ids.openThread, ids.answeredThread];
  // The acceptance walk can create retries, sessions, and Inbox replies with generated
  // ids. Delete by fixture task ownership so a reset remains deterministic afterward.
  await db.inboxMessage.deleteMany({ where: { OR: [{ taskId: { in: taskIds } }, { threadId: { in: threadIds } }] } });
  await db.inboxThread.deleteMany({ where: { taskId: { in: taskIds } } });
  await db.session.deleteMany({ where: { taskId: { in: taskIds } } });
  await db.run.deleteMany({ where: { taskId: { in: taskIds } } });
  await db.task.deleteMany({ where: { id: { in: taskIds } } });
  await db.goal.deleteMany({ where: { id: ids.goal } });
  await db.mCPConnection.deleteMany({ where: { OR: [{ id: ids.mcp }, { projectId: project.id, name: "fixture-mcp" }] } });
  const repos = await db.repo.findMany({ where: { OR: [{ id: ids.repo }, { projectId: project.id, name: "fixture-repo" }] }, select: { id: true } });
  if (repos.length) {
    const repoIds = repos.map(({ id }) => id);
    await db.agentRepoAccess.deleteMany({ where: { repoId: { in: repoIds } } });
    await db.repo.deleteMany({ where: { id: { in: repoIds } } });
  }
  await db.secret.deleteMany({ where: { OR: [{ id: ids.secret }, { name: "fixture-secret" }] } });

  const repo = await db.repo.create({ data: { id:ids.repo, projectId:project.id, name:"fixture-repo", remoteUrl:"file:///tmp/agentos-fixture-repo.git", mountPath:"/workspace/fixture-repo", defaultBranch:"main" } });
  await db.agentRepoAccess.createMany({ data: agents.map((a) => ({ agentId:a.id, repoId:repo.id, projectId:project.id, mountPath:"/workspace/fixture-repo", permissions:RepoPermission.GIT_WRITE })) });
  const common = { projectId:project.id, assigneeAgentId:agent.id, repoId:repo.id, assigneeType:AssigneeType.AGENT, workingDirectory:".", targetBranch:"main" };
  await db.task.createMany({ data: [
    { ...common, id:ids.todo, name:"Fixture task · Todo", description:"Deterministic TODO task for acceptance.", status:TaskStatus.TODO },
    { ...common, id:ids.doing, name:"Fixture task · Doing", description:"DOING task with events, activity, and Inbox wait.", status:TaskStatus.DOING },
    { ...common, id:ids.review, name:"Fixture task · Review", description:"Deterministic REVIEW task for acceptance.", status:TaskStatus.REVIEW },
    { ...common, id:ids.done, name:"Fixture task · Done", description:"Deterministic DONE task for acceptance.", status:TaskStatus.DONE },
  ] });
  const now = new Date();
  const runCommon = { projectId:project.id, taskId:ids.doing, agentId:agent.id, repoId:repo.id, runner:RunnerKind.CODEX, model:agent.model, targetBranch:"main" };
  await db.run.createMany({ data: [
    { ...runCommon, id:ids.historyRun, runNumber:1, dedupeKey:ids.historyRun, status:RunStatus.SUCCEEDED, promptHash:"fixture-history", branch:"fixture/history", startedAt:new Date(now.getTime()-120000), endedAt:new Date(now.getTime()-60000) },
    { ...runCommon, id:ids.waitingRun, runNumber:2, dedupeKey:ids.waitingRun, status:RunStatus.WAITING_INBOX, promptHash:"fixture-waiting", branch:"fixture/waiting", startedAt:new Date(now.getTime()-30000) },
  ] });
  const sessionCommon = { projectId:project.id, agentId:agent.id, taskId:ids.doing, runner:RunnerKind.CODEX };
  await db.session.createMany({ data: [
    { ...sessionCommon, id:ids.historySession, runId:ids.historyRun, executionStatus:SessionExecutionStatus.SUCCEEDED, requestedAt:new Date(now.getTime()-130000), startedAt:new Date(now.getTime()-120000), endedAt:new Date(now.getTime()-60000), exitCode:0 },
    { ...sessionCommon, id:ids.waitingSession, runId:ids.waitingRun, executionStatus:SessionExecutionStatus.WAITING_INBOX, requestedAt:new Date(now.getTime()-40000), startedAt:new Date(now.getTime()-30000) },
  ] });
  await db.sessionEvent.createMany({ data: [
    { id:"fixture-event-1", sessionId:ids.historySession, runId:ids.historyRun, seq:1, source:SessionEventSource.RUNNER, type:"session.started", payload:{ fixture:true } },
    { id:"fixture-event-2", sessionId:ids.historySession, runId:ids.historyRun, seq:2, source:SessionEventSource.CODEX, type:"agent.progress", payload:{ message:"Fixture work completed" } },
  ] });
  await db.taskActivity.createMany({ data: [
    { id:"fixture-activity-1", taskId:ids.doing, actorType:"agent", actorId:agent.id, body:"Acceptance fixture run started", metadata:{ fixture:true } },
    { id:"fixture-activity-2", taskId:ids.doing, actorType:"agent", actorId:agent.id, body:"Acceptance fixture run is waiting for Inbox", metadata:{ fixture:true } },
  ] });
  await db.goal.create({ data: { id:ids.goal, projectId:project.id, title:"Fixture goal", spec:"Exercise Goals UI.", dodApproved:true, status:"ACTIVE", startedAt:new Date(now.getTime()-300000), definitionOfDone:{ create:{ itemIndex:0, text:"Acceptance walk completed" } }, progressLog:{ create:{ id:"fixture-goal-progress", body:"Fixture progress entry", metadata:{ fixture:true } } } } });
  await db.secret.create({ data: { id:ids.secret, name:"fixture-secret", encryptedValue, purpose:"ENV", description:"Batch 0 acceptance fixture", ciphertextVersion:1, keyId:"v1" } });
  await db.mCPConnection.create({ data: { id:ids.mcp, projectId:project.id, name:"fixture-mcp", transport:"stdio", config:{ command:"fixture-mcp" }, allowedOperations:["read","write"] } });
  await db.inboxThread.create({ data: { id:ids.openThread, externalChatId:"fixture-open-chat", sessionId:ids.waitingSession, taskId:ids.doing } });
  await db.inboxMessage.create({ data: { id:ids.openMessage, from:InboxSender.AGENT, agentId:agent.id, sessionId:ids.waitingSession, taskId:ids.doing, threadId:ids.openThread, kind:InboxKind.MULTIPLE_CHOICE, body:"Choose a fixture direction\nThis exercises resumable Inbox.", choices:[{id:"continue",label:"Continue"},{id:"revise",label:"Revise"}], status:InboxStatus.OPEN, dedupeKey:"fixture-inbox-open", deliveryStatus:InboxDeliveryStatus.DELIVERED, deliveredAt:now } });
  await db.session.update({ where:{ id:ids.waitingSession }, data:{ waitingOnMessageId:ids.openMessage } });
  await db.inboxThread.create({ data: { id:ids.answeredThread, externalChatId:"fixture-answered-chat", sessionId:ids.historySession, taskId:ids.doing } });
  await db.inboxMessage.create({ data: { id:ids.answeredMessage, from:InboxSender.AGENT, agentId:agent.id, sessionId:ids.historySession, taskId:ids.doing, threadId:ids.answeredThread, kind:InboxKind.TEXT, body:"Fixture text question\nThis thread already has a human answer.", status:InboxStatus.ANSWERED, answeredAt:now, dedupeKey:"fixture-inbox-answered", deliveryStatus:InboxDeliveryStatus.DELIVERED, deliveredAt:now, replies:{ create:{ id:ids.answeredReply, from:InboxSender.HUMAN, agentId:agent.id, sessionId:ids.historySession, taskId:ids.doing, threadId:ids.answeredThread, kind:InboxKind.TEXT, body:"Fixture answer", status:InboxStatus.CLOSED, dedupeKey:"fixture-inbox-answered-reply", deliveryStatus:InboxDeliveryStatus.DELIVERED, deliveredAt:now } } } });
  console.log(`Reset Batch 0 acceptance fixture for ${project.slug}: 4 tasks, 1 repo, ${agents.length} agent grants.`);
};
try { await main(); } finally { await db.$disconnect(); }
