-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "cachedInputTokens" INTEGER,
ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "outputTokens" INTEGER,
ADD COLUMN     "totalTokens" INTEGER;

-- CreateIndex
CREATE INDEX "Session_projectId_requestedAt_idx" ON "Session"("projectId", "requestedAt");

-- CreateIndex
CREATE INDEX "SessionEvent_runId_seq_idx" ON "SessionEvent"("runId", "seq");
