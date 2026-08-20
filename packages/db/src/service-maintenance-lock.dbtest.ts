/**
 * The runner half of the same claim the API's dbtest makes: a *running* AgentOS
 * runner is visible to the exclusive maintenance lock.
 *
 * This starts `packages/runner/dist/index.js` — the shipped entrypoint, not a
 * harness that imitates it — against a real PostgreSQL, and asks whether a
 * migration can take the exclusive key while it is polling. It lives in
 * `packages/db` rather than in `packages/runner` because this is the package
 * whose `test:db` the merge gate runs, and because the lock protocol being
 * tested is this package's. The runner is spawned by path; nothing is imported
 * from it, and the dependency runs the other way (the runner depends on
 * `@agentos/db/service-lock`).
 *
 * The runner needs no schema: it takes the lock and polls a control plane. So
 * the key here is a schema name that exists only as a hash — which is also what
 * makes this test unable to disturb anything.
 *
 *   AGENTOS_ALLOW_SCRATCH_DATABASES=1 \
 *   TEST_DATABASE_URL=postgresql://...:55777/...?schema=... \
 *     npm run test:db -w @agentos/db
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  acquireMaintenanceLock,
  inspectMaintenanceLock,
  prismaMaintenanceLockSession,
  type HeldMaintenanceLock,
} from "./maintenance-lock.js";
import { SERVICE_LOCK_CONTENTION_EXIT_CODE, SERVICE_LOCK_CONFIGURATION_EXIT_CODE } from "./service-maintenance-lock.js";

const scratchServer = (): URL => {
  if (process.env["AGENTOS_ALLOW_SCRATCH_DATABASES"] !== "1") throw new Error("scratch-database-opt-in-required");
  const raw = process.env["TEST_DATABASE_URL"];
  if (!raw) throw new Error("scratch-test-database-url-required");
  const url = new URL(raw);
  if (!url.protocol.startsWith("postgres")) throw new Error("scratch-database-postgresql-required");
  if ((url.port || "5432") === "5432") throw new Error("scratch-database-refuses-port-5432");
  return url;
};

const server = scratchServer();
const token = randomBytes(4).toString("hex");
const runnerEntrypoint = fileURLToPath(new URL("../../runner/dist/index.js", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const targetFor = (name: string): { url: string; schema: string } => {
  const schema = `svclock_${name}_${token}`;
  const url = new URL(server.href);
  url.searchParams.set("schema", schema);
  return { url: url.href, schema };
};

/**
 * The least control plane a runner will start against: 204 to everything.
 *
 * The runner reports its CLI preflight and then polls for work, and an
 * unanswered fetch is an unhandled rejection rather than a logged line — so
 * this exists to let the real entrypoint reach its poll loop. It hands out no
 * work, which is exactly what this fixture wants: a runner that is up.
 */
const stubControlPlane = async (): Promise<{ port: number; close: () => Promise<void> }> => {
  const stub: Server = createServer((request, response) => {
    request.resume();
    request.once("end", () => { response.writeHead(204).end(); });
  });
  const port = await new Promise<number>((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(0, "127.0.0.1", () => {
      const address = stub.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  return {
    port,
    close: async (): Promise<void> => { await new Promise<void>((resolve) => { stub.close(() => { resolve(); }); }); },
  };
};

const children = new Set<ChildProcess>();
const directories: string[] = [];
const held: HeldMaintenanceLock[] = [];
const controlPlane = await stubControlPlane();

after(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const lock of held) await lock.release();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  await controlPlane.close();
});

const spawnRunner = async (databaseUrl: string): Promise<{ child: ChildProcess; output: { value: string } }> => {
  assert.ok(
    existsSync(runnerEntrypoint),
    `${runnerEntrypoint} does not exist; this fixture starts the shipped runner, so the workspace must be built first`,
  );
  const workspace = await mkdtemp(join(tmpdir(), "agentos-runner-lock-"));
  directories.push(workspace);
  const output = { value: "" };
  const child = spawn(process.execPath, [runnerEntrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      // Explicit, because the runner loads the repository `.env` and dotenv
      // does not override what is already set: whatever an operator has in
      // that file, this process reaches only the values below.
      DATABASE_URL: databaseUrl,
      RUNNER_TOKEN: "service-lock-fixture-runner-token-000000",
      RUNNER_ID: `service-lock-fixture-${token}`,
      RUNNER_API_URL: `http://127.0.0.1:${controlPlane.port}`,
      RUNNER_WORKSPACE_ROOT: workspace,
      RUNNER_POLL_INTERVAL_MS: "200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout?.on("data", (chunk: Buffer) => { output.value += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { output.value += chunk.toString("utf8"); });
  return { child, output };
};

const waitForOutput = (child: ChildProcess, pattern: RegExp, output: { value: string }, timeoutMs = 60_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (pattern.test(output.value)) { clearInterval(timer); clearTimeout(deadline); resolve(); }
    }, 25);
    const deadline = setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`timed out waiting for ${String(pattern)}: ${output.value}`));
    }, timeoutMs);
    child.once("exit", () => {
      if (pattern.test(output.value)) return;
      clearInterval(timer);
      clearTimeout(deadline);
      reject(new Error(`runner exited before ${String(pattern)}: ${output.value}`));
    });
  });

const exited = (child: ChildProcess, timeoutMs = 60_000): Promise<number | null> => new Promise((resolve, reject) => {
  if (child.exitCode !== null) { resolve(child.exitCode); return; }
  const deadline = setTimeout(() => reject(new Error("the runner did not exit")), timeoutMs);
  child.once("exit", (code) => { clearTimeout(deadline); resolve(code); });
});

describe("the shipped runner and the shared lock", () => {
  it("holds one shared lock while it polls, and a migration is refused for as long as it does", async () => {
    const target = targetFor("polling");
    assert.deepEqual(await inspectMaintenanceLock(target, prismaMaintenanceLockSession), {
      exclusive: 0, shared: 0, waiting: 0,
    });

    const runner = await spawnRunner(target.url);
    await waitForOutput(runner.child, /runner step=maintenance-lock role=shared result=acquired/u, runner.output);
    await waitForOutput(runner.child, /AgentOS local runner .* polling/u, runner.output);
    assert.ok(
      runner.output.value.indexOf("step=maintenance-lock role=shared result=acquired")
        < runner.output.value.indexOf("polling"),
      "the lock is taken before the runner starts asking for work, not after",
    );
    assert.deepEqual(await inspectMaintenanceLock(target, prismaMaintenanceLockSession), {
      exclusive: 0, shared: 1, waiting: 0,
    });

    const refused = await acquireMaintenanceLock(target, "exclusive", prismaMaintenanceLockSession);
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? "" : refused.reason, "shared-service-lock-held-by-an-active-service");

    runner.child.kill("SIGTERM");
    assert.equal(await exited(runner.child), 0);
    assert.deepEqual(
      await inspectMaintenanceLock(target, prismaMaintenanceLockSession),
      { exclusive: 0, shared: 0, waiting: 0 },
      "the holder disappears with the process that took it",
    );
    const granted = await acquireMaintenanceLock(target, "exclusive", prismaMaintenanceLockSession);
    assert.equal(granted.ok, true);
    if (granted.ok) await granted.lock.release();
  });

  it("refuses to start while a maintenance session holds the key, and never polls", async () => {
    const target = targetFor("blocked");
    const maintenance = await acquireMaintenanceLock(target, "exclusive", prismaMaintenanceLockSession);
    assert.equal(maintenance.ok, true);
    if (!maintenance.ok) return;
    try {
      const runner = await spawnRunner(target.url);
      assert.equal(await exited(runner.child), SERVICE_LOCK_CONTENTION_EXIT_CODE);
      assert.match(
        runner.output.value,
        /AgentOS runner startup refused: exclusive-maintenance-lock-held-by-another-session/u,
      );
      assert.ok(!/polling/u.test(runner.output.value), runner.output.value);
    } finally {
      await maintenance.lock.release();
    }
  });

  it("refuses a database URL that does not name the schema it would lock", async () => {
    const unnamed = new URL(server.href);
    unnamed.searchParams.delete("schema");
    const runner = await spawnRunner(unnamed.href);
    assert.equal(await exited(runner.child), SERVICE_LOCK_CONFIGURATION_EXIT_CODE);
    assert.match(runner.output.value, /AgentOS runner startup refused: database-url-schema-unnamed/u);
  });

  it("stops when its lock backend is terminated underneath it", async () => {
    const target = targetFor("terminated");
    const runner = await spawnRunner(target.url);
    await waitForOutput(runner.child, /AgentOS local runner .* polling/u, runner.output);

    const executioner = await prismaMaintenanceLockSession(target.url);
    assert.notEqual(executioner, null);
    if (executioner === null) return;
    try {
      const rows = await executioner.query<{ pid: number }>(`
        SELECT pid::int4 AS pid FROM pg_locks
        WHERE locktype = 'advisory'
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND objid = (hashtext($1::text) & 2147483647)::oid
          AND objsubid = 2
          AND granted
          AND mode = 'ShareLock'
      `, [target.schema]);
      assert.equal(rows?.length, 1);
      await executioner.query("SELECT pg_terminate_backend($1::int4) AS terminated", [Number(rows?.[0]?.pid)]);
    } finally {
      await executioner.close();
    }

    // The retention check is what notices; nothing else in the runner would.
    await waitForOutput(runner.child, /Shared maintenance lock lost/u, runner.output);
    assert.equal(await exited(runner.child), SERVICE_LOCK_CONTENTION_EXIT_CODE);
  });
});
