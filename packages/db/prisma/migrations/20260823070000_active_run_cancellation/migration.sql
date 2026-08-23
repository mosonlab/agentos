ALTER TABLE "Run"
ADD COLUMN "cancelRequestId" TEXT,
ADD COLUMN "cancelReason" TEXT,
ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN "cancelAcknowledgedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Run_cancelRequestId_key" ON "Run"("cancelRequestId");
