CREATE TYPE "MergeRecoveryStatus" AS ENUM (
  'validating',
  'repairing',
  'awaiting-authorization',
  'blocked-downstream',
  'succeeded',
  'failed'
);

CREATE TABLE "MergeRecoveryAttempt" (
  "id" TEXT NOT NULL,
  "integratorTaskId" TEXT NOT NULL,
  "sourceStopId" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "status" "MergeRecoveryStatus" NOT NULL DEFAULT 'validating',
  "validationAttempts" INTEGER NOT NULL DEFAULT 0,
  "boundSourceRunId" TEXT,
  "authorizationActivityId" TEXT,
  "recoveryRunId" TEXT,
  "readinessTaskId" TEXT,
  "regressionTaskId" TEXT,
  "repository" TEXT,
  "prNumber" INTEGER,
  "targetBranch" TEXT,
  "authorizedHeadSha" TEXT,
  "authorizedBaseSha" TEXT,
  "observedBaseSha" TEXT,
  "currentBaseSha" TEXT,
  "failureReason" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),

  CONSTRAINT "MergeRecoveryAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MergeRecoveryAttempt_sourceStopId_attempt_key"
  ON "MergeRecoveryAttempt"("sourceStopId", "attempt");
CREATE INDEX "MergeRecoveryAttempt_integratorTaskId_status_idx"
  ON "MergeRecoveryAttempt"("integratorTaskId", "status");
CREATE INDEX "MergeRecoveryAttempt_recoveryRunId_idx"
  ON "MergeRecoveryAttempt"("recoveryRunId");
CREATE INDEX "MergeRecoveryAttempt_repository_prNumber_targetBranch_idx"
  ON "MergeRecoveryAttempt"("repository", "prNumber", "targetBranch");

ALTER TABLE "MergeRecoveryAttempt"
  ADD CONSTRAINT "MergeRecoveryAttempt_integratorTaskId_fkey"
  FOREIGN KEY ("integratorTaskId") REFERENCES "Task"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
