CREATE TYPE "MergeLeaseEventState" AS ENUM (
  'handoff-pending',
  'release-deferred',
  'released',
  'invalid'
);

CREATE TABLE "MergeLeaseEvent" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "chainId" TEXT NOT NULL,
  "leaseRef" TEXT,
  "leaseSha" TEXT,
  "state" "MergeLeaseEventState" NOT NULL,
  "owningTaskId" TEXT NOT NULL,
  "handedOffRunId" TEXT,
  "handedOffAt" TIMESTAMP(3),
  "deferredAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "acquiredAt" TIMESTAMP(3),
  "failureDetail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MergeLeaseEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MergeLeaseEvent_shape_check" CHECK (
    ("handedOffRunId" IS NULL) = ("handedOffAt" IS NULL)
    AND NOT ("handedOffAt" IS NOT NULL AND "deferredAt" IS NOT NULL)
    AND CASE "state"
      WHEN 'handoff-pending' THEN
        "handedOffAt" IS NOT NULL AND "deferredAt" IS NULL
        AND "settledAt" IS NULL AND "leaseSha" IS NULL
      WHEN 'release-deferred' THEN
        "handedOffAt" IS NULL AND "deferredAt" IS NOT NULL
        AND "settledAt" IS NULL AND "leaseSha" IS NULL
        AND "failureDetail" IS NOT NULL
      WHEN 'released' THEN "settledAt" IS NOT NULL
      WHEN 'invalid' THEN "settledAt" IS NOT NULL AND "failureDetail" IS NOT NULL
      ELSE false
    END
  )
);

CREATE UNIQUE INDEX "MergeLeaseEvent_projectId_chainId_leaseSha_key"
ON "MergeLeaseEvent"("projectId", "chainId", "leaseSha");

CREATE UNIQUE INDEX "MergeLeaseEvent_projectId_chainId_handedOffRunId_key"
ON "MergeLeaseEvent"("projectId", "chainId", "handedOffRunId");

CREATE UNIQUE INDEX "MergeLeaseEvent_one_open_per_target_key"
ON "MergeLeaseEvent"("projectId", "chainId")
WHERE "state" IN ('handoff-pending', 'release-deferred');

CREATE INDEX "MergeLeaseEvent_state_handedOffAt_id_idx"
ON "MergeLeaseEvent"("state", "handedOffAt", "id");

CREATE INDEX "MergeLeaseEvent_state_deferredAt_id_idx"
ON "MergeLeaseEvent"("state", "deferredAt", "id");

CREATE INDEX "MergeLeaseEvent_owningTaskId_idx"
ON "MergeLeaseEvent"("owningTaskId");

ALTER TABLE "MergeLeaseEvent"
ADD CONSTRAINT "MergeLeaseEvent_owningTaskId_fkey"
FOREIGN KEY ("owningTaskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MergeLeaseEvent"
ADD CONSTRAINT "MergeLeaseEvent_handedOffRunId_fkey"
FOREIGN KEY ("handedOffRunId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Carry forward only unresolved legacy events. TaskActivity remains the
-- operator history, while every read after this migration uses this table.
WITH latest_handoffs AS (
  SELECT DISTINCT ON (activity.metadata->>'toRunId')
    activity.id,
    task."projectId",
    activity.metadata->>'chainId' AS "chainId",
    activity."taskId" AS "owningTaskId",
    activity.metadata->>'toRunId' AS "handedOffRunId",
    activity.metadata->>'state' AS state,
    activity."createdAt" AS "eventAt"
  FROM "TaskActivity" AS activity
  JOIN "Task" AS task ON task.id = activity."taskId"
  JOIN "Run" AS run ON run.id = activity.metadata->>'toRunId'
  WHERE activity."actorType" = 'control-plane'
    AND activity.metadata->>'kind' = 'mergeTail.leaseHandoff'
    AND activity.metadata->>'toRunId' IS NOT NULL
    AND activity.metadata->>'chainId' IS NOT NULL
    AND run."taskId" = activity."taskId"
  ORDER BY activity.metadata->>'toRunId', activity."createdAt" DESC, activity.id DESC
), unresolved_deferrals AS (
  SELECT
    deferred.id,
    deferred.metadata->>'projectId' AS "projectId",
    deferred.metadata->>'chainId' AS "chainId",
    deferred."taskId" AS "owningTaskId",
    deferred.metadata->>'failureDetail' AS "failureDetail",
    deferred."createdAt" AS "eventAt"
  FROM "TaskActivity" AS deferred
  WHERE deferred."actorType" = 'control-plane'
    AND deferred.metadata->>'kind' = 'mergeTail.leaseRelease'
    AND deferred.metadata->>'state' = 'release-deferred'
    AND deferred.metadata->>'projectId' IS NOT NULL
    AND deferred.metadata->>'chainId' IS NOT NULL
    AND deferred.metadata->>'taskId' = deferred."taskId"
    AND deferred.metadata->>'failureDetail' IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "TaskActivity" AS terminal
      WHERE terminal."actorType" = 'control-plane'
        AND terminal.metadata->>'kind' = 'mergeTail.leaseRelease'
        AND terminal.metadata->>'deferredActivityId' = deferred.id
        AND terminal.metadata->>'state' IN ('released', 'invalid')
    )
), candidates AS (
  SELECT
    'legacy-lease-handoff:' || id AS id,
    "projectId",
    "chainId",
    'handoff-pending'::"MergeLeaseEventState" AS state,
    "owningTaskId",
    "handedOffRunId",
    "eventAt" AS "handedOffAt",
    NULL::TIMESTAMP(3) AS "deferredAt",
    NULL::TEXT AS "failureDetail",
    "eventAt"
  FROM latest_handoffs
  WHERE state = 'pending'
  UNION ALL
  SELECT
    'legacy-lease-deferral:' || id,
    "projectId",
    "chainId",
    'release-deferred'::"MergeLeaseEventState",
    "owningTaskId",
    NULL,
    NULL,
    "eventAt",
    "failureDetail",
    "eventAt"
  FROM unresolved_deferrals
), ranked AS (
  SELECT *, row_number() OVER (
    PARTITION BY "projectId", "chainId"
    ORDER BY "eventAt" DESC, id DESC
  ) AS position
  FROM candidates
)
INSERT INTO "MergeLeaseEvent" (
  id, "projectId", "chainId", state, "owningTaskId", "handedOffRunId",
  "handedOffAt", "deferredAt", "failureDetail", "createdAt", "updatedAt"
)
SELECT
  id, "projectId", "chainId", state, "owningTaskId", "handedOffRunId",
  "handedOffAt", "deferredAt", "failureDetail", "eventAt", "eventAt"
FROM ranked
WHERE position = 1;

DROP INDEX "TaskActivity_release_deferred_createdAt_id_idx";
