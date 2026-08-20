-- Batch 2 intentionally removes the unused Trigger, Automation, and
-- InboxConnectionWindow models. Any residual rows in these tables are accepted loss.
DROP TABLE "Trigger";
DROP TABLE "Automation";
DROP TABLE "InboxConnectionWindow";

ALTER TABLE "TaskTemplate"
  ADD COLUMN "webhookSecretId" TEXT,
  ADD COLUMN "webhookRepoId" TEXT,
  ADD COLUMN "webhookPayloadMapping" JSONB;

CREATE INDEX "TaskTemplate_webhookSecretId_idx" ON "TaskTemplate"("webhookSecretId");
CREATE INDEX "TaskTemplate_webhookRepoId_idx" ON "TaskTemplate"("webhookRepoId");
CREATE INDEX "Task_scheduleKind_status_runAt_idx" ON "Task"("scheduleKind", "status", "runAt");

ALTER TABLE "TaskTemplate" ADD CONSTRAINT "TaskTemplate_webhookSecretId_fkey"
  FOREIGN KEY ("webhookSecretId") REFERENCES "Secret"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaskTemplate" ADD CONSTRAINT "TaskTemplate_webhookRepoId_fkey"
  FOREIGN KEY ("webhookRepoId") REFERENCES "Repo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
