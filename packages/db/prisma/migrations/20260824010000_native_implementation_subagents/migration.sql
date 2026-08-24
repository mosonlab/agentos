ALTER TABLE "Run"
  ADD COLUMN "subagentModel" TEXT,
  ADD COLUMN "subagentMaxConcurrent" INTEGER;

-- Preserve launch capability for implementation Runs already in flight when
-- this migration replaces the legacy executioner subprocess profiles.
UPDATE "Run" AS run
SET "subagentModel" = 'gpt-5.6-luna:max',
    "subagentMaxConcurrent" = 8
FROM "Task" AS task
JOIN "TaskTemplateStep" AS step ON step."id" = task."templateStepId"
JOIN "TaskTemplate" AS template ON template."id" = step."taskTemplateId"
WHERE run."taskId" = task."id"
  AND run."status" IN ('queued', 'claimed', 'provisioning', 'running', 'waiting-inbox')
  AND run."runner" = 'codex'
  AND step."outputKind" = 'implementation'
  AND (
    (template."name" = 'compound-engineer-workflow' AND step."stepIndex" = 5)
    OR (template."name" = 'direct-engineer-workflow' AND step."stepIndex" = 1)
  );

ALTER TABLE "Agent"
  DROP CONSTRAINT IF EXISTS "Agent_ordinary_subprocess_pair_check",
  DROP CONSTRAINT IF EXISTS "Agent_elevated_subprocess_pair_check",
  DROP COLUMN "ordinarySubprocessModel",
  DROP COLUMN "ordinarySubprocessCodexServiceTier",
  DROP COLUMN "elevatedSubprocessModel",
  DROP COLUMN "elevatedSubprocessCodexServiceTier";

ALTER TABLE "Run"
  DROP CONSTRAINT IF EXISTS "Run_ordinary_subprocess_pair_check",
  DROP CONSTRAINT IF EXISTS "Run_elevated_subprocess_pair_check",
  DROP COLUMN "subprocessModel",
  DROP COLUMN "subprocessCodexServiceTier",
  DROP COLUMN "elevatedSubprocessModel",
  DROP COLUMN "elevatedSubprocessCodexServiceTier",
  ADD CONSTRAINT "Run_native_subagent_snapshot_check" CHECK (
    ("subagentModel" IS NULL AND "subagentMaxConcurrent" IS NULL)
    OR (
      "runner" = 'codex'
      AND "subagentModel" = 'gpt-5.6-luna:max'
      AND "subagentMaxConcurrent" IS NOT NULL
      AND "subagentMaxConcurrent" = 8
    )
  );
