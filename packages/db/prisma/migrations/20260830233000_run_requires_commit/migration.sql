ALTER TABLE "TaskTemplateStep"
ADD COLUMN "requiresCommit" BOOLEAN NOT NULL DEFAULT true;

-- Canonical Chain Steps that can complete through a durable output keep
-- publishing their branch, but do not require HEAD to advance. Apply the
-- contract to current and retired canonical rows so an existing Task retries
-- with the corrected policy instead of remaining bound to the old default.
UPDATE "TaskTemplateStep" AS step
SET "requiresCommit" = false
FROM "TaskTemplate" AS template
WHERE step."taskTemplateId" = template.id
  AND (
    template.name IN ('direct-engineer-workflow', 'compound-engineer-workflow')
    OR template.name LIKE 'direct-engineer-workflow-legacy-%'
    OR template.name LIKE 'compound-engineer-workflow-legacy-%'
  )
  AND step."outputKind" NOT IN ('plan', 'implementation');

ALTER TABLE "Run"
ADD COLUMN "requiresCommit" BOOLEAN NOT NULL DEFAULT true;
