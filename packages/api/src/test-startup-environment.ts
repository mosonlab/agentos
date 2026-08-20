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
 * Three deliberate omissions:
 *
 * - `DATABASE_URL` is the caller's, because only the caller knows whether this
 *   process should reach a scratch database or an address nothing answers on.
 * - `POSTGRES_DB`, `POSTGRES_USER` and `POSTGRES_PASSWORD` are cleared. Startup
 *   validation cross-checks them against `DATABASE_URL`, and a scratch database
 *   name never matches whatever an operator happens to export.
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

export const spawnedStartupEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  API_HOST: "127.0.0.1",
  // Ephemeral on purpose: no test process may take the operator's port 3000.
  API_PORT: "0",
  OPERATOR_TOKEN: SPAWNED_OPERATOR_TOKEN,
  RUNNER_TOKEN: SPAWNED_RUNNER_TOKEN,
  AGENTOS_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  MERGE_EXECUTOR_TOKEN: undefined,
  SESSION_COOKIE_SECRET: undefined,
  POSTGRES_DB: undefined,
  POSTGRES_USER: undefined,
  POSTGRES_PASSWORD: undefined,
  ...overrides,
});
