-- CreateEnum
CREATE TYPE "NetworkingMode" AS ENUM ('open', 'limited');

-- CreateEnum
CREATE TYPE "SkillKind" AS ENUM ('prompt', 'file');

-- CreateEnum
CREATE TYPE "RepoPermission" AS ENUM ('git-read', 'git-write');

-- CreateEnum
CREATE TYPE "SecretPurpose" AS ENUM ('mcp', 'repo', 'env', 'webhook');

-- CreateEnum
CREATE TYPE "RunnerKind" AS ENUM ('claude', 'codex', 'pi');

-- CreateEnum
CREATE TYPE "RunnerPreference" AS ENUM ('claude', 'codex', 'pi', 'auto', 'inherit');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('todo', 'doing', 'review', 'done');

-- CreateEnum
CREATE TYPE "AssigneeType" AS ENUM ('agent', 'human');

-- CreateEnum
CREATE TYPE "ScheduleKind" AS ENUM ('once-now', 'at', 'cron');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('active', 'paused', 'completed', 'stopped-spend', 'stopped-time', 'stopped-stuck');

-- CreateEnum
CREATE TYPE "InboxSender" AS ENUM ('agent', 'human');

-- CreateEnum
CREATE TYPE "InboxKind" AS ENUM ('text', 'multiple-choice');

-- CreateEnum
CREATE TYPE "InboxStatus" AS ENUM ('open', 'answered', 'closed');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('starting', 'running', 'waiting-inbox', 'committing', 'destroyed', 'failed');

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "yamlDocument" TEXT NOT NULL DEFAULT '',
    "maxDurationMin" INTEGER NOT NULL DEFAULT 120,
    "stallTimeoutMin" INTEGER NOT NULL DEFAULT 10,
    "maxSessionsPerTask" INTEGER NOT NULL DEFAULT 3,
    "spendCap" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Environment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "networking" "NetworkingMode" NOT NULL DEFAULT 'limited',
    "allowedHosts" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Environment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "foundationalPrompt" TEXT NOT NULL,
    "rolePrompt" TEXT NOT NULL,
    "runnerPreference" "RunnerPreference" NOT NULL DEFAULT 'inherit',
    "inboxAccess" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "SkillKind" NOT NULL,
    "body" TEXT,
    "filePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSkill" (
    "agentId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,

    CONSTRAINT "AgentSkill_pkey" PRIMARY KEY ("agentId","skillId")
);

-- CreateTable
CREATE TABLE "MCPConnection" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "credentialSecretId" TEXT,
    "name" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "allowedOperations" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MCPConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMCPConnection" (
    "agentId" TEXT NOT NULL,
    "mcpConnectionId" TEXT NOT NULL,

    CONSTRAINT "AgentMCPConnection_pkey" PRIMARY KEY ("agentId","mcpConnectionId")
);

-- CreateTable
CREATE TABLE "Repo" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "credentialSecretId" TEXT,
    "name" TEXT NOT NULL,
    "remoteUrl" TEXT NOT NULL,
    "mountPath" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRepoAccess" (
    "agentId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "mountPath" TEXT NOT NULL,
    "permissions" "RepoPermission" NOT NULL,

    CONSTRAINT "AgentRepoAccess_pkey" PRIMARY KEY ("agentId","repoId")
);

-- CreateTable
CREATE TABLE "FilesystemGrant" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "folderPath" TEXT NOT NULL,
    "canRead" BOOLEAN NOT NULL DEFAULT false,
    "canWrite" BOOLEAN NOT NULL DEFAULT false,
    "canDelete" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "FilesystemGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCollaboration" (
    "agentId" TEXT NOT NULL,
    "allowedAgentId" TEXT NOT NULL,

    CONSTRAINT "AgentCollaboration_pkey" PRIMARY KEY ("agentId","allowedAgentId")
);

-- CreateTable
CREATE TABLE "Secret" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "purpose" "SecretPurpose" NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Secret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSecretGrant" (
    "agentId" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "envVar" TEXT NOT NULL,

    CONSTRAINT "AgentSecretGrant_pkey" PRIMARY KEY ("agentId","secretId","envVar")
);

-- CreateTable
CREATE TABLE "EnvironmentSecret" (
    "environmentId" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "envVar" TEXT NOT NULL,

    CONSTRAINT "EnvironmentSecret_pkey" PRIMARY KEY ("environmentId","secretId","envVar")
);

-- CreateTable
CREATE TABLE "TaskTemplate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "variables" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskTemplateStep" (
    "id" TEXT NOT NULL,
    "taskTemplateId" TEXT NOT NULL,
    "assigneeAgentId" TEXT,
    "stepIndex" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "assigneeType" "AssigneeType" NOT NULL,
    "prompt" TEXT NOT NULL,
    "approvalGate" BOOLEAN NOT NULL DEFAULT false,
    "attachmentsFromPrevious" BOOLEAN NOT NULL DEFAULT false,
    "spawnPolicy" JSONB,

    CONSTRAINT "TaskTemplateStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "assigneeAgentId" TEXT,
    "templateId" TEXT,
    "followUpTaskId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'todo',
    "assigneeType" "AssigneeType" NOT NULL DEFAULT 'agent',
    "approvalGate" BOOLEAN NOT NULL DEFAULT false,
    "chainId" TEXT,
    "chainIndex" INTEGER,
    "scheduleKind" "ScheduleKind" NOT NULL DEFAULT 'once-now',
    "runAt" TIMESTAMP(3),
    "cron" TEXT,
    "timezone" TEXT,
    "maxDurationMin" INTEGER NOT NULL DEFAULT 120,
    "stallTimeoutMin" INTEGER NOT NULL DEFAULT 10,
    "maxSessionsPerTask" INTEGER NOT NULL DEFAULT 3,
    "spendCap" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAttachment" (
    "taskId" TEXT NOT NULL,
    "fileObjectId" TEXT NOT NULL,

    CONSTRAINT "TaskAttachment_pkey" PRIMARY KEY ("taskId","fileObjectId")
);

-- CreateTable
CREATE TABLE "TaskActivity" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "body" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "dodApproved" BOOLEAN NOT NULL DEFAULT false,
    "status" "GoalStatus" NOT NULL DEFAULT 'paused',
    "spendCap" DECIMAL(12,2),
    "spendUsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "maxDurationMin" INTEGER DEFAULT 120,
    "stallTimeoutMin" INTEGER NOT NULL DEFAULT 10,
    "maxSessionsPerTask" INTEGER NOT NULL DEFAULT 3,
    "stuckThreshold" INTEGER NOT NULL DEFAULT 19,
    "runnerPreference" "RunnerPreference" NOT NULL DEFAULT 'auto',
    "sharedFolderPath" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalDefinitionItem" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "itemIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoalDefinitionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalProgressEntry" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "sessionId" TEXT,
    "body" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalProgressEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "taskId" TEXT,
    "goalId" TEXT,
    "runner" "RunnerKind" NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'starting',
    "runtimeHandle" TEXT,
    "toolCallLog" JSONB[],
    "maxDurationMin" INTEGER NOT NULL DEFAULT 120,
    "stallTimeoutMin" INTEGER NOT NULL DEFAULT 10,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastToolCallAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "costUsd" DECIMAL(12,4),
    "commitShas" TEXT[],
    "failureReason" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxMessage" (
    "id" TEXT NOT NULL,
    "from" "InboxSender" NOT NULL,
    "agentId" TEXT,
    "sessionId" TEXT,
    "taskId" TEXT,
    "goalId" TEXT,
    "kind" "InboxKind" NOT NULL DEFAULT 'text',
    "body" TEXT NOT NULL,
    "choices" JSONB,
    "selectedChoiceId" TEXT,
    "status" "InboxStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trigger" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "webhookSecretId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "jobPrompt" TEXT NOT NULL,
    "payloadMapping" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "taskTemplateId" TEXT,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "taskBody" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileObject" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileObject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE INDEX "Environment_projectId_idx" ON "Environment"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Environment_projectId_name_key" ON "Environment"("projectId", "name");

-- CreateIndex
CREATE INDEX "Agent_projectId_idx" ON "Agent"("projectId");

-- CreateIndex
CREATE INDEX "Agent_environmentId_idx" ON "Agent"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_projectId_name_key" ON "Agent"("projectId", "name");

-- CreateIndex
CREATE INDEX "Skill_projectId_idx" ON "Skill"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_projectId_slug_key" ON "Skill"("projectId", "slug");

-- CreateIndex
CREATE INDEX "AgentSkill_skillId_idx" ON "AgentSkill"("skillId");

-- CreateIndex
CREATE INDEX "MCPConnection_projectId_idx" ON "MCPConnection"("projectId");

-- CreateIndex
CREATE INDEX "MCPConnection_credentialSecretId_idx" ON "MCPConnection"("credentialSecretId");

-- CreateIndex
CREATE UNIQUE INDEX "MCPConnection_projectId_name_key" ON "MCPConnection"("projectId", "name");

-- CreateIndex
CREATE INDEX "AgentMCPConnection_mcpConnectionId_idx" ON "AgentMCPConnection"("mcpConnectionId");

-- CreateIndex
CREATE INDEX "Repo_projectId_idx" ON "Repo"("projectId");

-- CreateIndex
CREATE INDEX "Repo_credentialSecretId_idx" ON "Repo"("credentialSecretId");

-- CreateIndex
CREATE UNIQUE INDEX "Repo_projectId_name_key" ON "Repo"("projectId", "name");

-- CreateIndex
CREATE INDEX "AgentRepoAccess_repoId_idx" ON "AgentRepoAccess"("repoId");

-- CreateIndex
CREATE INDEX "FilesystemGrant_agentId_idx" ON "FilesystemGrant"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "FilesystemGrant_agentId_folderPath_key" ON "FilesystemGrant"("agentId", "folderPath");

-- CreateIndex
CREATE INDEX "AgentCollaboration_allowedAgentId_idx" ON "AgentCollaboration"("allowedAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "Secret_name_key" ON "Secret"("name");

-- CreateIndex
CREATE INDEX "AgentSecretGrant_secretId_idx" ON "AgentSecretGrant"("secretId");

-- CreateIndex
CREATE INDEX "EnvironmentSecret_secretId_idx" ON "EnvironmentSecret"("secretId");

-- CreateIndex
CREATE INDEX "TaskTemplate_projectId_idx" ON "TaskTemplate"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskTemplate_projectId_name_key" ON "TaskTemplate"("projectId", "name");

-- CreateIndex
CREATE INDEX "TaskTemplateStep_assigneeAgentId_idx" ON "TaskTemplateStep"("assigneeAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskTemplateStep_taskTemplateId_stepIndex_key" ON "TaskTemplateStep"("taskTemplateId", "stepIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Task_followUpTaskId_key" ON "Task"("followUpTaskId");

-- CreateIndex
CREATE INDEX "Task_projectId_status_idx" ON "Task"("projectId", "status");

-- CreateIndex
CREATE INDEX "Task_assigneeAgentId_idx" ON "Task"("assigneeAgentId");

-- CreateIndex
CREATE INDEX "Task_templateId_idx" ON "Task"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_chainId_chainIndex_key" ON "Task"("chainId", "chainIndex");

-- CreateIndex
CREATE INDEX "TaskAttachment_fileObjectId_idx" ON "TaskAttachment"("fileObjectId");

-- CreateIndex
CREATE INDEX "TaskActivity_taskId_createdAt_idx" ON "TaskActivity"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "Goal_projectId_status_idx" ON "Goal"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GoalDefinitionItem_goalId_itemIndex_key" ON "GoalDefinitionItem"("goalId", "itemIndex");

-- CreateIndex
CREATE INDEX "GoalProgressEntry_goalId_createdAt_idx" ON "GoalProgressEntry"("goalId", "createdAt");

-- CreateIndex
CREATE INDEX "GoalProgressEntry_sessionId_idx" ON "GoalProgressEntry"("sessionId");

-- CreateIndex
CREATE INDEX "Session_status_startedAt_idx" ON "Session"("status", "startedAt");

-- CreateIndex
CREATE INDEX "Session_agentId_idx" ON "Session"("agentId");

-- CreateIndex
CREATE INDEX "Session_taskId_idx" ON "Session"("taskId");

-- CreateIndex
CREATE INDEX "Session_goalId_idx" ON "Session"("goalId");

-- CreateIndex
CREATE INDEX "InboxMessage_status_createdAt_idx" ON "InboxMessage"("status", "createdAt");

-- CreateIndex
CREATE INDEX "InboxMessage_agentId_idx" ON "InboxMessage"("agentId");

-- CreateIndex
CREATE INDEX "InboxMessage_sessionId_idx" ON "InboxMessage"("sessionId");

-- CreateIndex
CREATE INDEX "InboxMessage_taskId_idx" ON "InboxMessage"("taskId");

-- CreateIndex
CREATE INDEX "InboxMessage_goalId_idx" ON "InboxMessage"("goalId");

-- CreateIndex
CREATE INDEX "Trigger_webhookSecretId_idx" ON "Trigger"("webhookSecretId");

-- CreateIndex
CREATE INDEX "Trigger_agentId_idx" ON "Trigger"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "Trigger_projectId_name_key" ON "Trigger"("projectId", "name");

-- CreateIndex
CREATE INDEX "Automation_agentId_idx" ON "Automation"("agentId");

-- CreateIndex
CREATE INDEX "Automation_taskTemplateId_idx" ON "Automation"("taskTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "Automation_projectId_name_key" ON "Automation"("projectId", "name");

-- CreateIndex
CREATE INDEX "FileObject_projectId_idx" ON "FileObject"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "FileObject_projectId_path_key" ON "FileObject"("projectId", "path");

-- AddForeignKey
ALTER TABLE "Environment" ADD CONSTRAINT "Environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCPConnection" ADD CONSTRAINT "MCPConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MCPConnection" ADD CONSTRAINT "MCPConnection_credentialSecretId_fkey" FOREIGN KEY ("credentialSecretId") REFERENCES "Secret"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMCPConnection" ADD CONSTRAINT "AgentMCPConnection_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMCPConnection" ADD CONSTRAINT "AgentMCPConnection_mcpConnectionId_fkey" FOREIGN KEY ("mcpConnectionId") REFERENCES "MCPConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repo" ADD CONSTRAINT "Repo_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repo" ADD CONSTRAINT "Repo_credentialSecretId_fkey" FOREIGN KEY ("credentialSecretId") REFERENCES "Secret"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRepoAccess" ADD CONSTRAINT "AgentRepoAccess_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRepoAccess" ADD CONSTRAINT "AgentRepoAccess_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "Repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilesystemGrant" ADD CONSTRAINT "FilesystemGrant_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCollaboration" ADD CONSTRAINT "AgentCollaboration_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCollaboration" ADD CONSTRAINT "AgentCollaboration_allowedAgentId_fkey" FOREIGN KEY ("allowedAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSecretGrant" ADD CONSTRAINT "AgentSecretGrant_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSecretGrant" ADD CONSTRAINT "AgentSecretGrant_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "Secret"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvironmentSecret" ADD CONSTRAINT "EnvironmentSecret_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvironmentSecret" ADD CONSTRAINT "EnvironmentSecret_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "Secret"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTemplate" ADD CONSTRAINT "TaskTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTemplateStep" ADD CONSTRAINT "TaskTemplateStep_taskTemplateId_fkey" FOREIGN KEY ("taskTemplateId") REFERENCES "TaskTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTemplateStep" ADD CONSTRAINT "TaskTemplateStep_assigneeAgentId_fkey" FOREIGN KEY ("assigneeAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeAgentId_fkey" FOREIGN KEY ("assigneeAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "TaskTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_followUpTaskId_fkey" FOREIGN KEY ("followUpTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAttachment" ADD CONSTRAINT "TaskAttachment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAttachment" ADD CONSTRAINT "TaskAttachment_fileObjectId_fkey" FOREIGN KEY ("fileObjectId") REFERENCES "FileObject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskActivity" ADD CONSTRAINT "TaskActivity_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalDefinitionItem" ADD CONSTRAINT "GoalDefinitionItem_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalProgressEntry" ADD CONSTRAINT "GoalProgressEntry_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalProgressEntry" ADD CONSTRAINT "GoalProgressEntry_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxMessage" ADD CONSTRAINT "InboxMessage_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxMessage" ADD CONSTRAINT "InboxMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxMessage" ADD CONSTRAINT "InboxMessage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboxMessage" ADD CONSTRAINT "InboxMessage_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trigger" ADD CONSTRAINT "Trigger_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trigger" ADD CONSTRAINT "Trigger_webhookSecretId_fkey" FOREIGN KEY ("webhookSecretId") REFERENCES "Secret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trigger" ADD CONSTRAINT "Trigger_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_taskTemplateId_fkey" FOREIGN KEY ("taskTemplateId") REFERENCES "TaskTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileObject" ADD CONSTRAINT "FileObject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
