ALTER TABLE "RunnerBackendState"
ADD COLUMN "cliAvailable" BOOLEAN,
ADD COLUMN "cliResolvedPath" TEXT,
ADD COLUMN "cliAvailabilityReason" TEXT,
ADD COLUMN "cliUnavailableSince" TIMESTAMP(3),
ADD COLUMN "cliAvailabilityOutageKey" TEXT,
ADD COLUMN "lastAvailabilityAt" TIMESTAMP(3);
