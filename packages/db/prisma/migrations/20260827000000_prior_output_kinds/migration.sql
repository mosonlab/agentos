-- Persist the canonical prior-output input declaration for every template step.
-- An empty array is the safe expand default for existing rows; canonical seed
-- and sync populate it from the reviewed Markdown source.
ALTER TABLE "TaskTemplateStep"
  ADD COLUMN "priorOutputKinds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
