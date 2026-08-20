CREATE TYPE "InboxChannel" AS ENUM ('feishu');
CREATE TYPE "InboxDeliveryStatus" AS ENUM ('pending', 'sending', 'delivered', 'failed');

ALTER TABLE "Session" ADD COLUMN "resumeInput" TEXT;

ALTER TABLE "InboxMessage"
  ADD COLUMN "threadId" TEXT,
  ADD COLUMN "replyToMessageId" TEXT,
  ADD COLUMN "channel" "InboxChannel" NOT NULL DEFAULT 'feishu',
  ADD COLUMN "dedupeKey" TEXT,
  ADD COLUMN "externalMessageId" TEXT,
  ADD COLUMN "externalActionId" TEXT,
  ADD COLUMN "deliveryStatus" "InboxDeliveryStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextDeliveryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "lastDeliveryError" TEXT;

CREATE TABLE "InboxThread" (
  "id" TEXT NOT NULL,
  "channel" "InboxChannel" NOT NULL DEFAULT 'feishu',
  "externalChatId" TEXT NOT NULL,
  "sessionId" TEXT,
  "taskId" TEXT,
  "goalId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InboxThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InboxExternalEvent" (
  "id" TEXT NOT NULL,
  "channel" "InboxChannel" NOT NULL DEFAULT 'feishu',
  "externalEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "processingError" TEXT,
  CONSTRAINT "InboxExternalEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InboxDecision" (
  "id" TEXT NOT NULL,
  "inboxMessageId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "externalEventId" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "actorOpenId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboxDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InboxConnectionWindow" (
  "id" TEXT NOT NULL,
  "instanceId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "connectedAt" TIMESTAMP(3),
  "disconnectedAt" TIMESTAMP(3),
  "reconnectCount" INTEGER NOT NULL DEFAULT 0,
  "closeReason" TEXT,
  CONSTRAINT "InboxConnectionWindow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InboxThread_channel_externalChatId_sessionId_key" ON "InboxThread"("channel", "externalChatId", "sessionId");
CREATE INDEX "InboxThread_externalChatId_idx" ON "InboxThread"("externalChatId");
CREATE INDEX "InboxThread_sessionId_idx" ON "InboxThread"("sessionId");
CREATE UNIQUE INDEX "InboxExternalEvent_channel_externalEventId_key" ON "InboxExternalEvent"("channel", "externalEventId");
CREATE INDEX "InboxExternalEvent_processedAt_receivedAt_idx" ON "InboxExternalEvent"("processedAt", "receivedAt");
CREATE UNIQUE INDEX "InboxDecision_externalEventId_key" ON "InboxDecision"("externalEventId");
CREATE INDEX "InboxDecision_inboxMessageId_idx" ON "InboxDecision"("inboxMessageId");
CREATE INDEX "InboxDecision_runId_idx" ON "InboxDecision"("runId");
CREATE INDEX "InboxConnectionWindow_instanceId_startedAt_idx" ON "InboxConnectionWindow"("instanceId", "startedAt");
CREATE INDEX "InboxConnectionWindow_disconnectedAt_idx" ON "InboxConnectionWindow"("disconnectedAt");
CREATE UNIQUE INDEX "InboxMessage_dedupeKey_key" ON "InboxMessage"("dedupeKey");
CREATE UNIQUE INDEX "InboxMessage_externalMessageId_key" ON "InboxMessage"("externalMessageId");
CREATE UNIQUE INDEX "InboxMessage_externalActionId_key" ON "InboxMessage"("externalActionId");
CREATE INDEX "InboxMessage_threadId_status_createdAt_idx" ON "InboxMessage"("threadId", "status", "createdAt");
CREATE INDEX "InboxMessage_deliveryStatus_nextDeliveryAt_idx" ON "InboxMessage"("deliveryStatus", "nextDeliveryAt");

ALTER TABLE "InboxMessage" ADD CONSTRAINT "InboxMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "InboxThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InboxMessage" ADD CONSTRAINT "InboxMessage_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "InboxMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InboxThread" ADD CONSTRAINT "InboxThread_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InboxThread" ADD CONSTRAINT "InboxThread_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InboxThread" ADD CONSTRAINT "InboxThread_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InboxDecision" ADD CONSTRAINT "InboxDecision_inboxMessageId_fkey" FOREIGN KEY ("inboxMessageId") REFERENCES "InboxMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InboxDecision" ADD CONSTRAINT "InboxDecision_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
