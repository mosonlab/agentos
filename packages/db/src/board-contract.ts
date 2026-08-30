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
