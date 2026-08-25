/** Wire shapes as serialised by the control plane (packages/db/prisma/schema.prisma).
 *  Decimal columns arrive as strings, DateTime as ISO strings. */

export type TaskStatus = "BACKLOG" | "TODO" | "DOING" | "REVIEW" | "DONE";
/** How a task came to exist. A recurring definition stays MANUAL; only its
 *  fired copies are CRON. */
export type TaskSource = "MANUAL" | "CRON" | "WEBHOOK";
export type AssigneeType = "AGENT" | "HUMAN";
export type RunnerKind = "CLAUDE" | "CODEX" | "PI";
export type RunnerPreference = RunnerKind | "AUTO" | "INHERIT";
export type CodexServiceTier = "DEFAULT" | "FAST";
export type RunStatus =
  | "QUEUED" | "CLAIMED" | "PROVISIONING" | "RUNNING" | "WAITING_INBOX"
  | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "LOST";
export type SessionExecutionStatus =
  | "REQUESTED" | "PROVISIONING" | "RUNNING" | "WAITING_INBOX"
  | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "LOST";
export type FailureClass =
  | "BINARY_NOT_FOUND" | "AUTH_REQUIRED" | "RATE_LIMITED" | "CANCELLED_OR_TIMED_OUT"
  | "TOOL_FAILED" | "TRANSIENT_PROVIDER" | "PROTOCOL_ERROR" | "TASK_FAILED" | "BUDGET_EXCEEDED";
export type InboxStatus = "OPEN" | "ANSWERED" | "CLOSED";
export type InboxKind = "TEXT" | "MULTIPLE_CHOICE";
export type InboxDeliveryStatus = "PENDING" | "SENDING" | "DELIVERED" | "FAILED";
/* Three of the six `GoalStatus` values in `schema.prisma` are missing on purpose.
 * `STOPPED_SPEND`, `STOPPED_TIME` and `STOPPED_STUCK` are the stops an execution
 * model would set, and no such model is wired: the API writes only ACTIVE (or
 * COMPLETED) on approve-dod and PAUSED on pause, and nothing else in this
 * repository writes `Goal.status` at all. Naming them here would put a tone, a
 * label and a legend in the console for a state the server cannot produce. When
 * the stops are wired, adding them back is a type error at every render site,
 * which is the point of narrowing rather than hiding. */
export type GoalStatus = "ACTIVE" | "PAUSED" | "COMPLETED";
export type SecretPurpose = "MCP" | "REPO" | "ENV" | "WEBHOOK";
export type RepoPermission = "GIT_READ" | "GIT_WRITE";

export type Project = {
  id: string;
  name: string;
  slug: string;
  yamlDocument: string;
  maxDurationMin: number;
  stallTimeoutMin: number;
  maxSessionsPerTask: number;
  spendCap: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Agent = {
  id: string;
  projectId: string;
  environmentId: string;
  name: string;
  title: string;
  model: string;
  codexServiceTier: CodexServiceTier;
  foundationalPrompt: string;
  rolePrompt: string;
  runnerPreference: RunnerPreference;
  inboxAccess: boolean;
  /** Denied tools, not allowed ones. Empty is the default and means "no restriction". */
  disabledTools: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Present only when the control plane starts including binding tables. */
  skills?: Array<{ skillId: string; skill?: Skill }>;
  mcpConnections?: Array<{ mcpConnectionId: string; mcpConnection?: MCPConnection }>;
  repoAccess?: AgentRepoAccess[];
  secretGrants?: Array<{ secretId: string; envVar: string; secret?: Secret }>;
  filesystemGrants?: FilesystemGrant[];
  collaborators?: Array<{ allowedAgentId: string }>;
};

export type AgentRepoAccess = {
  agentId: string;
  repoId: string;
  projectId: string;
  mountPath: string;
  permissions: RepoPermission;
};

export type FilesystemGrant = {
  id: string;
  agentId: string;
  folderPath: string;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
};

export type Skill = {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  kind: "PROMPT" | "FILE";
  body: string | null;
  filePath: string | null;
  updatedAt: string;
};

export type MCPConnection = {
  id: string;
  projectId: string;
  credentialSecretId: string | null;
  name: string;
  transport: string;
  config: unknown;
  allowedOperations: string[];
  createdAt: string;
  updatedAt: string;
  agents?: Array<{ agentId: string }>;
};

export type Environment = {
  id: string;
  projectId: string;
  name: string;
  networking: "OPEN" | "LIMITED";
  allowedHosts: string[];
};

export type Repo = {
  id: string;
  projectId: string;
  credentialSecretId: string | null;
  name: string;
  remoteUrl: string;
  mountPath: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
};

export type Secret = {
  id: string;
  name: string;
  purpose: SecretPurpose;
  description: string | null;
  ciphertextVersion: number;
  keyId: string;
  rotatedAt: string | null;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
  agentGrants?: Array<{ agentId: string; envVar: string; agent?: { id: string; name: string } }>;
};

export type Session = {
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
  cleanupStatus: string;
  providerConversationId: string | null;
  waitingOnMessageId: string | null;
  resumeAttempt: number;
  requestedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  terminationReason: string | null;
  exitCode: number | null;
  costUsd: string | null;
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

/**
 * §SF-1. The server's parse of a task's persisted `merge-result` output; the
 * client never reads the fenced body itself, so the run row, the sessions pill
 * and the board card cannot disagree about what a mechanical merge did.
 *
 * `incident` marks the two conditions that are discovered *after* the merge
 * landed — those read as a red Incident rather than an amber Stopped.
 */
export type MergeOutcome = {
  outcome: "merged" | "stopped" | "malformed";
  condition: string | null;
  incident: boolean;
};

export type MergeRecovery = {
  id: string;
  attempt: number;
  status: "VALIDATING" | "REPAIRING" | "AWAITING_AUTHORIZATION" | "BLOCKED_DOWNSTREAM" | "SUCCEEDED" | "FAILED";
  phase: "validation" | "repair" | "authorization-wait" | "downstream-stop" | "succeeded" | "actual-failure";
  sourceStopId: string;
  boundSourceRunId: string | null;
  recoveryRunId: string | null;
  failureReason: string | null;
  updatedAt: string;
};

export type Run = {
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
  cancelRequestedAt: string | null;
  cancelAcknowledgedAt: string | null;
  workspacePath: string | null;
  workspaceRetained: boolean;
  targetBranch: string | null;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  pushStatus: string;
  pullRequestUrl: string | null;
  maxDurationMin: number;
  stallTimeoutMin: number;
  maxRunsPerTask: number;
  failureClass: FailureClass | null;
  failureReason: string | null;
  retryable: boolean | null;
  retryAt: string | null;
  terminationReason: string | null;
  queuedAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  session?: Session | null;
  /** Null on every run that did not record a `merge-result` — which is every
   *  run but the mechanical executor's. */
  mergeOutcome?: MergeOutcome | null;
  mergeRecovery?: MergeRecovery | null;
};

export type SessionEvent = {
  id: string;
  sessionId: string;
  runId: string;
  seq: number;
  at: string;
  source: string;
  type: string;
  toolCallId: string | null;
  payload: unknown;
};

export type Task = {
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
  assigneeType: AssigneeType;
  executionOwner: ExecutionOwner;
  approvalGate: boolean;
  scheduleKind: "NOW" | "AT" | "CRON";
  // The scheduler's own columns. `runAt === null` on a live CRON definition is
  // the quarantine marker, not an absence — see lib/schedule.ts.
  runAt: string | null;
  cron: string | null;
  timezone: string | null;
  maxDurationMin: number;
  stallTimeoutMin: number;
  maxSessionsPerTask: number;
  createdAt: string;
  updatedAt: string;
  assigneeAgent: Agent | null;
  repo: Repo | null;
  runs: Run[];
  taskCost?: UsageCost | null;
  chainId: string | null;
  chainIndex: number | null;
  source: TaskSource;
  archivedAt: string | null;
  schedulePausedAt: string | null;
  recurringSourceTaskId: string | null;
  templateStep: {
    name: string;
    stepIndex: number;
    outputKind: string;
    taskTemplate: { name: string };
  } | null;
  /** §SF-1, the task's own latest merge outcome; the run rows carry the same
   *  projection bound to the run that recorded it. */
  mergeOutcome?: MergeOutcome | null;
  mergeRecovery?: MergeRecovery | null;
  /** Assembled by the API, never recomputed here: a second implementation could
   *  disagree with the board's own numbers. Null when the task is not in a chain. */
  chainProgress: ChainProgress | null;
  /** Present only on recurring definitions, so a collapsed Automations row can
   *  render `Last run` without opening a second poll per row. */
  recurringLastFiredAt: string | null;
  recurringFireCount: number;
};

/**
 * One Tasks board card, as `GET /tasks?view=board` serialises it
 * (packages/api/src/board.ts).
 *
 * A projection of `Task`, not a subset type of it: the board reads one run and
 * the agent identity and model, so the wire shape says exactly that rather than shipping the
 * whole `Run`, its `Session` and the `Repo` for every card. Measured on the live
 * board, the full shape is 1,581,550 bytes for 112 tasks and this one is 76,947.
 *
 * `failureReason` is *not* truncated here: the card clamps it to three lines,
 * and the card menu's `Copy error` hands over the whole thing.
 */
export type BoardTask = {
  id: string;
  name: string;
  displayName: string;
  status: TaskStatus;
  failureReason: string | null;
  scheduleKind: "NOW" | "AT" | "CRON";
  runAt: string | null;
  cron: string | null;
  timezone: string | null;
  approvalGate: boolean;
  templateId: string | null;
  source: TaskSource;
  chainId: string | null;
  chainIndex: number | null;
  chainName: string | null;
  updatedAt: string;
  assigneeAgent: { id: string; title: string; model: string } | null;
  chainProgress: ChainProgress | null;
  /** API-computed predecessor binding state; absent for older board responses. */
  blockedOn?: { taskId: string; taskName: string } | null;
  latestRun: {
    id: string;
    runNumber: number;
    status: RunStatus;
    costUsd: string | null;
    startedAt: string | null;
    endedAt: string | null;
  } | null;
  taskCost: UsageCost | null;
  /** §SF-1, bound to `latestRun`: null whenever the newest run is not the run
   *  that recorded the outcome. */
  mergeOutcome?: MergeOutcome | null;
};

export type UsageCost = {
  costUsd: string | null;
  estimated: boolean;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
};

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
  /** This task's 1-based ordinal within its chain. */
  position: number | null;
};

export type ExecutionOwner = "agent" | "human" | "control-plane" | "merge-executor";

export type ChainStep = {
  taskId: string;
  position: number;
  chainIndex: number | null;
  /** Stored execution layer; null is tolerated while an older control plane is migrating. */
  layer: number | null;
  name: string;
  stepName: string;
  status: TaskStatus;
  approvalGate: boolean;
  assigneeType: AssigneeType;
  executionOwner: ExecutionOwner;
  agent: { id: string; title: string } | null;
  archivedAt: string | null;
  failureReason: string | null;
  latestRun: { id: string; status: RunStatus; runNumber: number } | null;
  /** The API's own answer, not a second derivation: the button's enabled state
   *  and the route's guard must not be able to disagree. */
  startable: boolean;
  startAction: "start" | "recover" | null;
  /** API-computed predecessor binding state; absent for older chain responses. */
  blockedOn?: { taskId: string; name: string; status: TaskStatus } | null;
  currentExecution: boolean;
  mergeRecovery?: MergeRecovery | null;
};

export type Chain = {
  chainId: string | null;
  total: number;
  done: number;
  steps: ChainStep[];
};

/** A webhook-configured template. `repo` is nullable: a trigger is defined by
 *  its secret, so one without a repository is listed and un-fireable rather
 *  than hidden. */
export type Trigger = {
  id: string;
  name: string;
  description: string;
  repo: { id: string; name: string } | null;
  stepCount: number;
  paused: boolean;
  secretDisabled: boolean;
  lastFiredAt: string | null;
  fireCount: number;
};

export type TriggerDetail = {
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
  lastFiredAt: string | null;
  canFire: boolean;
  cannotFireReason: string | null;
};

export type TriggerFire = {
  id: string;
  createdAt: string;
  source: "WEBHOOK" | "MANUAL";
  chainId: string | null;
  firstTask: { id: string; name: string } | null;
  progress: ChainProgress | null;
};

/** One fired copy of a recurring definition, newest first. */
export type RecurringFire = {
  taskId: string;
  name: string;
  createdAt: string;
  status: TaskStatus;
  latestRun: {
    id: string;
    status: RunStatus;
    runNumber: number;
    session: { id: string; costUsd: string | null } | null;
  } | null;
};

export type TaskActivity = {
  id: string;
  taskId: string;
  actorType: string;
  actorId: string | null;
  body: string;
  commitSha: string | null;
  metadata: unknown;
  createdAt: string;
};

export type TaskStepOutput = {
  id: string;
  taskId: string;
  runId: string | null;
  kind: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskTemplateStep = {
  id: string;
  stepIndex: number;
  name: string;
  assigneeType: AssigneeType;
  prompt: string;
  approvalGate: boolean;
  outputKind: string;
  baseFromStepIndex: number | null;
  runner: RunnerKind | null;
  assigneeAgentId: string | null;
  assigneeAgent: Agent | null;
};

export type TaskTemplate = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  variables: string[];
  steps: TaskTemplateStep[];
};

export type InboxChoice = { id: string; label: string };

export type InboxDecision = {
  id: string;
  inboxMessageId: string;
  runId: string;
  externalEventId: string;
  decision: string;
  actorOpenId: string | null;
  createdAt: string;
};

export type InboxMessage = {
  id: string;
  from: "AGENT" | "HUMAN";
  agentId: string | null;
  sessionId: string | null;
  taskId: string | null;
  goalId: string | null;
  gateTaskId: string | null;
  /** Approval gates only: the task whose step output the gate is asking about,
   *  derived by the API from the card's session. Absent on non-gate cards. */
  artifactTaskId: string | null;
  threadId: string | null;
  replyToMessageId: string | null;
  kind: InboxKind;
  body: string;
  choices: InboxChoice[] | null;
  selectedChoiceId: string | null;
  status: InboxStatus;
  channel: string;
  deliveryStatus: InboxDeliveryStatus;
  deliveryAttempts: number;
  lastDeliveryError: string | null;
  createdAt: string;
  answeredAt: string | null;
  decisions?: InboxDecision[];
  replies?: InboxMessage[];
};

export type Goal = {
  id: string;
  projectId: string;
  title: string;
  spec: string;
  dodApproved: boolean;
  status: GoalStatus;
  spendCap: string | null;
  spendUsd: string;
  maxDurationMin: number | null;
  stallTimeoutMin: number;
  stuckThreshold: number;
  runnerPreference: RunnerPreference;
  sharedFolderPath: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  definitionOfDone?: GoalDefinitionItem[];
  progressLog?: GoalProgressEntry[];
};

export type GoalDefinitionItem = {
  id: string;
  goalId: string;
  itemIndex: number;
  text: string;
  done: boolean;
};

export type GoalProgressEntry = {
  id: string;
  goalId: string;
  sessionId: string | null;
  body: string;
  createdAt: string;
};

export type Health = { status: string; database: string; checkedAt: string };

export type DaemonStatus = {
  runnerId: string;
  lastSeenAt: string;
  online: boolean;
  busy: boolean;
  activeRuns: number;
  daemonVersion: string | null;
  diskFreeBytes: number | null;
  pollIntervalMs: number | null;
  workspaceRoot: string | null;
};

export type BackendStatus = {
  runner: RunnerKind;
  cliVersion: string | null;
  authMode: string | null;
  lastPreflightAt: string | null;
  lastPreflightOk: boolean | null;
  circuitOpen: boolean | null;
  circuitReason: string | null;
};

export type RunnersResponse = {
  checkedAt: string;
  online: number;
  total: number;
  daemons: DaemonStatus[];
  backends: BackendStatus[];
};

/**
 * The first-run installation contract (`GET`/`POST /onboarding`).
 *
 * Deliberately narrow: the control plane returns public identities and nothing
 * else — no prompt, no remote URL, no internal column — so that everything the
 * wizard holds is safe in a browser, a screenshot and release evidence.
 */
export type OnboardingDisclosure = {
  environmentNetworking: "OPEN";
  filesystemGrantCreated: false;
  repoPermission: RepoPermission;
  codexSandbox: "none";
  runsWithHostUserAuthority: boolean;
  supportedScope: string;
  embeddedRemoteCredentialsRejected: boolean;
};

export type OnboardingStatus = {
  complete: boolean;
  project: { id: string; name: string; slug: string } | null;
  /** `null` when the control plane cannot read its own starter source. Never a
   *  reason to withhold `complete`, and never a reason to block an install. */
  starter: { name: string; title: string; model: string; runnerPreference: RunnerPreference } | null;
  disclosure: OnboardingDisclosure;
};

export type OnboardingInstallation = {
  complete: true;
  project: { id: string; name: string; slug: string };
  environment: { id: string; name: string; networking: string; allowedHosts: string[] };
  agent: { id: string; name: string; title: string; model: string; runnerPreference: RunnerPreference };
  repo: { id: string; name: string; defaultBranch: string; mountPath: string };
  access: { agentId: string; repoId: string; permissions: RepoPermission; mountPath: string };
};
