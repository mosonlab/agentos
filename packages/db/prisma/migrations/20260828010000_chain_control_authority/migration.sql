-- Chain hold authority. This migration is additive: existing Tasks, Runs and
-- merge-lease rows are untouched, and a failed deploy leaves the old schema
-- intact because Prisma runs each migration transactionally.

CREATE TYPE "ChainControlState" AS ENUM ('held', 'released');

CREATE TABLE "ChainControl" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "chainId" TEXT NOT NULL,
  "state" "ChainControlState" NOT NULL DEFAULT 'held',
  "heldLayer" INTEGER,
  "heldAt" TIMESTAMP(3),
  "holdRequestId" TEXT,
  "holdReason" TEXT,
  "releasedAt" TIMESTAMP(3),
  "releaseRequestId" TEXT,
  "holdGeneration" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChainControl_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChainControl_projectId_chainId_key"
  ON "ChainControl"("projectId", "chainId");
CREATE INDEX "ChainControl_projectId_state_idx"
  ON "ChainControl"("projectId", "state");

CREATE TABLE "ChainControlEvent" (
  "id" TEXT NOT NULL,
  "chainControlId" TEXT NOT NULL,
  "kind" "ChainControlState" NOT NULL,
  "layer" INTEGER NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT,
  "requestId" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "holdGeneration" INTEGER NOT NULL,

  CONSTRAINT "ChainControlEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChainControlEvent_chainControlId_kind_requestId_key"
  ON "ChainControlEvent"("chainControlId", "kind", "requestId");
CREATE INDEX "ChainControlEvent_chainControlId_createdAt_idx"
  ON "ChainControlEvent"("chainControlId", "createdAt");

ALTER TABLE "ChainControl"
  ADD CONSTRAINT "ChainControl_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChainControlEvent"
  ADD CONSTRAINT "ChainControlEvent_chainControlId_fkey"
  FOREIGN KEY ("chainControlId") REFERENCES "ChainControl"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
