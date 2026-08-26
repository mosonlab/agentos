-- Cross-chain dispatch binding. The successor first task stores a nullable,
-- one-to-one pointer to the predecessor chain's terminal task.

ALTER TABLE "Task"
  ADD COLUMN "dispatchAfterTaskId" TEXT;

CREATE UNIQUE INDEX "Task_dispatchAfterTaskId_key"
  ON "Task"("dispatchAfterTaskId");

-- The Prisma relation needs the composite target identity to keep a binding in
-- its project. The scalar unique index above is still the one-to-one pointer
-- invariant; this redundant composite index is required by Prisma's one-to-one
-- relation validator and is used by the composite foreign key below.
CREATE UNIQUE INDEX "Task_dispatchAfterTaskId_projectId_key"
  ON "Task"("dispatchAfterTaskId", "projectId");

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_dispatchAfterTaskId_projectId_fkey"
  FOREIGN KEY ("dispatchAfterTaskId", "projectId")
  REFERENCES "Task"("id", "projectId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_dispatch_binding_shape_check" CHECK (
    "dispatchAfterTaskId" IS NULL
    OR ("chainId" IS NOT NULL AND "goalId" IS NULL AND "dispatchAfterTaskId" <> "id")
  );
