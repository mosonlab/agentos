// What `npm run test:db` does once it has decided to give every test file a
// database of its own. The script that calls this (scripts/dbtest.mjs) owns the
// process and the child; this owns the order things happen in, which is where
// the cleanup guarantees live.
//
// The shape of the guarantee: nothing is created before something is watching
// for a signal, everything created is remembered at the moment it exists rather
// than when it is finished with, and the run's result is not green unless the
// cleanup was.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  connectionLimit,
  fileDirectoryName,
  fileLabel,
  isolatedRootVariables,
  perFileDatabaseUrl,
  planEnvironmentVariable,
  resolveConcurrency,
  type DbtestAssignment,
  type DbtestPlan,
} from "./dbtest-plan.js";

/** Just enough of ScratchDatabaseManager to run against, and to fake. */
export interface ScratchManagerLike {
  maintenance: {
    $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
  };
  reclaimOrphans(): Promise<{ reclaimed: string[]; skipped: string[] }>;
  createMigrated(label?: string): Promise<{ name: string; url: string }>;
  clone(sourceName: string, label?: string): Promise<{ name: string; url: string }>;
  dropAll(): Promise<Array<{ name: string; error: Error }>>;
  disconnect(): Promise<void>;
}

export interface RunTestsOptions {
  files: string[];
  concurrency: number;
  environment: NodeJS.ProcessEnv;
  /** Aborts when the runner is signalled, so the child can be signalled too. */
  signal: AbortSignal;
}

export interface SignalSource {
  on(signal: NodeJS.Signals, handler: () => void): unknown;
  off(signal: NodeJS.Signals, handler: () => void): unknown;
}

export interface DbtestRunOptions {
  environment: NodeJS.ProcessEnv;
  cpuCount: number;
  files: string[];
  manager: ScratchManagerLike;
  runTests: (options: RunTestsOptions) => Promise<number>;
  log: (message: string) => void;
  signals?: SignalSource;
}

/** The signals a run has to survive as a clean exit rather than an abandoned one. */
export const handledSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/** What a shell reports for a process that died of a signal. */
export const signalExitCode = (signal: NodeJS.Signals): number => (signal === "SIGINT" ? 130 : 143);

/** The code a run that leaked a database gets when its tests all passed. */
export const cleanupFailureExitCode = 1;

/** Every path a test-file process could report as its own entry point. */
const planKeys = (file: string): string[] => {
  const resolved = resolve(file);
  try {
    const real = realpathSync(resolved);
    return real === resolved ? [resolved] : [resolved, real];
  } catch {
    return [resolved];
  }
};

/** A per-file subdirectory of a root the caller exported, created up front. */
const isolatedRoot = (root: string, file: string): string => {
  const directory = join(root, fileDirectoryName(file));
  mkdirSync(directory, { recursive: true });
  return directory;
};

/**
 * Runs the database tests with one database per file, and cleans up after
 * itself on every way out of here: a normal finish, a failing test, a failure
 * while provisioning, and a signal at any point in either.
 *
 * Returns the exit code the run deserves. Cleanup that could not finish makes
 * that code nonzero even when every test passed — a database left on a shared
 * scratch server is a defect of this run, and this run is the only one that can
 * report it as one.
 */
export const runDbtest = async ({
  environment,
  cpuCount,
  files,
  manager,
  runTests,
  log,
  signals = process,
}: DbtestRunOptions): Promise<number> => {
  const concurrency = resolveConcurrency(environment, cpuCount);
  const controller = new AbortController();
  let signalled: NodeJS.Signals | null = null;

  // Installed before anything is created. A signal that arrives while the
  // template is migrating has to reach the same cleanup as one that arrives
  // during the tests, and the only way to hold that is to be listening first.
  const handlers = handledSignals.map((signal): [NodeJS.Signals, () => void] => [
    signal,
    () => {
      signalled ??= signal;
      controller.abort();
    },
  ]);
  for (const [signal, handler] of handlers) signals.on(signal, handler);

  const planDirectory = mkdtempSync(join(tmpdir(), "agentos-dbtest-plan-"));
  const abandoned = (): number => signalExitCode(signalled ?? "SIGTERM");

  const provisionAndRun = async (): Promise<number> => {
    const { reclaimed } = await manager.reclaimOrphans();
    if (reclaimed.length > 0) {
      log(`reclaimed ${reclaimed.length} database(s) from a run that never got to clean up`);
    }
    if (controller.signal.aborted) return abandoned();

    log(`${files.length} files, ${concurrency} at a time, one database each`);
    const template = await manager.createMigrated("template");

    // Asked rather than assumed: the ceiling every file's pool has to fit under
    // is the server's, and a server the caller pointed at may not be the
    // hundred-connection default.
    const ceiling = await manager.maintenance.$queryRawUnsafe<Array<{ max_connections: number }>>(
      "SELECT current_setting('max_connections')::int AS max_connections",
    );
    const maxConnections = ceiling[0]?.max_connections;
    // Guessing here would be guessing at the one number that decides whether
    // every file's pool fits, so refuse instead.
    if (maxConnections === undefined) throw new Error("dbtest-server-max-connections-unknown");
    const limit = connectionLimit(maxConnections, concurrency);

    const plan: DbtestPlan = { files: {} };
    for (const file of files) {
      if (controller.signal.aborted) return abandoned();
      const database = await manager.clone(template.name, fileLabel(file));
      const assignment: DbtestAssignment = { databaseUrl: perFileDatabaseUrl(database.url, limit) };
      for (const [field, variable] of Object.entries(isolatedRootVariables)) {
        const root = environment[variable];
        if (root) assignment[field as keyof typeof isolatedRootVariables] = isolatedRoot(root, file);
      }
      // Both spellings, because the child is told a path and reports the one
      // it was told: a checkout reached through a symlink resolves differently
      // on the two sides, and the preamble must not have to guess which.
      for (const key of planKeys(file)) plan.files[key] = assignment;
    }
    if (controller.signal.aborted) return abandoned();

    const planPath = join(planDirectory, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan));
    log(`template ${template.name} cloned ${files.length} times, ${limit} connections each of ${maxConnections}`);

    return await runTests({
      files,
      concurrency,
      environment: { ...environment, [planEnvironmentVariable]: planPath },
      signal: controller.signal,
    });
  };

  let exitCode: number | null = null;
  let failure: unknown = null;
  try {
    exitCode = await provisionAndRun();
  } catch (error) {
    failure = error;
  }

  for (const [signal, handler] of handlers) signals.off(signal, handler);
  rmSync(planDirectory, { recursive: true, force: true });
  const leaked = await manager.dropAll();
  for (const { name, error } of leaked) log(`could not drop ${name}: ${error.message}`);
  await manager.disconnect();

  // The cleanup runs before this rethrow so that a failure while provisioning
  // still takes its databases with it; the failure itself is what the caller
  // hears about.
  if (failure !== null) throw failure;
  if (leaked.length > 0) {
    log(`${leaked.length} database(s) left behind; say so rather than pass, and the next run will reclaim them`);
    return exitCode === 0 || exitCode === null ? cleanupFailureExitCode : exitCode;
  }
  return exitCode ?? cleanupFailureExitCode;
};
