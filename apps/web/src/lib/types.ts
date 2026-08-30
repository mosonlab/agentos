/** Wire shapes as serialised by the control plane (packages/db/prisma/schema.prisma).
 *  Decimal columns arrive as strings, DateTime as ISO strings. */

import type { AssigneeType } from "@anneal/db/board-contract";
import type {
  Agent,
  GoalStatus,
  InboxDeliveryStatus,
  InboxKind,
  InboxStatus,
  RepoPermission,
  RunnerKind,
  RunnerPreference,
} from "@anneal/db/wire-contract";

export type {
  AssigneeType,
  BoardCard,
  BoardChainActivationState,
  BoardLatestRun,
  BoardMoveTarget,
  BoardTask,
  Chain,
  ChainAggregate,
  ChainAggregateState,
  ChainControl,
  ChainFrontier,
  ChainProgress,
  ChainStep,
  CostsReport,
  ExecutionOwner,
  MergeOutcome,
  MergeRecovery,
  RecurringFire,
  Run,
  RunStatus,
  ScheduleKind,
  Session,
  TaskActivity,
  TaskDetail,
  TaskList,
  TaskMoveTarget,
  TaskSource,
  TaskStartability,
  TaskStatus,
  TaskStepOutput,
  Trigger,
  TriggerDetail,
  TriggerFire,
  UsageCost,
} from "@anneal/db/board-contract";
export type {
  Agent,
  AgentRepoAccess,
  CodexServiceTier,
  Environment,
  FailureClass,
  FilesystemGrant,
  GoalStatus,
  InboxDeliveryStatus,
  InboxKind,
  InboxStatus,
  MCPConnection,
  Project,
  Repo,
  RepoPermission,
  RunnerKind,
  RunnerPreference,
  Secret,
  SecretPurpose,
  SessionExecutionStatus,
  Skill,
} from "@anneal/db/wire-contract";

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

export type TaskTemplateStep = {
  id: string;
  stepIndex: number;
  name: string;
  assigneeType: AssigneeType;
  prompt: string;
  approvalGate: boolean;
  outputKind: string;
  priorOutputKinds: string[];
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
  /** Derived by the API: no decision is owed on this card and no suspended run
   *  resumes on it, so the operator may archive it outright. */
  dismissible: boolean;
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

/** `GET /inbox/messages/summary`: the sidebar badge's whole payload.
 *
 *  The badge used to be a by-product of `GET /inbox/messages`, which every page
 *  polled every 5s for the complete message history — 490 KB and 231 messages
 *  to render one number. The count is the same one `needsReply` computes card by
 *  card; the API applies that rule server-side. */
export type InboxSummary = {
  needsReply: number;
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

/**
 * `GET /version`: the product build identity of the control plane answering
 * this page — what an operator quotes in a report. Distinct from the runner
 * daemon and CLI versions, which describe machines and backends, not the build.
 */
export type VersionInfo = {
  service: string;
  version: string | null;
  buildSha: string;
  commit: string | null;
  dirty: boolean;
  stamped: boolean;
  builtAt: string | null;
};

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
