import type { Project as WireProject } from "@anneal/db/wire-contract";
import type {
  TaskTemplate as ConsoleTaskTemplate,
  TaskTemplateStep as ConsoleTaskTemplateStep,
} from "@anneal/db/console-contract";

/** Wire shapes as serialised by the control plane (packages/db/prisma/schema.prisma).
 *  Decimal columns arrive as strings, DateTime as ISO strings.
 *
 *  Every shape the console reads is owned by a contract module in `@anneal/db`,
 *  and the routes that produce them are bound to the same declaration, so a
 *  server-side rename reaches this file as a compile error instead of as a
 *  silently absent field. The two aliases below add fields while this web
 *  branch is developed alongside the shared contract change. */

export type {
  AssigneeType,
  BoardCard,
  BoardChainActivationState,
  BoardLatestRun,
  BoardMoveTarget,
  BoardTask,
  Chain,
  ChainAggregate,
  ChainActiveRepair,
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
  Repo,
  RepoPermission,
  RunnerKind,
  RunnerPreference,
  Secret,
  SecretPurpose,
  SessionExecutionStatus,
  Skill,
} from "@anneal/db/wire-contract";
export type {
  BackendStatus,
  DaemonStatus,
  Goal,
  GoalDefinitionItem,
  GoalProgressEntry,
  Health,
  InboxChoice,
  InboxDecision,
  InboxMessage,
  InboxReply,
  InboxSummary,
  OnboardingDisclosure,
  OnboardingInstallation,
  OnboardingStatus,
  RunnersResponse,
  SessionEvent,
  SessionEventSource,
  VersionInfo,
} from "@anneal/db/console-contract";

/** These fields are introduced by the optional-template-steps contract. Keep
 * the web-local intersection until the shared db contracts carry them; the
 * aliases then remain structurally identical after that contract lands. */
export type Project<DateTime = string, DecimalValue = string> = WireProject<DateTime, DecimalValue> & {
  skipOptionalSteps: boolean;
};

export type TaskTemplateStep<DateTime = string> = ConsoleTaskTemplateStep<DateTime> & {
  optional: boolean;
};

export type TaskTemplate<DateTime = string> = Omit<ConsoleTaskTemplate<DateTime>, "steps"> & {
  steps: TaskTemplateStep<DateTime>[];
};
