/**
 * Browser-safe serialized contracts for operator configuration resources.
 *
 * Prisma is imported as types only: browser consumers receive no generated
 * client code, while persisted enum widening becomes a compile-time change at
 * this seam. `DateTime` and `DecimalValue` default to their JSON wire forms;
 * server projections instantiate them with their native values before Hono
 * serializes the response.
 */

import type {
  CodexServiceTier as PrismaCodexServiceTier,
  FailureClass as PrismaFailureClass,
  GoalStatus as PrismaGoalStatus,
  InboxDeliveryStatus as PrismaInboxDeliveryStatus,
  InboxKind as PrismaInboxKind,
  InboxStatus as PrismaInboxStatus,
  NetworkingMode as PrismaNetworkingMode,
  RepoPermission as PrismaRepoPermission,
  RunnerKind as PrismaRunnerKind,
  RunnerPreference as PrismaRunnerPreference,
  SecretPurpose as PrismaSecretPurpose,
  SessionExecutionStatus as PrismaSessionExecutionStatus,
  SkillKind as PrismaSkillKind,
} from "@prisma/client";

export type RunnerKind = PrismaRunnerKind;
export type RunnerPreference = PrismaRunnerPreference;
export type CodexServiceTier = PrismaCodexServiceTier;
export type SessionExecutionStatus = PrismaSessionExecutionStatus;
export type FailureClass = PrismaFailureClass;
export type InboxStatus = PrismaInboxStatus;
export type InboxKind = PrismaInboxKind;
export type InboxDeliveryStatus = PrismaInboxDeliveryStatus;
export type SecretPurpose = PrismaSecretPurpose;
export type RepoPermission = PrismaRepoPermission;
export type DependencyProvisioning = "NONE" | "NPM_CI";
type NetworkingMode = PrismaNetworkingMode;
type SkillKind = PrismaSkillKind;

type WiredGoalStatus = Extract<PrismaGoalStatus, "ACTIVE" | "PAUSED" | "COMPLETED">;
type UnwiredGoalStatus =
  | "STOPPED_SPEND"
  | "STOPPED_TIME"
  | "STOPPED_STUCK"
  | "FAILED"
  | "CANCELLED";
type GoalStatusCoverage =
  Exclude<PrismaGoalStatus, WiredGoalStatus | UnwiredGoalStatus> extends never
    ? Exclude<UnwiredGoalStatus, PrismaGoalStatus> extends never
      ? unknown
      : never
    : never;

/* Five of the eight `GoalStatus` values in `schema.prisma` are missing on
 * purpose. The three `STOPPED_*` states are not wired to an execution model,
 * and FAILED/CANCELLED likewise have no writer in this repository. Naming
 * them here would put a tone, label and legend in the console for states the
 * server cannot produce. `GoalStatusCoverage` makes any persisted widening or
 * removal a type error until this deliberate narrowing is reconsidered. */
export type GoalStatus = WiredGoalStatus & GoalStatusCoverage;

export type Project<DateTime = string, DecimalValue = string> = {
  id: string;
  name: string;
  slug: string;
  yamlDocument: string;
  maxDurationMin: number;
  stallTimeoutMin: number;
  maxSessionsPerTask: number;
  spendCap: DecimalValue | null;
  createdAt: DateTime;
  updatedAt: DateTime;
};

export type Agent<DateTime = string> = {
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
  /** Denied tools, not allowed ones. Empty means no restriction. */
  disabledTools: string[];
  createdAt: DateTime;
  updatedAt: DateTime;
  archivedAt: DateTime | null;
  /** Binding tables are present on the detail route and absent on list rows. */
  skills?: Array<{ skillId: string; skill?: Skill<DateTime> }>;
  mcpConnections?: Array<{ mcpConnectionId: string; mcpConnection?: MCPConnection<DateTime> }>;
  repoAccess?: AgentRepoAccess[];
  secretGrants?: Array<{ secretId: string; envVar: string; secret?: Secret<DateTime> }>;
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

export type Skill<DateTime = string> = {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  kind: SkillKind;
  body: string | null;
  filePath: string | null;
  updatedAt: DateTime;
};

export type MCPConnection<DateTime = string> = {
  id: string;
  projectId: string;
  credentialSecretId: string | null;
  name: string;
  transport: string;
  config: unknown;
  allowedOperations: string[];
  createdAt: DateTime;
  updatedAt: DateTime;
  agents?: Array<{ agentId: string }>;
};

export type Environment = {
  id: string;
  projectId: string;
  name: string;
  networking: NetworkingMode;
  allowedHosts: string[];
};

export type Repo<DateTime = string> = {
  id: string;
  projectId: string;
  credentialSecretId: string | null;
  name: string;
  remoteUrl: string;
  mountPath: string;
  defaultBranch: string;
  dependencyProvisioning: DependencyProvisioning;
  createdAt: DateTime;
  updatedAt: DateTime;
};

export type Secret<DateTime = string> = {
  id: string;
  name: string;
  purpose: SecretPurpose;
  description: string | null;
  ciphertextVersion: number;
  keyId: string;
  rotatedAt: DateTime | null;
  disabledAt: DateTime | null;
  createdAt: DateTime;
  updatedAt: DateTime;
  agentGrants?: Array<{ agentId: string; envVar: string; agent?: { id: string; name: string } }>;
};
