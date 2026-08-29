-- Completion age must not move when an operator edits a terminal task. Backfill
-- existing history from the best previously available clock, then maintain the
-- dedicated clock for every writer (including direct workflow updates).
ALTER TABLE "Task" ADD COLUMN "doneAt" TIMESTAMP(3);

UPDATE "Task"
SET "doneAt" = "updatedAt"
WHERE "status" = 'done'::"TaskStatus";

CREATE OR REPLACE FUNCTION "maintainTaskDoneAt"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = 'done'::"TaskStatus"
     AND (TG_OP = 'INSERT' OR OLD."status" <> 'done'::"TaskStatus") THEN
    NEW."doneAt" = CURRENT_TIMESTAMP;
  ELSIF NEW."status" <> 'done'::"TaskStatus" THEN
    NEW."doneAt" = NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Task_maintain_done_at"
BEFORE INSERT OR UPDATE OF "status" ON "Task"
FOR EACH ROW
EXECUTE FUNCTION "maintainTaskDoneAt"();

CREATE INDEX "Task_status_archivedAt_doneAt_id_idx"
ON "Task"("status", "archivedAt", "doneAt", "id");
