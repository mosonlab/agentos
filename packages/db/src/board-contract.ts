/**
 * Browser-safe serialized contracts for the Tasks board and Chain detail.
 *
 * This module deliberately imports nothing. String-literal unions mirror the
 * persisted enums without making a browser consumer load Prisma, and the
 * default `DateTime` parameter is the ISO string produced on the HTTP wire.
 * Server projections may instantiate the same contract with `Date` before
 * JSON serialization.
 */

export type TaskStatus = "BACKLOG" | "TODO" | "DOING" | "REVIEW" | "DONE";
export type TaskSource = "MANUAL" | "CRON" | "WEBHOOK";
export type AssigneeType = "AGENT" | "HUMAN";
export type ScheduleKind = "NOW" | "AT" | "CRON";
export type RunStatus =
  | "QUEUED" | "CLAIMED" | "PROVISIONING" | "RUNNING" | "WAITING_INBOX"
  | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "LOST";
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
