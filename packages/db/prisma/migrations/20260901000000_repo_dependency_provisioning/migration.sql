CREATE TYPE "DependencyProvisioning" AS ENUM ('NONE', 'NPM_CI');

-- Expand first so existing rows can be classified before the required
-- contract is installed. The slash/colon boundary covers HTTPS, SSH URL, and
-- scp-like remotes; lower() makes the historical GitHub spelling match
-- independent of case, and the suffix permits the ordinary optional .git.
ALTER TABLE "Repo"
ADD COLUMN "dependencyProvisioning" "DependencyProvisioning";

UPDATE "Repo"
SET "dependencyProvisioning" = CASE
  WHEN lower("remoteUrl") ~ '(^|[/:])mosonlab/(agentos|anneal)([.]git)?$'
    THEN 'NPM_CI'::"DependencyProvisioning"
  ELSE 'NONE'::"DependencyProvisioning"
END;

ALTER TABLE "Repo"
ALTER COLUMN "dependencyProvisioning" SET NOT NULL;
