-- Execution kernel: durable Runs, fencing, structured events, split session state.
CREATE TYPE "RunStatus" AS ENUM ('queued', 'claimed', 'provisioning', 'running', 'waiting-inbox', 'succeeded', 'failed', 'timed-out', 'cancelled', 'lost');
CREATE TYPE "SessionExecutionStatus" AS ENUM ('requested', 'provisioning', 'running', 'waiting-inbox', 'succeeded', 'failed', 'timed-out', 'cancelled', 'lost');
CREATE TYPE "CleanupStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'retained');
CREATE TYPE "FailureClass" AS ENUM ('binary-not-found', 'auth-required', 'rate-limited', 'cancelled-or-timed-out', 'tool-failed', 'transient-provider', 'protocol-error', 'task-failed', 'budget-exceeded');
CREATE TYPE "SessionEventSource" AS ENUM ('runner', 'claude', 'codex', 'pi');
CREATE TYPE "PushStatus" AS ENUM ('not-requested', 'pending', 'succeeded', 'failed');

ALTER TABLE "Secret"
  ADD COLUMN "ciphertextVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "keyId" TEXT NOT NULL DEFAULT 'v1',
  ADD COLUMN "rotatedAt" TIMESTAMP(3),
  ADD COLUMN "disabledAt" TIMESTAMP(3);

ALTER TABLE "Task"
  ADD COLUMN "repoId" TEXT,
  ADD COLUMN "targetBranch" TEXT,
  ADD COLUMN "spendCapApplicable" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "AgentSkill" ADD COLUMN "projectId" TEXT;
ALTER TABLE "AgentMCPConnection" ADD COLUMN "projectId" TEXT;
ALTER TABLE "AgentRepoAccess" ADD COLUMN "projectId" TEXT;
ALTER TABLE "AgentCollaboration" ADD COLUMN "projectId" TEXT;
UPDATE "AgentSkill" j SET "projectId" = a."projectId" FROM "Agent" a WHERE a."id" = j."agentId";
UPDATE "AgentMCPConnection" j SET "projectId" = a."projectId" FROM "Agent" a WHERE a."id" = j."agentId";
UPDATE "AgentRepoAccess" j SET "projectId" = a."projectId" FROM "Agent" a WHERE a."id" = j."agentId";
UPDATE "AgentCollaboration" j SET "projectId" = a."projectId" FROM "Agent" a WHERE a."id" = j."agentId";
ALTER TABLE "AgentSkill" ALTER COLUMN "projectId" SET NOT NULL;
ALTER TABLE "AgentMCPConnection" ALTER COLUMN "projectId" SET NOT NULL;
ALTER TABLE "AgentRepoAccess" ALTER COLUMN "projectId" SET NOT NULL;
ALTER TABLE "AgentCollaboration" ALTER COLUMN "projectId" SET NOT NULL;

CREATE UNIQUE INDEX "Environment_id_projectId_key" ON "Environment"("id", "projectId");
CREATE UNIQUE INDEX "Agent_id_projectId_key" ON "Agent"("id", "projectId");
CREATE UNIQUE INDEX "Skill_id_projectId_key" ON "Skill"("id", "projectId");
CREATE UNIQUE INDEX "MCPConnection_id_projectId_key" ON "MCPConnection"("id", "projectId");
CREATE UNIQUE INDEX "Repo_id_projectId_key" ON "Repo"("id", "projectId");
CREATE UNIQUE INDEX "Task_id_projectId_key" ON "Task"("id", "projectId");
CREATE UNIQUE INDEX "Goal_id_projectId_key" ON "Goal"("id", "projectId");
CREATE UNIQUE INDEX "AgentSecretGrant_agentId_envVar_key" ON "AgentSecretGrant"("agentId", "envVar");
CREATE UNIQUE INDEX "EnvironmentSecret_environmentId_envVar_key" ON "EnvironmentSecret"("environmentId", "envVar");
CREATE INDEX "Task_repoId_idx" ON "Task"("repoId");

ALTER TABLE "Agent" DROP CONSTRAINT "Agent_environmentId_fkey";
ALTER TABLE "Task" DROP CONSTRAINT "Task_assigneeAgentId_fkey";
ALTER TABLE "AgentSkill" DROP CONSTRAINT "AgentSkill_agentId_fkey";
ALTER TABLE "AgentSkill" DROP CONSTRAINT "AgentSkill_skillId_fkey";
ALTER TABLE "AgentMCPConnection" DROP CONSTRAINT "AgentMCPConnection_agentId_fkey";
ALTER TABLE "AgentMCPConnection" DROP CONSTRAINT "AgentMCPConnection_mcpConnectionId_fkey";
ALTER TABLE "AgentRepoAccess" DROP CONSTRAINT "AgentRepoAccess_agentId_fkey";
ALTER TABLE "AgentRepoAccess" DROP CONSTRAINT "AgentRepoAccess_repoId_fkey";
ALTER TABLE "AgentCollaboration" DROP CONSTRAINT "AgentCollaboration_agentId_fkey";
ALTER TABLE "AgentCollaboration" DROP CONSTRAINT "AgentCollaboration_allowedAgentId_fkey";
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_environmentId_projectId_fkey"
  FOREIGN KEY ("environmentId", "projectId") REFERENCES "Environment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeAgentId_projectId_fkey"
  FOREIGN KEY ("assigneeAgentId", "projectId") REFERENCES "Agent"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_repoId_projectId_fkey"
  FOREIGN KEY ("repoId", "projectId") REFERENCES "Repo"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_agentId_projectId_fkey"
  FOREIGN KEY ("agentId", "projectId") REFERENCES "Agent"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_skillId_projectId_fkey"
  FOREIGN KEY ("skillId", "projectId") REFERENCES "Skill"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentMCPConnection" ADD CONSTRAINT "AgentMCPConnection_agentId_projectId_fkey"
  FOREIGN KEY ("agentId", "projectId") REFERENCES "Agent"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentMCPConnection" ADD CONSTRAINT "AgentMCPConnection_mcpConnectionId_projectId_fkey"
  FOREIGN KEY ("mcpConnectionId", "projectId") REFERENCES "MCPConnection"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRepoAccess" ADD CONSTRAINT "AgentRepoAccess_agentId_projectId_fkey"
  FOREIGN KEY ("agentId", "projectId") REFERENCES "Agent"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRepoAccess" ADD CONSTRAINT "AgentRepoAccess_repoId_projectId_fkey"
  FOREIGN KEY ("repoId", "projectId") REFERENCES "Repo"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentCollaboration" ADD CONSTRAINT "AgentCollaboration_agentId_projectId_fkey"
  FOREIGN KEY ("agentId", "projectId") REFERENCES "Agent"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentCollaboration" ADD CONSTRAINT "AgentCollaboration_allowedAgentId_projectId_fkey"
  FOREIGN KEY ("allowedAgentId", "projectId") REFERENCES "Agent"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Run" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "taskId" TEXT,
  "goalId" TEXT,
  "agentId" TEXT NOT NULL,
  "repoId" TEXT,
  "blockedByRunId" TEXT,
  "runNumber" INTEGER NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "status" "RunStatus" NOT NULL DEFAULT 'queued',
  "readyAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "runner" "RunnerKind" NOT NULL,
  "runnerId" TEXT,
  "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
  "fencingToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "lastProcessAliveAt" TIMESTAMP(3),
  "lastProgressEventAt" TIMESTAMP(3),
  "inFlightTool" JSONB,
  "sessionTokenHash" TEXT,
  "sessionTokenExpiresAt" TIMESTAMP(3),
  "sessionTokenRevokedAt" TIMESTAMP(3),
  "workspacePath" TEXT,
  "workspaceRetained" BOOLEAN NOT NULL DEFAULT false,
  "targetBranch" TEXT,
  "branch" TEXT,
  "baseSha" TEXT,
  "headSha" TEXT,
  "pushStatus" "PushStatus" NOT NULL DEFAULT 'not-requested',
  "adapterVersion" TEXT,
  "cliVersion" TEXT,
  "model" TEXT NOT NULL,
  "authMode" TEXT,
  "manifest" JSONB,
  "promptHash" TEXT NOT NULL,
  "maxDurationMin" INTEGER NOT NULL DEFAULT 120,
  "stallTimeoutMin" INTEGER NOT NULL DEFAULT 10,
  "maxRunsPerTask" INTEGER NOT NULL DEFAULT 3,
  "spendCap" DECIMAL(12,2),
  "spendCapApplicable" BOOLEAN NOT NULL DEFAULT false,
  "failureClass" "FailureClass",
  "failureReason" TEXT,
  "retryable" BOOLEAN,
  "retryAt" TIMESTAMP(3),
  "terminationReason" TEXT,
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- Existing Phase 1 sessions become terminal migrated Runs. Active legacy leases
-- cannot be fenced safely, so they deliberately become LOST and require review.
ALTER TABLE "Session" RENAME COLUMN "startedAt" TO "requestedAt";
ALTER TABLE "Session"
  ADD COLUMN "runId" TEXT,
  ADD COLUMN "projectId" TEXT,
  ADD COLUMN "executionStatus" "SessionExecutionStatus" NOT NULL DEFAULT 'requested',
  ADD COLUMN "cleanupStatus" "CleanupStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "providerConversationId" TEXT,
  ADD COLUMN "waitingOnMessageId" TEXT,
  ADD COLUMN "resumableUntil" TIMESTAMP(3),
  ADD COLUMN "resumeAttempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "provisionedAt" TIMESTAMP(3),
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "cleanupStartedAt" TIMESTAMP(3),
  ADD COLUMN "cleanupEndedAt" TIMESTAMP(3),
  ADD COLUMN "exitCode" INTEGER,
  ADD COLUMN "signal" TEXT,
  ADD COLUMN "terminationReason" TEXT,
  ADD COLUMN "cleanupFailureReason" TEXT;

WITH numbered AS (
  SELECT s."id",
         CASE WHEN s."taskId" IS NULL THEN 1 ELSE row_number() OVER (PARTITION BY s."taskId" ORDER BY s."requestedAt", s."id") END::integer AS n
  FROM "Session" s
)
INSERT INTO "Run" (
  "id", "projectId", "taskId", "goalId", "agentId", "runNumber", "dedupeKey", "status", "readyAt",
  "runner", "runnerId", "leaseExpiresAt", "heartbeatAt", "model", "promptHash", "maxDurationMin",
  "stallTimeoutMin", "maxRunsPerTask", "failureReason", "queuedAt", "claimedAt", "startedAt", "endedAt",
  "createdAt", "updatedAt", "sessionTokenRevokedAt"
)
SELECT
  'legacy-run-' || s."id", a."projectId", s."taskId", s."goalId", s."agentId", n.n,
  'legacy-session:' || s."id",
  CASE WHEN s."status"::text = 'destroyed' THEN 'succeeded'::"RunStatus"
       WHEN s."status"::text = 'failed' THEN 'failed'::"RunStatus"
       ELSE 'lost'::"RunStatus" END,
  s."requestedAt", s."runner", s."runnerId", NULL, s."heartbeatAt", a."model", md5(s."id"),
  s."maxDurationMin", s."stallTimeoutMin", COALESCE(t."maxSessionsPerTask", 3), s."failureReason",
  s."requestedAt", s."requestedAt", s."requestedAt", s."endedAt", s."requestedAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Session" s
JOIN numbered n ON n."id" = s."id"
JOIN "Agent" a ON a."id" = s."agentId"
LEFT JOIN "Task" t ON t."id" = s."taskId";

UPDATE "Session" s
SET "runId" = 'legacy-run-' || s."id",
    "projectId" = r."projectId",
    "executionStatus" = CASE WHEN s."status"::text = 'destroyed' THEN 'succeeded'::"SessionExecutionStatus"
                             WHEN s."status"::text = 'failed' THEN 'failed'::"SessionExecutionStatus"
                             ELSE 'lost'::"SessionExecutionStatus" END,
    "cleanupStatus" = CASE WHEN s."status"::text = 'destroyed' THEN 'succeeded'::"CleanupStatus"
                           ELSE 'pending'::"CleanupStatus" END,
    "startedAt" = s."requestedAt",
    "cleanupEndedAt" = CASE WHEN s."status"::text = 'destroyed' THEN s."endedAt" ELSE NULL END
FROM "Run" r
WHERE r."id" = 'legacy-run-' || s."id";

ALTER TABLE "Session" ALTER COLUMN "runId" SET NOT NULL;
ALTER TABLE "Session" ALTER COLUMN "projectId" SET NOT NULL;
DROP INDEX IF EXISTS "Session_status_startedAt_idx";
DROP INDEX IF EXISTS "Session_status_leaseExpiresAt_idx";
ALTER TABLE "Session"
  DROP COLUMN "status",
  DROP COLUMN "runnerId",
  DROP COLUMN "leaseExpiresAt",
  DROP COLUMN "heartbeatAt",
  DROP COLUMN "toolCallLog",
  DROP COLUMN "lastToolCallAt",
  DROP COLUMN "commitShas";
DROP TYPE "SessionStatus";

CREATE TABLE "SessionEvent" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" "SessionEventSource" NOT NULL,
  "type" TEXT NOT NULL,
  "providerEventId" TEXT,
  "toolCallId" TEXT,
  "payload" JSONB NOT NULL,
  CONSTRAINT "SessionEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RunnerBackendState" (
  "runner" "RunnerKind" NOT NULL,
  "cliVersion" TEXT,
  "authMode" TEXT,
  "capabilities" JSONB,
  "lastPreflightAt" TIMESTAMP(3),
  "lastPreflightOk" BOOLEAN NOT NULL DEFAULT false,
  "consecutiveAuthFailures" INTEGER NOT NULL DEFAULT 0,
  "circuitOpen" BOOLEAN NOT NULL DEFAULT false,
  "circuitReason" TEXT,
  "circuitOpenedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RunnerBackendState_pkey" PRIMARY KEY ("runner")
);

CREATE UNIQUE INDEX "Run_dedupeKey_key" ON "Run"("dedupeKey");
CREATE UNIQUE INDEX "Run_fencingToken_key" ON "Run"("fencingToken");
CREATE UNIQUE INDEX "Run_sessionTokenHash_key" ON "Run"("sessionTokenHash");
CREATE UNIQUE INDEX "Run_taskId_runNumber_key" ON "Run"("taskId", "runNumber");
CREATE UNIQUE INDEX "Run_id_projectId_key" ON "Run"("id", "projectId");
CREATE INDEX "Run_status_readyAt_idx" ON "Run"("status", "readyAt");
CREATE INDEX "Run_status_leaseExpiresAt_idx" ON "Run"("status", "leaseExpiresAt");
CREATE INDEX "Run_projectId_idx" ON "Run"("projectId");
CREATE INDEX "Run_agentId_idx" ON "Run"("agentId");
CREATE INDEX "Run_repoId_idx" ON "Run"("repoId");
CREATE INDEX "Run_blockedByRunId_idx" ON "Run"("blockedByRunId");
CREATE UNIQUE INDEX "Run_one_active_per_task"
  ON "Run"("taskId") WHERE "taskId" IS NOT NULL AND "status" IN ('claimed', 'provisioning', 'running', 'waiting-inbox');
CREATE UNIQUE INDEX "Session_runId_key" ON "Session"("runId");
CREATE UNIQUE INDEX "Session_runId_projectId_key" ON "Session"("runId", "projectId");
CREATE INDEX "Session_executionStatus_requestedAt_idx" ON "Session"("executionStatus", "requestedAt");
CREATE INDEX "Session_cleanupStatus_requestedAt_idx" ON "Session"("cleanupStatus", "requestedAt");
CREATE UNIQUE INDEX "SessionEvent_sessionId_seq_key" ON "SessionEvent"("sessionId", "seq");
CREATE INDEX "SessionEvent_runId_at_idx" ON "SessionEvent"("runId", "at");
CREATE INDEX "SessionEvent_sessionId_at_idx" ON "SessionEvent"("sessionId", "at");

ALTER TABLE "Run" ADD CONSTRAINT "Run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Run" ADD CONSTRAINT "Run_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "Task"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Run" ADD CONSTRAINT "Run_goalId_projectId_fkey" FOREIGN KEY ("goalId", "projectId") REFERENCES "Goal"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Run" ADD CONSTRAINT "Run_agentId_projectId_fkey" FOREIGN KEY ("agentId", "projectId") REFERENCES "Agent"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Run" ADD CONSTRAINT "Run_repoId_projectId_fkey" FOREIGN KEY ("repoId", "projectId") REFERENCES "Repo"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Run" ADD CONSTRAINT "Run_blockedByRunId_fkey" FOREIGN KEY ("blockedByRunId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Session" DROP CONSTRAINT "Session_agentId_fkey";
ALTER TABLE "Session" DROP CONSTRAINT "Session_taskId_fkey";
ALTER TABLE "Session" DROP CONSTRAINT "Session_goalId_fkey";
ALTER TABLE "Session" ADD CONSTRAINT "Session_runId_projectId_fkey" FOREIGN KEY ("runId", "projectId") REFERENCES "Run"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_agentId_projectId_fkey" FOREIGN KEY ("agentId", "projectId") REFERENCES "Agent"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "Task"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_goalId_projectId_fkey" FOREIGN KEY ("goalId", "projectId") REFERENCES "Goal"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SessionEvent" ADD CONSTRAINT "SessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionEvent" ADD CONSTRAINT "SessionEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
