CREATE TYPE "MergeRecoveryRefusalCode" AS ENUM (
  'activation-authorization-stale',
  'head-adoption-conflict'
);

ALTER TABLE "MergeRecoveryAttempt"
  ADD COLUMN "refusalCode" "MergeRecoveryRefusalCode";

UPDATE "MergeRecoveryAttempt"
SET "refusalCode" = CASE "failureReason"
  WHEN 'readiness evaluation failed: Recovery activation authorization is not fresh for the recovered exact head and current base'
    THEN 'activation-authorization-stale'::"MergeRecoveryRefusalCode"
  WHEN 'readiness evaluation failed: Recovery authorization could not adopt the verified regression head'
    THEN 'head-adoption-conflict'::"MergeRecoveryRefusalCode"
END
WHERE "failureReason" IN (
  'readiness evaluation failed: Recovery activation authorization is not fresh for the recovered exact head and current base',
  'readiness evaluation failed: Recovery authorization could not adopt the verified regression head'
);

CREATE INDEX "MergeRecoveryAttempt_status_refusalCode_updatedAt_idx"
  ON "MergeRecoveryAttempt"("status", "refusalCode", "updatedAt");
