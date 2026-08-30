-- Merge readiness owns this machine claim independently of the human-readable
-- Task failure reason. The token is the CAS identity; the timestamp makes
-- abandoned ownership reclaimable without parsing credentials from prose.
ALTER TABLE "Task"
ADD COLUMN "readinessClaimToken" TEXT,
ADD COLUMN "readinessClaimExpiresAt" TIMESTAMP(3),
ADD CONSTRAINT "Task_readiness_claim_pair_check" CHECK (
  ("readinessClaimToken" IS NULL) = ("readinessClaimExpiresAt" IS NULL)
);
