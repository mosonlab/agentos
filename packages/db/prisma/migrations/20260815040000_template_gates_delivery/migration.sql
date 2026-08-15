ALTER TABLE "TaskTemplateStep"
  ADD COLUMN "runner" "RunnerKind",
  ADD COLUMN "outputKind" TEXT NOT NULL DEFAULT 'result';

ALTER TABLE "Task"
  ADD COLUMN "templateStepId" TEXT;

CREATE TABLE "TaskStepOutput" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "runId" TEXT,
  "kind" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaskStepOutput_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Run"
  ADD COLUMN "pushRemote" TEXT,
  ADD COLUMN "pushError" TEXT,
  ADD COLUMN "pullRequestUrl" TEXT,
  ADD COLUMN "pullRequestNumber" INTEGER,
  ADD COLUMN "deliveryInstructions" TEXT;

ALTER TABLE "InboxMessage"
  ADD COLUMN "gateTaskId" TEXT;

CREATE INDEX "Task_templateStepId_idx" ON "Task"("templateStepId");
CREATE UNIQUE INDEX "TaskStepOutput_taskId_key" ON "TaskStepOutput"("taskId");
CREATE INDEX "TaskStepOutput_runId_idx" ON "TaskStepOutput"("runId");
CREATE INDEX "InboxMessage_gateTaskId_status_idx" ON "InboxMessage"("gateTaskId", "status");

ALTER TABLE "Task" ADD CONSTRAINT "Task_templateStepId_fkey" FOREIGN KEY ("templateStepId") REFERENCES "TaskTemplateStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaskStepOutput" ADD CONSTRAINT "TaskStepOutput_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskStepOutput" ADD CONSTRAINT "TaskStepOutput_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InboxMessage" ADD CONSTRAINT "InboxMessage_gateTaskId_fkey" FOREIGN KEY ("gateTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
