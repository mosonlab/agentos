import { basename, normalize } from "node:path";

/**
 * The plan a parallel database-test run is executed from.
 *
 * The runner (scripts/dbtest.mjs) builds one before it starts node:test, and
 * the per-child preamble (scripts/dbtest-preamble.mjs) reads its own entry out
 * of it. Everything in this module is pure so both ends — and the unit tests —
 * agree on the same rules without a database.
 */

export interface DbtestAssignment {
  /** The database this file owns for the whole run. */
  databaseUrl: string;
  /** The file's private RUNNER_WORKSPACE_ROOT, when the caller set one. */
  workspaceRoot?: string;
  /** The file's private CONTROL_PLANE_STATE_DIR, when the caller set one. */
  controlPlaneStateDir?: string;
  /** The file's private FILES_ROOT, when the caller set one. */
  filesRoot?: string;
}

export interface DbtestPlan {
  /** Keyed by the absolute path node:test hands the child as argv[1]. */
  files: Record<string, DbtestAssignment>;
}

/** The environment variable the runner uses to hand the plan to its children. */
export const planEnvironmentVariable = "AGENTOS_DBTEST_PLAN";

/**
 * Marks a database that already carries every migration, so the harness skips
 * the drop-schema/`migrate deploy` it would otherwise run per file.
 */
export const preMigratedEnvironmentVariable = "AGENTOS_DBTEST_PREMIGRATED";

/** The per-file roots the runner hands out, and the variable each one sets. */
export const isolatedRootVariables = {
  workspaceRoot: "RUNNER_WORKSPACE_ROOT",
  controlPlaneStateDir: "CONTROL_PLANE_STATE_DIR",
  filesRoot: "FILES_ROOT",
} as const;

/**
 * How many test files run at once.
 *
 * The gate's worker is 4 vCPU / 3.7GB and its data directory is a tmpfs that
 * eats the same RAM, so the default leaves one core for the shared PostgreSQL
 * and the runner itself.
 *
 * The ceiling is not about cores. A test file is not one process: it spawns
 * `npx prisma`, and some of them spawn a real API. Four files already put more
 * than four runnable processes on the machine, and past that the machine is
 * oversubscribed rather than busy — queries that take milliseconds take
 * seconds, and what fails is Prisma's pool timeout rather than anything the
 * tests are about. Measured on a ten-core laptop that was also running another
 * checkout's database suite, eight files failed that way and four did not.
 * AGENTOS_DBTEST_CONCURRENCY overrides both halves for a host that knows
 * better.
 */
export const maximumDefaultConcurrency = 4;

export const resolveConcurrency = (
  environment: NodeJS.ProcessEnv,
  cpuCount: number,
): number => {
  const configured = environment.AGENTOS_DBTEST_CONCURRENCY;
  if (configured !== undefined && configured !== "") {
    if (!/^[1-9][0-9]*$/u.test(configured)) {
      throw new Error(`AGENTOS_DBTEST_CONCURRENCY must be a positive integer, got ${JSON.stringify(configured)}`);
    }
    return Number(configured);
  }
  return Math.max(1, Math.min(cpuCount - 1, maximumDefaultConcurrency));
};

/** True unless the caller explicitly turned per-file databases off. */
export const provisioningRequested = (environment: NodeJS.ProcessEnv): boolean => (
  environment.AGENTOS_DBTEST_PROVISION !== "0"
);

/**
 * Whether the run can hand each file its own database: creating one needs the
 * same opt-in and the same server the scratch-database manager already
 * demands. Without it the run stays on the single shared schema, which only one
 * file at a time may own.
 */
export const provisioningAvailable = (environment: NodeJS.ProcessEnv): boolean => (
  environment.AGENTOS_ALLOW_SCRATCH_DATABASES === "1" && Boolean(environment.TEST_DATABASE_URL)
);

/**
 * The maintenance database on the same server as the test database.
 *
 * `postgres` is the database every PostgreSQL cluster ships with and the one
 * merge-gate.sh already names, so a caller that exported a test URL has
 * exported this one too without knowing it. The manager still re-checks that
 * both URLs name the same server, the same role, and neither is `agentos`.
 */
export const derivedMaintenanceUrl = (testDatabaseUrl: string): string => {
  const url = new URL(testDatabaseUrl);
  url.pathname = "/postgres";
  url.search = "";
  return url.toString();
};

/**
 * Connections a parallel run must not spend: PostgreSQL keeps some slots for
 * superusers, and the runner itself holds a maintenance client throughout.
 */
export const reservedConnections = 10;
/** Clients one test file can have open at once: its own, plus a process it spawned. */
export const clientsPerFile = 2;
export const minimumConnectionLimit = 5;
export const maximumConnectionLimit = 10;

/**
 * The pool ceiling each test file's client gets.
 *
 * Prisma's default is `cores * 2 + 1` — twenty-one on a ten-core machine, which
 * is a fine default for one process and an overdraft for eight of them against
 * a server that will only take a hundred connections. Pools fill lazily, so
 * this is a ceiling rather than a reservation, but a ceiling that cannot add up
 * past the server's is the difference between a slow run and P1001s.
 */
export const connectionLimit = (maxConnections: number, concurrency: number): number => {
  const spendable = Math.max(maxConnections - reservedConnections, concurrency);
  const share = Math.floor(spendable / (concurrency * clientsPerFile));
  return Math.max(minimumConnectionLimit, Math.min(share, maximumConnectionLimit));
};

/**
 * The database URL a test file connects with.
 *
 * `connect_timeout` is five seconds by default, which is a statement about a
 * server that is not there. A gate host running two gates, or a laptop running
 * someone else's suite as well, can take longer than that to answer while being
 * perfectly reachable — and every file paying that toll at once is exactly when
 * it happens. Twenty seconds still fails a server that is genuinely down, well
 * inside the test timeout.
 */
export const perFileDatabaseUrl = (databaseUrl: string, limit: number): string => {
  const url = new URL(databaseUrl);
  url.searchParams.set("connection_limit", String(limit));
  url.searchParams.set("connect_timeout", "20");
  return url.toString();
};

/** A short, PostgreSQL-safe label for a test file: `chain.dbtest.ts` -> `chain`. */
export const fileLabel = (file: string): string => basename(file).replace(/\.dbtest\.ts$/u, "");

/**
 * A directory-safe name for the per-file roots; distinct files stay distinct.
 *
 * Derived from the whole path rather than the basename, because the gate now
 * runs `packages/db` and `packages/api` as one pool and those two suites
 * already contain same-named pairs — `preflight-goal-execution.dbtest.ts` and
 * `service-maintenance-lock.dbtest.ts` exist in both. Keying on the basename
 * hands each pair one set of roots, which is the single thing this function
 * exists to prevent, and it does not fail: the files share state and stay
 * green until one of them cleans up under the other.
 *
 * The path is normalised first so no `..` survives into a directory name and
 * `join` cannot be walked out of the root it was given.
 */
export const fileDirectoryName = (file: string): string => {
  const label = normalize(file)
    .replace(/\.dbtest\.ts$/u, "")
    .replaceAll(/[^A-Za-z0-9_-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  return label === "" ? "dbtest" : label;
};

/**
 * The assignment for the file node:test is running in this process.
 *
 * Throws rather than returns nothing. There is exactly one unsafe way for this
 * lookup to miss — a plan exists, so the files are running several at a time,
 * but this process did not find its own database and would fall back to the one
 * every other file is using. A test file that cannot be told which database is
 * its own must not run at all, so a miss is a failure here rather than a
 * quietly shared schema and an intermittent red somewhere else.
 */
export const assignmentFor = (
  plan: DbtestPlan,
  entryPath: string | undefined,
): DbtestAssignment => {
  if (entryPath === undefined || entryPath === "") throw new Error("dbtest-plan-entry-missing");
  const assignment = plan.files[entryPath];
  if (assignment === undefined) throw new Error(`dbtest-plan-assignment-missing: ${entryPath}`);
  return assignment;
};

/**
 * The environment variables a test file's process runs under, given the
 * database and roots the runner set aside for it.
 *
 * DATABASE_URL moves with TEST_DATABASE_URL because merge-gate.sh points the
 * two at the same server on purpose: a subprocess that reads DATABASE_URL —
 * including one that would otherwise pick it up from a repository .env — must
 * land on the throwaway database, and now on this file's copy of it.
 */
export const environmentForAssignment = (
  assignment: DbtestAssignment,
): Record<string, string> => {
  const environment: Record<string, string> = {
    TEST_DATABASE_URL: assignment.databaseUrl,
    DATABASE_URL: assignment.databaseUrl,
    // Set here rather than for the whole run: a file with no assignment must
    // fall back to a harness that still migrates what it is pointed at.
    [preMigratedEnvironmentVariable]: "1",
  };
  for (const [field, variable] of Object.entries(isolatedRootVariables)) {
    const root = assignment[field as keyof typeof isolatedRootVariables];
    if (root) environment[variable] = root;
  }
  return environment;
};
