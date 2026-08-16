-- Guard: FileObject must be empty (spec §9 — stop and escalate otherwise).
DO $$
DECLARE n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM "FileObject";
  IF n > 0 THEN
    RAISE EXCEPTION 'FileObject holds % rows; expected 0 — abort (spec §9)', n;
  END IF;
END $$;

-- FilesystemGrant rows written before folderPath semantics existed (A5).
DELETE FROM "FilesystemGrant";

DROP TABLE "TaskAttachment";
DROP TABLE "FileObject";
