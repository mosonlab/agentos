import { resolveConcurrency } from "./dbtest-plan.js";

export const regressionVerificationBypass = "regression-verification";
export const runScopeRefusalExitCode = 78;

const dbtestEntryPoint = "test:db -w @anneal/api";
const dbtestRemediation = "npm run test:db -w @anneal/api -- src/<file>.dbtest.ts";

export const runScopeRefusalMessage = (runId: string): string =>
  `run-scope-guard: ${dbtestEntryPoint} refused for Run ${runId}: inside an Anneal Run, verify only the affected workspace using ${dbtestRemediation}; the Regression step owns repository-wide proof and the Merge Gate.`;

export const noScratchDatabaseRefusalMessage = (runId: string): string =>
  `run-scope-guard: ${dbtestEntryPoint} refused for Run ${runId}: an Anneal Run is granted no scratch PostgreSQL, so ${dbtestEntryPoint} is merge gate evidence. Do not attempt it inside a Run, and do not report its absence as a gap.`;

export const dbtestInvocationDecision = ({
  args,
  environment,
  cpuCount,
}: {
  args: string[];
  environment: NodeJS.ProcessEnv;
  cpuCount: number;
}) => {
  const runId = environment.AGENTOS_RUN_ID;
  const nonBypassedRun = Boolean(runId)
    && environment.AGENTOS_RUN_SCOPE_BYPASS !== regressionVerificationBypass;
  // Without TEST_DATABASE_URL every dbtest file dies on import
  // (`scratch-test-database-url-required`), so a Run that names one file fails
  // exactly as loudly as one that names none. Refuse both with the reason.
  if (nonBypassedRun && !environment.TEST_DATABASE_URL) {
    return {
      exitCode: runScopeRefusalExitCode,
      refusal: noScratchDatabaseRefusalMessage(runId ?? ""),
    };
  }
  if (nonBypassedRun && args.length === 0) {
    return {
      exitCode: runScopeRefusalExitCode,
      refusal: runScopeRefusalMessage(runId ?? ""),
    };
  }

  const requestedConcurrency = resolveConcurrency(environment, cpuCount);
  const concurrency = nonBypassedRun ? Math.min(requestedConcurrency, 2) : requestedConcurrency;
  return {
    exitCode: null,
    refusal: null,
    concurrency,
    capLog: concurrency < requestedConcurrency
      ? `capped concurrency from ${requestedConcurrency} to ${concurrency} inside Anneal Run ${runId}`
      : null,
  };
};
