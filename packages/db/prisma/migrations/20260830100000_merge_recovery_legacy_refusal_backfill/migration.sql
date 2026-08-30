-- Carry the two historical reopen sentinels into the durable refusal-code
-- column. Once this migration lands, the recovery worker never needs to
-- interpret these operator-facing strings again.
UPDATE "MergeRecoveryAttempt"
SET "refusalCode" = CASE "failureReason"
  WHEN 'source executor run does not have exactly one server-bound merge intent'
    THEN 'pre-intent'::"MergeRecoveryRefusalCode"
  WHEN 'authorized target ref differs from the chain target branch'
    THEN 'target-branch-mismatch'::"MergeRecoveryRefusalCode"
END
WHERE "refusalCode" IS NULL
  AND "failureReason" IN (
    'source executor run does not have exactly one server-bound merge intent',
    'authorized target ref differs from the chain target branch'
  );
