-- Persist the canonical prior-output input declaration for every template step.
-- New rows default to no prior outputs. Existing rows receive an explicit
-- compatibility marker so unfinished pre-whitelist chains retain the former
-- all-prior-output handoff; canonical sync replaces the marker on current
-- canonical rows with declarations from the reviewed Markdown source.
ALTER TABLE "TaskTemplateStep"
  ADD COLUMN "priorOutputKinds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "TaskTemplateStep"
SET "priorOutputKinds" = ARRAY['__legacy_all_prior_outputs__']::TEXT[];
