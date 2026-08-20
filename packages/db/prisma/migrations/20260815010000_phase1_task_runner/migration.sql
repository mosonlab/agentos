-- Phase 1 task execution state.
ALTER TABLE "Task"
ADD COLUMN "workingDirectory" TEXT,
ADD COLUMN "failureReason" TEXT;

ALTER TABLE "Session"
ADD COLUMN "runnerId" TEXT,
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "heartbeatAt" TIMESTAMP(3);

CREATE INDEX "Session_status_leaseExpiresAt_idx"
ON "Session"("status", "leaseExpiresAt");
