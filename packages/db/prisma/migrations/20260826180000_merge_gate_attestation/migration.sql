-- Merge gate attestations. `MERGE GATE: PASS <oid>` becomes a row bound to the
-- commit the gate signed, so every merge authorization channel can require it
-- instead of re-parsing a Regression verification body.

CREATE TABLE "MergeGateAttestation" (
  "id" TEXT NOT NULL,
  "chainId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "runId" TEXT,
  "headSha" TEXT NOT NULL,
  "baseHeadSha" TEXT NOT NULL,
  "proof" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MergeGateAttestation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MergeGateAttestation_chainId_headSha_key"
  ON "MergeGateAttestation"("chainId", "headSha");

CREATE INDEX "MergeGateAttestation_taskId_idx" ON "MergeGateAttestation"("taskId");

CREATE INDEX "MergeGateAttestation_runId_idx" ON "MergeGateAttestation"("runId");

ALTER TABLE "MergeGateAttestation"
  ADD CONSTRAINT "MergeGateAttestation_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MergeGateAttestation"
  ADD CONSTRAINT "MergeGateAttestation_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "Run"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill from Regression verification v2 outputs already persisted. Those
-- bodies passed the ingestion schema, so the cast below cannot meet a non-JSON
-- row, and the gate proof line was already asserted to name the same oid as
-- `headSha`. Without this, a chain whose Regression step landed before this
-- migration would find no attestation and every authorization channel would
-- refuse it.
INSERT INTO "MergeGateAttestation" (
  "id", "chainId", "taskId", "runId", "headSha", "baseHeadSha", "proof", "createdAt"
)
SELECT
  'bkfl_' || o."id",
  t."chainId",
  o."taskId",
  o."runId",
  o."body"::jsonb ->> 'headSha',
  o."body"::jsonb ->> 'baseHeadSha',
  o."body"::jsonb ->> 'gateProof',
  o."createdAt"
FROM "TaskStepOutput" o
JOIN "Task" t ON t."id" = o."taskId"
WHERE o."kind" = 'regression-verification-v2'
  AND t."chainId" IS NOT NULL
  AND o."body"::jsonb ->> 'outcome' = 'pass'
  AND o."body"::jsonb ->> 'gateProof' = 'MERGE GATE: PASS ' || (o."body"::jsonb ->> 'headSha')
ON CONFLICT ("chainId", "headSha") DO NOTHING;
