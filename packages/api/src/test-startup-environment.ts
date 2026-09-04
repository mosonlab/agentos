/**
 * The environment a test hands the real API entrypoint when it spawns it.
 *
 * `index.ts` now judges its own configuration before it does anything else
 * (`startup-config.ts`), so a test that spawns the production entrypoint has to
 * hand it a configuration a real deployment could hold: two distinct
 * full-length principal tokens, a well-formed encryption key, a loopback
 * listener. Without that, such a test measures the shell it inherited rather
 * than the behaviour it names — and the refusal it would hit is exit 78, which
 * looks nothing like the failure it is asserting on.
 *
 * The helper supplies a fixture GITHUB_READ_TOKEN because the API requires
 * that read capability at startup. Tests that exercise an unusable value pin
 * the key to an empty string so the entrypoint's dotenv load cannot refill it.
 *
 * Three deliberate omissions:
 *
 * - `DATABASE_URL` is the caller's, because only the caller knows whether this
 *   process should reach a scratch database or an address nothing answers on.
 * - `POSTGRES_DB`, `POSTGRES_USER` and `POSTGRES_PASSWORD` follow the caller's
 *   `DATABASE_URL` rather than the shell. Startup validation cross-checks them
 *   against `DATABASE_URL`, and clearing them is not enough: the entrypoint
 *   itself loads the repository's `.env` (index.ts), which would refill the
 *   cleared variables with the operator's values and fail the cross-check
 *   before the behaviour under test is ever reached. dotenv never overwrites a
 *   variable that is already set, so deriving matching values from the caller's
 *   URL pins all three. Without a `DATABASE_URL` they are cleared as before.
 *   The derived values are judged like any deployment's, which means a scratch
 *   database's password has to satisfy the startup secret floor.
 * - `MERGE_EXECUTOR_TOKEN` and `SESSION_COOKIE_SECRET` are cleared for the same
 *   reason: an inherited value would be judged here, and it is not what any of
 *   these tests are about.
 *
 * A key with value `undefined` is dropped by `child_process.spawn`, so spreading
 * this over `process.env` removes those variables rather than blanking them.
 */

/** Fixture credentials. Long enough to satisfy the startup floor and obviously
 *  not a generated secret, so neither ever reads as one in a log. */
export const SPAWNED_OPERATOR_TOKEN = "spawned-fixture-operator-token-000000";
export const SPAWNED_RUNNER_TOKEN = "spawned-fixture-runner-token-000000";
export const SPAWNED_GITHUB_READ_TOKEN = "spawned-fixture-github-read-token-000000";

/**
 * The Node argv for a test child that executes an API source entrypoint.
 *
 * A condition on the parent test process is not inherited by a child started
 * through `process.execPath`, so source entrypoints must carry it explicitly.
 * Keep this beside the startup environment so every production-shaped test
 * child has one canonical launch contract.
 */
export const spawnedSourceEntrypointArgv = (entrypoint: string): string[] => [
  "--conditions=development",
  "--import",
  "tsx",
  entrypoint,
];

const postgresVariablesFor = (databaseUrl: string | undefined): NodeJS.ProcessEnv => {
  if (databaseUrl === undefined) {
    return { POSTGRES_DB: undefined, POSTGRES_USER: undefined, POSTGRES_PASSWORD: undefined };
  }
  const parsed = new URL(databaseUrl);
  return {
    POSTGRES_DB: decodeURIComponent(parsed.pathname.replace(/^\//u, "")),
    POSTGRES_USER: decodeURIComponent(parsed.username),
    POSTGRES_PASSWORD: decodeURIComponent(parsed.password),
  };
};

export const spawnedStartupEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  API_HOST: "127.0.0.1",
  // Ephemeral on purpose: no test process may take the operator's port 3000.
  API_PORT: "0",
  OPERATOR_TOKEN: SPAWNED_OPERATOR_TOKEN,
  RUNNER_TOKEN: SPAWNED_RUNNER_TOKEN,
  GITHUB_READ_TOKEN: SPAWNED_GITHUB_READ_TOKEN,
  AGENTOS_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  MERGE_EXECUTOR_TOKEN: undefined,
  SESSION_COOKIE_SECRET: undefined,
  ...postgresVariablesFor(overrides.DATABASE_URL),
  ...overrides,
});
