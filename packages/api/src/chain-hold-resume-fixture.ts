import { randomUUID } from "node:crypto";

import {
  ChainControlState,
  DependencyProvisioning,
  PrismaClient,
  RunStatus,
  SessionExecutionStatus,
  TaskStatus,
} from "@anneal/db";

import { createApp } from "./test-app.js";

export const CHAIN_OPERATOR_TOKEN = "chain-hold-resume-operator-token";
export const CHAIN_RUNNER_TOKEN = "chain-hold-resume-runner-token";

type ControlSeed = {
  state: ChainControlState;
  heldLayer?: number | null;
  holdGeneration?: number;
  holdRequestId?: string | null;
  holdReason?: string | null;
  heldAt?: Date | null;
  releasedAt?: Date | null;
  releaseRequestId?: string | null;
  event?: boolean;
};

export type BasicChain = Awaited<ReturnType<typeof seedBasicChain>>;

export const seedBasicChain = async (
  db: PrismaClient,
  options: {
    statuses?: TaskStatus[];
    layers?: number[];
    control?: ControlSeed | null;
    label?: string;
  } = {},
) => {
  const suffix = randomUUID();
  const statuses = options.statuses ?? [TaskStatus.DONE, TaskStatus.TODO, TaskStatus.TODO];
  const layers = options.layers ?? statuses.map((_, index) => index + 1);
  if (statuses.length !== layers.length || statuses.length === 0) throw new Error("basic chain shape mismatch");

  const project = await db.project.create({ data: { name: `Hold/resume ${suffix}`, slug: `hold-resume-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `hold-resume-agent-${suffix}`,
    title: "Hold/resume test agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: `hold-resume-repo-${suffix}`,
    remoteUrl: "https://example.test/hold-resume.git",
    mountPath: "/repo",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });

  const chainId = `${options.label ?? "hold-resume-chain"}-${suffix}`;
  const tasks = [];
  for (const [index, status] of statuses.entries()) {
    tasks.push(await db.task.create({ data: {
      projectId: project.id,
      repoId: repo.id,
      assigneeAgentId: agent.id,
      name: `Step ${index + 1}`,
      description: `step ${index + 1}`,
      chainId,
      chainIndex: index,
      chainLayer: layers[index] ?? null,
      status,
    } }));
  }

  const controlSeed: ControlSeed | null = options.control === undefined
    ? {
      state: ChainControlState.HELD,
      heldLayer: layers[0] ?? null,
      holdGeneration: 1,
      holdRequestId: "hold-fixture",
      holdReason: "fixture hold",
      heldAt: new Date("2026-08-28T00:00:00.000Z"),
      event: true,
    }
    : options.control;
  let control = null;
  if (controlSeed) {
    const heldLayer = controlSeed.heldLayer ?? layers[0] ?? null;
    control = await db.chainControl.create({ data: {
      projectId: project.id,
      chainId,
      state: controlSeed.state,
      heldLayer,
      holdGeneration: controlSeed.holdGeneration ?? 1,
      holdRequestId: controlSeed.holdRequestId ?? null,
      holdReason: controlSeed.holdReason ?? null,
      heldAt: controlSeed.heldAt ?? null,
      releasedAt: controlSeed.releasedAt ?? null,
      releaseRequestId: controlSeed.releaseRequestId ?? null,
    } });
    if (controlSeed.event !== false) {
      await db.chainControlEvent.create({ data: {
        chainControlId: control.id,
        kind: controlSeed.state,
        layer: heldLayer ?? 0,
        actorType: "operator",
        actorId: null,
        requestId: controlSeed.state === ChainControlState.HELD
          ? (controlSeed.holdRequestId ?? "hold-fixture")
          : (controlSeed.releaseRequestId ?? "release-fixture"),
        reason: controlSeed.state === ChainControlState.HELD ? (controlSeed.holdReason ?? null) : null,
        createdAt: controlSeed.state === ChainControlState.HELD
          ? (controlSeed.heldAt ?? new Date())
          : (controlSeed.releasedAt ?? new Date()),
        holdGeneration: controlSeed.holdGeneration ?? 1,
      } });
    }
  }

  return {
    project,
    environment,
    agent,
    repo,
    chainId,
    tasks,
    first: tasks[0]!,
    second: tasks[1] ?? tasks[0]!,
    third: tasks[2] ?? tasks.at(-1)!,
    control,
  };
};

export const seedRun = async (
  db: PrismaClient,
  chain: BasicChain,
  taskId: string,
  options: {
    status?: RunStatus;
    sessionStatus?: SessionExecutionStatus;
    runNumber?: number;
    runnerId?: string;
    fencingToken?: string;
    providerConversationId?: string | null;
  } = {},
) => {
  const priorRuns = await db.run.findMany({ where: { taskId }, select: { runNumber: true } });
  const runNumber = options.runNumber ?? Math.max(0, ...priorRuns.map((run) => run.runNumber)) + 1;
  const status = options.status ?? RunStatus.RUNNING;
  const runnerId = options.runnerId ?? `hold-resume-runner-${randomUUID()}`;
  const fencingToken = options.fencingToken ?? `hold-resume-fence-${randomUUID()}`;
  const run = await db.run.create({ data: {
    projectId: chain.project.id,
    taskId,
    agentId: chain.agent.id,
    repoId: chain.repo.id,
    runNumber,
    dedupeKey: `task:${taskId}:run:${runNumber}:${randomUUID()}`,
    runner: "CLAUDE",
    model: chain.agent.model,
    status,
    runnerId: status === RunStatus.CANCELLED || status === RunStatus.SUCCEEDED ? null : runnerId,
    fencingToken: status === RunStatus.CANCELLED || status === RunStatus.SUCCEEDED ? null : fencingToken,
    leaseExpiresAt: status === RunStatus.RUNNING ? new Date(Date.now() + 60_000) : null,
    promptHash: `hold-resume-${runNumber}`,
  } });
  await db.session.create({ data: {
    runId: run.id,
    projectId: chain.project.id,
    agentId: chain.agent.id,
    taskId,
    runner: "CLAUDE",
    executionStatus: options.sessionStatus ?? (status === RunStatus.CANCELLED
      ? SessionExecutionStatus.CANCELLED
      : status === RunStatus.SUCCEEDED ? SessionExecutionStatus.SUCCEEDED : SessionExecutionStatus.RUNNING),
    providerConversationId: options.providerConversationId ?? null,
  } });
  return { run, runnerId, fencingToken };
};

export const operatorRequest = async (
  db: PrismaClient,
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${CHAIN_OPERATOR_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};

export const runnerCompletionRequest = async (
  db: PrismaClient,
  run: { id: string; runnerId: string | null; fencingToken: string | null },
  output = "completed output",
): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request(`/runner/runs/${run.id}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CHAIN_RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: run.runnerId,
      fencingToken: run.fencingToken,
      exitCode: 0,
      terminalEventSeen: true,
      terminalSuccess: true,
      cleanupStatus: "SUCCEEDED",
      output,
    }),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};

export const chainAuditSnapshot = async (db: PrismaClient, chain: BasicChain) => ({
  control: chain.control
    ? await db.chainControl.findUniqueOrThrow({ where: { id: chain.control.id } })
    : null,
  events: chain.control
    ? await db.chainControlEvent.findMany({ where: { chainControlId: chain.control.id }, orderBy: { id: "asc" } })
    : [],
  tasks: await db.task.findMany({ where: { id: { in: chain.tasks.map((task) => task.id) } }, orderBy: { chainIndex: "asc" } }),
  runs: await db.run.findMany({ where: { taskId: { in: chain.tasks.map((task) => task.id) } }, orderBy: { id: "asc" } }),
  activities: await db.taskActivity.findMany({ where: { taskId: { in: chain.tasks.map((task) => task.id) } }, orderBy: { id: "asc" } }),
});
