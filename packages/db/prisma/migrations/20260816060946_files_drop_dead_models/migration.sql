-- Guard: FileObject must be empty (spec §9 — stop and escalate otherwise).
DO $$
DECLARE n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM "FileObject";
  IF n > 0 THEN
    RAISE EXCEPTION 'FileObject holds % rows; expected 0 — abort (spec §9)', n;
  END IF;
END $$;

-- FilesystemGrant rows written before folderPath semantics existed (A5). The delete is
-- deliberate -- those rows hold pre-semantics absolute paths, which normalizeRelPath
-- rejects and grantAdmits skips, so they are already fail-closed -- but migrate deploy
-- prints no per-statement counts, so say out loud how many were removed.
DO $$
DECLARE n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM "FilesystemGrant";
  DELETE FROM "FilesystemGrant";
  RAISE NOTICE 'Deleted % pre-semantics FilesystemGrant row(s); re-grant folders per the deployment runbook.', n;
END $$;

DROP TABLE "TaskAttachment";
DROP TABLE "FileObject";
