/**
 * The claim the #164 review said nothing proved: a *running* Anneal API is
 * visible to the exclusive maintenance lock.
 *
 * Everything here is the shipped entrypoint. `packages/api/dist/index.js` is
 * started against a real migrated scratch database and asked the only question
 * that matters — while it is serving, can a release migration or an OSS-D
 * backup take the exclusive key? A fixture that took a shared lock itself and
 * then checked `pg_locks` would prove PostgreSQL's compatibility matrix, which
 * `maintenance-lock.dbtest.ts` already proves; this proves the API participates.
 *
 * The cases are the whole protocol: acquisition while serving, refusal of a
 * migrator during it, release on shutdown, startup refusal under an exclusive
 * holder, recovery from a dropped backend, and shutdown when an exclusive
 * holder wins the recovery race.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  acquireMaintenanceLock,
  inspectMaintenanceLock,
  prismaMaintenanceLockSession,
  PrismaClient,
  MAINTENANCE_LOCK_CLASS,
  MAINTENANCE_LOCK_KEY_SQL,
  SERVICE_LOCK_CONTENTION_EXIT_CODE,
  type MaintenanceLockTarget,
} from "@anneal/db";

import { spawnedStartupEnvironment } from "./test-startup-environment.js";
import { ScratchDatabaseManager } from "./testdb.js";

const safeEnvironmentPresent = process.env.AGENTOS_ALLOW_SCRATCH_DATABASES === "1"
  && Boolean(process.env.TEST_DATABASE_URL)
  && Boolean(process.env.TEST_DATABASE_MAINTENANCE_URL);

/** Long enough for one retention interval plus a shutdown, and no longer. */
const RETENTION_OBSERVATION_MS = 60_000;

const waitFor = (child: ChildProcess, pattern: RegExp, output: { value: string }, timeoutMs = 60_000): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}: ${output.value}`)), timeoutMs);
    const inspect = (): void => {
      if (!pattern.test(output.value)) return;
      clearTimeout(timer);
      resolvePromise(output.value);
    };
    child.stdout?.on("data", (chunk: Buffer) => { output.value += chunk.toString("utf8"); inspect(); });
    child.stderr?.on("data", (chunk: Buffer) => { output.value += chunk.toString("utf8"); inspect(); });
    child.once("exit", () => {
      if (!pattern.test(output.value)) {
        clearTimeout(timer);
        reject(new Error(`Child exited before ${pattern}: ${output.value}`));
      }
    });
  });

const exited = (child: ChildProcess, timeoutMs = RETENTION_OBSERVATION_MS): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("the API did not exit")), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal }); });
  });

const spawnApi = (environment: NodeJS.ProcessEnv): { child: ChildProcess; output: { value: string } } => {
  const output = { value: "" };
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => { output.value += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { output.value += chunk.toString("utf8"); });
  return { child, output };
};

/** The backends holding the key right now, so a test can terminate one. */
const holderPids = async (db: PrismaClient, schema: string): Promise<number[]> => {
  const rows = await db.$queryRawUnsafe<Array<{ pid: number }>>(`
    SELECT pid::int4 AS pid
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND classid = $1::oid
      AND objid = ${MAINTENANCE_LOCK_KEY_SQL}::oid
      AND objsubid = 2
      AND granted
      AND mode = 'ShareLock'
  `, MAINTENANCE_LOCK_CLASS, schema);
  return rows.map((row) => Number(row.pid));
};

test("api shared maintenance lock real-process acceptance", {
  skip: !safeEnvironmentPresent && "explicit safe scratch database environment is required",
}, async (t) => {
  const manager = new ScratchDatabaseManager();
  const created: string[] = [];
  const children = new Set<ChildProcess>();
  const container = await realpath(await mkdtemp(join(tmpdir(), "agentos-shared-lock-dbtest-")));
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all([...children].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) await exited(child, 30_000).catch(() => undefined);
    }));
    for (const name of created.reverse()) await manager.drop(name);
    await manager.disconnect();
    await rm(container, { recursive: true, force: true });
  });

  const source = await manager.createMigrated("sharedlock");
  created.push(source.name);
  const schema = new URL(source.url).searchParams.get("schema");
  assert.ok(schema, "the scratch URL must name its schema, or the API would refuse to start for that reason instead");
  const target: MaintenanceLockTarget = { url: source.url, schema };
  const observer = new PrismaClient({ datasources: { db: { url: source.url } } });
  t.after(async () => { await observer.$disconnect(); });

  const workspace = join(container, "workspace");
  const files = join(container, "files");
  const state = join(container, "state");
  await Promise.all([mkdir(workspace), mkdir(files), mkdir(state, { mode: 0o700 })]);
  const common = {
    ...process.env,
    ...spawnedStartupEnvironment({ DATABASE_URL: source.url }),
    SCHEDULER_POLL_INTERVAL_MS: "0",
    // Two of the cases below wait for a retention tick to fire. At the shipped
    // ten seconds that wait is the entire cost of this file; the protocol being
    // proved is what the check does, not how long the service sat between two
    // of them.
    SERVICE_LOCK_RETENTION_INTERVAL_MS: "250",
    RUNNER_WORKSPACE_ROOT: workspace,
    FILES_ROOT: files,
    CONTROL_PLANE_STATE_DIR: state,
  };

  await t.test("nothing holds the key before a service starts", async () => {
    assert.deepEqual(await inspectMaintenanceLock(target, prismaMaintenanceLockSession), {
      exclusive: 0, shared: 0, waiting: 0,
    });
  });

  await t.test("a serving API is one shared holder, and a migrator is refused while it serves", async () => {
    const api = spawnApi(common);
    children.add(api.child);
    const ready = await waitFor(api.child, /Anneal API listening/u, api.output);
    assert.match(ready, /api step=maintenance-lock role=shared result=acquired schema=/u);
    // The lock is taken before the database is served, not after: reconciliation
    // is already a statement against the schema.
    assert.ok(
      ready.indexOf("step=maintenance-lock role=shared result=acquired")
        < ready.indexOf("Startup reconciliation:"),
      ready,
    );
    assert.deepEqual(await inspectMaintenanceLock(target, prismaMaintenanceLockSession), {
      exclusive: 0, shared: 1, waiting: 0,
    });

    const refused = await acquireMaintenanceLock(target, "exclusive", prismaMaintenanceLockSession);
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? "" : refused.reason, "shared-service-lock-held-by-an-active-service");

    // ...and the holder disappears with the process that took it.
    api.child.kill("SIGTERM");
    const stopped = await exited(api.child);
    assert.equal(stopped.code, 0);
    assert.deepEqual(await inspectMaintenanceLock(target, prismaMaintenanceLockSession), {
      exclusive: 0, shared: 0, waiting: 0,
    });
    const granted = await acquireMaintenanceLock(target, "exclusive", prismaMaintenanceLockSession);
    assert.equal(granted.ok, true, "a migration must be possible once no service is up");
    if (granted.ok) await granted.lock.release();
  });

  await t.test("an API started under an exclusive holder refuses, and never binds", async () => {
    const maintenance = await acquireMaintenanceLock(target, "exclusive", prismaMaintenanceLockSession);
    assert.equal(maintenance.ok, true);
    try {
      const api = spawnApi(common);
      children.add(api.child);
      const stopped = await exited(api.child);
      assert.equal(stopped.code, SERVICE_LOCK_CONTENTION_EXIT_CODE);
      assert.match(api.output.value, /Anneal API startup refused: exclusive-maintenance-lock-held-by-another-session/u);
      assert.ok(
        !/Anneal API listening/u.test(api.output.value),
        "a control plane that could not take the shared lock must not serve a request",
      );
    } finally {
      if (maintenance.ok) await maintenance.lock.release();
    }
  });

  await t.test("an API reacquires shared after its lock backend is lost", async () => {
    const api = spawnApi(common);
    children.add(api.child);
    await waitFor(api.child, /Anneal API listening/u, api.output);
    const holders = await holderPids(observer, schema);
    assert.equal(holders.length, 1);
    await observer.$queryRawUnsafe("SELECT pg_terminate_backend($1::int4)", holders[0]);

    await waitFor(api.child, /result=reacquired/u, api.output);
    assert.equal(api.child.exitCode, null, api.output.value);
    const replacement = await holderPids(observer, schema);
    assert.equal(replacement.length, 1);
    assert.notEqual(replacement[0], holders[0]);
    assert.deepEqual(await inspectMaintenanceLock(target, prismaMaintenanceLockSession), {
      exclusive: 0, shared: 1, waiting: 0,
    });

    api.child.kill("SIGTERM");
    assert.equal((await exited(api.child)).code, 0);
  });

  await t.test("an API stops when maintenance wins after its shared backend is lost", async () => {
    const api = spawnApi(common);
    children.add(api.child);
    await waitFor(api.child, /Anneal API listening/u, api.output);
    const holders = await holderPids(observer, schema);
    assert.equal(holders.length, 1);
    await observer.$queryRawUnsafe("SELECT pg_terminate_backend($1::int4)", holders[0]);

    const maintenance = await acquireMaintenanceLock(target, "exclusive", prismaMaintenanceLockSession);
    assert.equal(maintenance.ok, true, JSON.stringify(maintenance));
    if (!maintenance.ok) return;
    try {
      await waitFor(
        api.child,
        /result=reacquire-strike .*reason=exclusive-maintenance-lock-held-by-another-session/u,
        api.output,
      );
      const stopped = await exited(api.child);
      assert.equal(stopped.code, SERVICE_LOCK_CONTENTION_EXIT_CODE);
      assert.match(api.output.value, /Anneal API stopping: shared-service-lock-was-not-retained/u);
      assert.deepEqual(await inspectMaintenanceLock(target, prismaMaintenanceLockSession), {
        exclusive: 1, shared: 0, waiting: 0,
      });
    } finally {
      await maintenance.lock.release();
    }
  });
});
