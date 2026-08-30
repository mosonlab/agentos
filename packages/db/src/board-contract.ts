/**
 * Browser-safe serialized contracts for the Tasks board and Chain detail.
 *
 * Prisma is imported as types only: browser consumers receive no generated
 * client code, while persisted enum widening becomes a compile-time change at
 * this seam. String-literal unions that are not persisted remain local to the
 * contract, and the default `DateTime` parameter is the ISO string produced on
 * the HTTP wire. Server projections may instantiate the same contract with
 * `Date` before JSON serialization.
 */

import type {
  AssigneeType as PrismaAssigneeType,
  ChainControlState as PrismaChainControlState,
  CleanupStatus as PrismaCleanupStatus,
  CodexServiceTier as PrismaCodexServiceTier,
  FailureClass as PrismaFailureClass,
  MergeRecoveryStatus as PrismaMergeRecoveryStatus,
  PushStatus as PrismaPushStatus,
  RunStatus as PrismaRunStatus,
  RunnerKind as PrismaRunnerKind,
  ScheduleKind as PrismaScheduleKind,
  SessionEventSource as PrismaSessionEventSource,
  SessionExecutionStatus as PrismaSessionExecutionStatus,
  TaskSource as PrismaTaskSource,
  TaskStatus as PrismaTaskStatus,
  TriggerFireSource as PrismaTriggerFireSource,
} from "@prisma/client";

import type { Agent, Repo } from "./wire-contract.js";

export type TaskStatus = PrismaTaskStatus;
export type TaskSource = PrismaTaskSource;
export type AssigneeType = PrismaAssigneeType;
export type ScheduleKind = PrismaScheduleKind;
export type RunStatus = PrismaRunStatus;
export type RunnerKind = PrismaRunnerKind;
export type CodexServiceTier = PrismaCodexServiceTier;
export type SessionExecutionStatus = PrismaSessionExecutionStatus;
export type CleanupStatus = PrismaCleanupStatus;
export type FailureClass = PrismaFailureClass;
export type SessionEventSource = PrismaSessionEventSource;
export type PushStatus = PrismaPushStatus;
export type ChainControlState = PrismaChainControlState;
export type MergeRecoveryStatus = PrismaMergeRecoveryStatus;
export type TriggerFireSource = PrismaTriggerFireSource;

export type ExecutionOwner = "agent" | "human" | "control-plane" | "merge-executor";

export type BoardMoveTarget = { status: TaskStatus; via: "patch" | "start" };
export type TaskMoveTarget = BoardMoveTarget;

export type UsageCost = {
  /** A serialized Decimal, or null when cost is unavailable. */
  costUsd: string | null;
  estimated: boolean;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
};

/** A local calendar day in the costs window and its spend by agent. */
export type CostsDailyBucket<DecimalValue = string> = {
  date: string;
  byAgent: Record<string, DecimalValue>;
};

export type CostsAgentTotal<DecimalValue = string> = {
  agent: string;
  usd: DecimalValue;
  runs: number;
  costUnavailableRuns: number;
  avgUsd: DecimalValue;
  /** Cached share of this agent's input tokens, 0-100, or null when no run
   * reported both token columns. */
  cachePct: number | null;
  wastedUsd: DecimalValue;
};

export type CostsModelTotal<DecimalValue = string> = {
  model: string;
  usd: DecimalValue;
  runs: number;
  costUnavailableRuns: number;
};

export type CostsTopRun<DateTime = string, DecimalValue = string> = {
  runId: string;
  taskName: string | null;
  agent: string;
  model: string;
  usd: DecimalValue;
  estimated: boolean;
  startedAt: DateTime;
};

/** `GET /projects/:projectId/costs` and its native API projection.
 *
 * `DateTime` and `DecimalValue` default to their JSON wire forms. API-side
 * projections can instantiate them with `Date` and `Prisma.Decimal`; Hono's
 * JSON serialization then produces the browser-facing default shape without
 * giving the web app a second hand-maintained copy of this contract.
 */
export type CostsReport<DateTime = string, DecimalValue = string> = {
  days: number;
  /** Inclusive lower bound of the whole-day window. */
  since: DateTime;
  totalUsd: DecimalValue;
  /** The part of `totalUsd` priced by repository rates rather than a provider. */
  estimatedUsd: DecimalValue;
  /** Settled runs that started inside the window, priced or not. */
  runCount: number;
  /** Runs whose cost could not be established; they contribute to no total. */
  costUnavailableRuns: number;
  /** Mean over runs that have a cost, not over all settled runs. */
  avgUsd: DecimalValue;
  /** Priced spend of settled runs that did not succeed. */
  wastedUsd: DecimalValue;
  daily: CostsDailyBucket<DecimalValue>[];
  byAgent: CostsAgentTotal<DecimalValue>[];
  byModel: CostsModelTotal<DecimalValue>[];
  topRuns: CostsTopRun<DateTime, DecimalValue>[];
};

/** The server's parse of a persisted `merge-result`; post-merge conditions set
 * `incident` so run-centric clients distinguish them from pre-merge stops. */
export type MergeOutcome = {
  outcome: "merged" | "stopped" | "malformed";
  condition: string | null;
  incident: boolean;
};

export type MergeRecovery<DateTime = string> = {
  id: string;
  attempt: number;
  status: "VALIDATING" | "REPAIRING" | "AWAITING_AUTHORIZATION" | "BLOCKED_DOWNSTREAM" | "SUCCEEDED" | "FAILED";
  phase: "validation" | "repair" | "authorization-wait" | "downstream-stop" | "succeeded" | "actual-failure";
  sourceStopId: string;
  boundSourceRunId: string | null;
  recoveryRunId: string | null;
  failureReason: string | null;
  updatedAt: DateTime;
};

/** A serialized Session as returned by the operator session routes. */
export type Session<DateTime = string, DecimalValue = string> = {
  id: string;
  runId: string;
  /** §SF-1. Null unless this session's own run recorded a `merge-result`. */
  mergeOutcome?: MergeOutcome | null;
  projectId: string;
  agentId: string;
  taskId: string | null;
  goalId: string | null;
  runner: RunnerKind;
  executionStatus: SessionExecutionStatus;
  cleanupStatus: CleanupStatus;
  providerConversationId: string | null;
  waitingOnMessageId: string | null;
  resumeAttempt: number;
  requestedAt: DateTime;
  startedAt: DateTime | null;
  endedAt: DateTime | null;
  terminationReason: string | null;
  exitCode: number | null;
  costUsd: DecimalValue | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  usageCost?: UsageCost | null;
  failureReason: string | null;
  /** Relations GET /sessions and GET /sessions/:id include; absent on the
   *  session rows nested inside a Run. `run.repo` is a nullable relation, and
   *  its remoteUrl is what makes the Branch field a link. */
  agent?: { id: string; title: string } | null;
  task?: { id: string; name: string } | null;
  goal?: { id: string; title: string } | null;
  run?: {
    id: string;
    runNumber: number;
    model: string;
    branch: string | null;
    pullRequestUrl: string | null;
    workspacePath: string | null;
    repo?: { id: string; name: string; remoteUrl: string } | null;
  } | null;
};

/** A serialized Run as embedded by Task detail responses. */
export type Run<DateTime = string, DecimalValue = string> = {
  id: string;
  projectId: string;
  taskId: string | null;
  goalId: string | null;
  agentId: string;
  repoId: string | null;
  runNumber: number;
  status: RunStatus;
  runner: RunnerKind;
  runnerId: string | null;
  model: string;
  codexServiceTier: CodexServiceTier;
  subagentModel: string | null;
  subagentMaxConcurrent: number | null;
  leaseGeneration: number;
  cancelRequestId: string | null;
  cancelReason: string | null;
  cancelRequestedAt: DateTime | null;
  cancelAcknowledgedAt: DateTime | null;
  workspacePath: string | null;
  workspaceRetained: boolean;
  targetBranch: string | null;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  pushStatus: PushStatus;
  pullRequestUrl: string | null;
  maxDurationMin: number;
  stallTimeoutMin: number;
  maxRunsPerTask: number;
  failureClass: FailureClass | null;
  failureReason: string | null;
  retryable: boolean | null;
  retryAt: DateTime | null;
  terminationReason: string | null;
  queuedAt: DateTime;
  claimedAt: DateTime | null;
  startedAt: DateTime | null;
  endedAt: DateTime | null;
  session?: Session<DateTime, DecimalValue> | null;
  /** Null on every run that did not record a `merge-result` — which is every
   *  run but the mechanical executor's. */
  mergeOutcome?: MergeOutcome | null;
  mergeRecovery?: MergeRecovery<DateTime> | null;
};

export type ChainProgress = {
  chainId: string;
  done: number;
  total: number;
  activeStepName: string;
  activeStatus: string;
  /** Dense one-based ordinal of the active stored execution layer. */
  currentLayer: number;
  /** Number of distinct execution layers in the chain. */
  layerCount: number;
  /** This task's one-based ordinal within its Chain. */
  position: number | null;
};

export type BoardLatestRun<DateTime = string> = {
  id: string;
  runNumber: number;
  status: RunStatus;
  /** The model snapshot taken when the Run was claimed. */
  model: string;
  /** A serialized Decimal, or null when cost is unavailable. */
  costUsd: string | null;
  startedAt: DateTime | null;
  endedAt: DateTime | null;
};

export type RepairBinding = {
  chainId: string;
  chainName: string | null;
  repairKind: string;
};

export type ChainAggregateState =
  | "parked-unactivated"
  | "waiting-on-predecessor"
  | "running"
  | "idle"
  | "settled";
export type BoardChainActivationState = ChainAggregateState;

export type ChainFrontier<DateTime = string> = {
  taskId: string;
  title: string;
  status: TaskStatus;
  latestRun: BoardLatestRun<DateTime> | null;
  mergeOutcome: MergeOutcome | null;
  failureReason: string | null;
  /** Dense one-based position among primary Steps; omitted for a repair. */
  position?: number | null;
};
export type BoardChainFrontier<DateTime = string> = ChainFrontier<DateTime>;

export type ChainAggregate<DateTime = string> = {
  chainId: string;
  chainName: string | null;
  /** Number of primary Chain Steps. Detached repairs never inflate this. */
  stepCount: number;
  /** Status counts for every primary-Step status. */
  statusCounts: Record<TaskStatus, number>;
  detailTaskId: string;
  /** Derived board column; this is not a persisted Task status. */
  status: TaskStatus;
  frontier: ChainFrontier<DateTime>;
  activation: {
    state: ChainAggregateState;
    predecessor: { taskId: string; taskName: string } | null;
    taskId: string | null;
  };
  totalCost: UsageCost | null;
  createdAt: DateTime;
  updatedAt: DateTime;
};
export type BoardChainAggregate<DateTime = string> = ChainAggregate<DateTime>;

export type BoardCard<DateTime = string> = {
  id: string;
  name: string;
  displayName: string;
  status: TaskStatus;
  moveTargets: BoardMoveTarget[];
  assigneeType: AssigneeType;
  failureReason: string | null;
  scheduleKind: ScheduleKind;
  runAt: DateTime | null;
  cron: string | null;
  timezone: string | null;
  approvalGate: boolean;
  templateId: string | null;
  source: TaskSource;
  chainId: string | null;
  chainIndex: number | null;
  chainName: string | null;
  blockedOn: { taskId: string; taskName: string } | null;
  createdAt: DateTime;
  updatedAt: DateTime;
  assigneeAgent: { id: string; title: string; model: string } | null;
  chainProgress: ChainProgress | null;
  latestRun: BoardLatestRun<DateTime> | null;
  taskCost: UsageCost | null;
  mergeOutcome: MergeOutcome | null;
  repairOf: RepairBinding | null;
  /** Carried once by one visible member of each Chain; null otherwise. */
  chainAggregate: ChainAggregate<DateTime> | null;
};

/** The browser-facing name retained by the web app's existing consumers. */
export type BoardTask = BoardCard<string>;

export type ChainStep<DateTime = string> = {
  taskId: string;
  position: number;
  chainIndex: number | null;
  layer: number | null;
  name: string;
  stepName: string;
  status: TaskStatus;
  approvalGate: boolean;
  assigneeType: AssigneeType;
  executionOwner: ExecutionOwner;
  agent: { id: string; title: string } | null;
  archivedAt: DateTime | null;
  failureReason: string | null;
  latestRun: { id: string; status: RunStatus; runNumber: number } | null;
  startable: boolean;
  startAction: "start" | "recover" | null;
  holdRefusal: string | null;
  blockedOn: { taskId: string; name: string; status: TaskStatus } | null;
  currentExecution: boolean;
  mergeRecovery: MergeRecovery<DateTime> | null;
};

export type ChainControl<DateTime = string> = {
  state: "held" | "released";
  heldLayer: number | null;
  heldAt: DateTime | null;
  holdRequestId: string | null;
  holdReason: string | null;
  releasedAt: DateTime | null;
};

export type Chain<DateTime = string> = {
  chainId: string | null;
  total: number;
  done: number;
  steps: ChainStep<DateTime>[];
  control: ChainControl<DateTime> | null;
};

/** A webhook-configured template. `repo` is nullable: a trigger is defined by
 * its secret, so one without a repository is listed and un-fireable rather
 * than hidden. */
export type Trigger<DateTime = string> = {
  id: string;
  name: string;
  description: string;
  repo: { id: string; name: string } | null;
  stepCount: number;
  paused: boolean;
  secretDisabled: boolean;
  lastFiredAt: DateTime | null;
  fireCount: number;
};

export type TriggerDetail<DateTime = string> = {
  id: string;
  name: string;
  description: string;
  projectId: string;
  endpointPath: string;
  secretName: string | null;
  secretDisabled: boolean;
  repo: { id: string; name: string } | null;
  variables: string[];
  mapping: Record<string, string>;
  defaults: Record<string, unknown>;
  replayWindowSec: number | null;
  paused: boolean;
  stepCount: number;
  fireCount: number;
  lastFiredAt: DateTime | null;
  canFire: boolean;
  cannotFireReason: string | null;
};

export type TriggerFire<DateTime = string> = {
  id: string;
  createdAt: DateTime;
  source: TriggerFireSource;
  chainId: string | null;
  firstTask: { id: string; name: string } | null;
  progress: ChainProgress | null;
};

/** One fired copy of a recurring definition, newest first. */
export type RecurringFire<DateTime = string> = {
  taskId: string;
  name: string;
  createdAt: DateTime;
  status: TaskStatus;
  latestRun: {
    id: string;
    status: RunStatus;
    runNumber: number;
    session: { id: string; costUsd: string | null } | null;
  } | null;
};

/**
 * A serialized Task as returned by the full task/detail routes.
 *
 * `DateTime` and `DecimalValue` let API projections keep their native Prisma
 * values until Hono serializes them. Relations deliberately use the shared
 * operator contracts and the Run contract rather than importing Prisma into
 * this browser-safe module.
 *
 * The task list and detail routes are intentionally not identical: the list
 * carries chain/recurring enrichment while the detail carries cost and merge
 * projections. Fields that are absent from one current route therefore stay
 * optional instead of making either route invent data.
 */
export type Task<DateTime = string, DecimalValue = string> = {
  id: string;
  projectId: string;
  assigneeAgentId: string | null;
  repoId: string | null;
  templateId: string | null;
  templateStepId: string | null;
  name: string;
  description: string;
  workingDirectory: string | null;
  targetBranch: string | null;
  failureReason: string | null;
  status: TaskStatus;
  moveTargets: TaskMoveTarget[];
  assigneeType: AssigneeType;
  executionOwner: ExecutionOwner;
  approvalGate: boolean;
  scheduleKind: ScheduleKind;
  // `runAt === null` on a live CRON definition is the scheduler quarantine
  // marker, not an absence.
  runAt: DateTime | null;
  cron: string | null;
  timezone: string | null;
  maxDurationMin: number;
  stallTimeoutMin: number;
  maxSessionsPerTask: number;
  createdAt: DateTime;
  updatedAt: DateTime;
  assigneeAgent: Agent<DateTime> | null;
  repo: Repo<DateTime> | null;
  runs: Run<DateTime, DecimalValue>[];
  taskCost?: UsageCost | null;
  chainId: string | null;
  chainIndex: number | null;
  source: TaskSource;
  archivedAt: DateTime | null;
  schedulePausedAt: DateTime | null;
  recurringSourceTaskId: string | null;
  templateStep: {
    name: string;
    stepIndex: number;
    outputKind: string;
    taskTemplate: { name: string };
  } | null;
  /** The task's own latest merge-result projection, when this route includes it. */
  mergeOutcome?: MergeOutcome | null;
  mergeRecovery?: MergeRecovery<DateTime> | null;
  /** Enrichment is carried by the full list; detail callers may not receive it. */
  chainProgress: ChainProgress | null;
  recurringLastFiredAt: DateTime | null;
  recurringFireCount: number;
};

/** HTTP envelope for `GET /tasks/:taskId/startability`. */
export type TaskStartability = {
  startable: boolean;
  checklist: {
    repoBound: boolean;
    agentAssignee: boolean;
    repoAccessGrant: boolean;
    budgetRemaining: boolean;
    noActiveRun: boolean;
    predecessorsDone: boolean;
  };
  task: {
    id: string;
    name: string;
    agent: { id: string; title: string } | null;
    repo: { id: string; name: string } | null;
    targetBranch: string | null;
  };
};

/** A TaskActivity row; commitSha was never a persisted/API activity field. */
export type TaskActivity<DateTime = string> = {
  id: string;
  taskId: string;
  actorType: string;
  actorId: string | null;
  body: string;
  metadata: unknown | null;
  createdAt: DateTime;
};

/** A TaskStepOutput row as emitted by GET/PUT output routes. */
export type TaskStepOutput<DateTime = string> = {
  id: string;
  taskId: string;
  runId: string | null;
  kind: string;
  body: string;
  metadata: unknown | null;
  commitSha: string | null;
  createdAt: DateTime;
  updatedAt: DateTime;
};
