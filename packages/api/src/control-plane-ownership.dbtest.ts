import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@agentos/db";

import { CONTROL_PLANE_OWNERSHIP_EXIT_CODE } from "./control-plane-ownership.js";
import { ScratchDatabaseManager } from "./testdb.js";

const safeEnvironmentPresent = process.env.AGENTOS_ALLOW_SCRATCH_DATABASES === "1"
  && Boolean(process.env.TEST_DATABASE_URL)
  && Boolean(process.env.TEST_DATABASE_MAINTENANCE_URL);

const waitFor = (child: ChildProcess, pattern: RegExp, output: { value: string }, timeoutMs = 20_000): Promise<string> => new Promise((resolvePromise, reject) => {
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

const exited = (child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => new Promise((resolvePromise, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolvePromise({ code, signal }));
});

const spawnApi = (environment: NodeJS.ProcessEnv): { child: ChildProcess; output: { value: string } } => {
  const output = { value: "" };
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, output };
};

test("workspace-root ownership real-process database acceptance", { skip: !safeEnvironmentPresent && "explicit safe scratch database environment is required" }, async (t) => {
  const manager = new ScratchDatabaseManager();
  const created: string[] = [];
  const children = new Set<ChildProcess>();
  const container = await realpath(await mkdtemp(join(tmpdir(), "agentos-cp-a-dbtest-")));
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.all([...children].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) await exited(child).catch(() => undefined);
    }));
    for (const name of created.reverse()) await manager.drop(name);
    await manager.disconnect();
    await rm(container, { recursive: true, force: true });
  });

  const preflight = await manager.preflight();
  assert.equal(preflight.roleCanCreateDatabase, true);
  assert.equal(manager.allowedNames.size, 0);
  const source = await manager.createMigrated("source");
  created.push(source.name);
  const copy = await manager.clone(source.name, "copy");
  created.push(copy.name);

  const workspace = join(container, "workspace");
  const files = join(container, "files");
  const state = join(container, "state");
  await Promise.all([mkdir(workspace), mkdir(files), mkdir(state, { mode: 0o700 })]);
  await chmod(state, 0o700);
  const common = {
    ...process.env,
    API_HOST: "127.0.0.1",
    API_PORT: "0",
    SCHEDULER_POLL_INTERVAL_MS: "0",
    OPERATOR_TOKEN: "isolated-operator-token",
    RUNNER_TOKEN: "isolated-runner-token",
    RUNNER_WORKSPACE_ROOT: workspace,
    FILES_ROOT: files,
    CONTROL_PLANE_STATE_DIR: state,
  };
  const owner = spawnApi({ ...common, DATABASE_URL: source.url });
  children.add(owner.child);
  const ready = await waitFor(owner.child, /AgentOS API listening/u, owner.output);
  assert.match(ready, /CONTROL_PLANE_OWNERSHIP_ACQUIRED[\s\S]*Startup reconciliation:[\s\S]*AgentOS API listening/u);
  const canonicalRoot = (JSON.parse(ready.match(/CONTROL_PLANE_OWNERSHIP_ACQUIRED (\{[^\n]+\})/u)?.[1] ?? "{}") as { canonicalWorkspaceRoot?: string }).canonicalWorkspaceRoot;
  assert.equal(canonicalRoot, workspace);

  const orphan = join(workspace, "orphan-sentinel");
  await mkdir(orphan);
  const aliasParent = join(container, "alias");
  await mkdir(aliasParent);
  await symlink(workspace, join(aliasParent, "root"));
  const sameDbLoser = spawnApi({
    ...common,
    DATABASE_URL: source.url,
    RUNNER_WORKSPACE_ROOT: join(aliasParent, "unused", "..", "root"),
  });
  children.add(sameDbLoser.child);
  await waitFor(sameDbLoser.child, /CONTROL_PLANE_OWNERSHIP_CONFLICT/u, sameDbLoser.output);
  assert.equal((await exited(sameDbLoser.child)).code, CONTROL_PLANE_OWNERSHIP_EXIT_CODE);
  assert.doesNotMatch(sameDbLoser.output.value, /CONTROL_PLANE_OWNERSHIP_ACQUIRED|Startup reconciliation|listening/u);
  assert.equal((await lstat(orphan)).isDirectory(), true);
  assert.match(sameDbLoser.output.value, new RegExp(canonicalRoot?.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") ?? "never", "u"));

  const copyDb = new PrismaClient({ datasources: { db: { url: copy.url } } });
  const beforeMigrations = await copyDb.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM "_prisma_migrations"`;
  await copyDb.$disconnect();
  const copiedDbLoser = spawnApi({ ...common, DATABASE_URL: copy.url });
  children.add(copiedDbLoser.child);
  await waitFor(copiedDbLoser.child, /CONTROL_PLANE_OWNERSHIP_CONFLICT/u, copiedDbLoser.output);
  assert.equal((await exited(copiedDbLoser.child)).code, CONTROL_PLANE_OWNERSHIP_EXIT_CODE);
  assert.doesNotMatch(copiedDbLoser.output.value, /CONTROL_PLANE_OWNERSHIP_ACQUIRED|Startup reconciliation|listening/u);
  assert.equal((await lstat(orphan)).isDirectory(), true);
  const copyDbAfter = new PrismaClient({ datasources: { db: { url: copy.url } } });
  const afterMigrations = await copyDbAfter.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM "_prisma_migrations"`;
  await copyDbAfter.$disconnect();
  assert.deepEqual(afterMigrations, beforeMigrations);
  t.diagnostic("RP-OWN-SAME-ALIAS passed");
  t.diagnostic("RP-OWN-COPY passed");

  const listenPort = Number(ready.match(/AgentOS API listening on http:\/\/127\.0\.0\.1:(\d+)/u)?.[1]);
  assert.ok(listenPort > 0);
  const secondRoot = join(container, "lifecycle-root");
  const secondState = join(container, "lifecycle-state");
  await Promise.all([mkdir(secondRoot), mkdir(secondState, { mode: 0o700 })]);
  await chmod(secondState, 0o700);
  const addressLoser = spawnApi({
    ...common,
    DATABASE_URL: copy.url,
    API_PORT: String(listenPort),
    RUNNER_WORKSPACE_ROOT: secondRoot,
    CONTROL_PLANE_STATE_DIR: secondState,
  });
  children.add(addressLoser.child);
  await waitFor(addressLoser.child, /CONTROL_PLANE_OWNERSHIP_RELEASED/u, addressLoser.output);
  assert.equal((await exited(addressLoser.child)).code, 1);
  assert.match(addressLoser.output.value, /CONTROL_PLANE_OWNERSHIP_ACQUIRED[\s\S]*Startup reconciliation:[\s\S]*EADDRINUSE[\s\S]*CONTROL_PLANE_OWNERSHIP_RELEASED/u);
  t.diagnostic("RP-OWN-LIFECYCLE EADDRINUSE cleanup passed");

  owner.child.kill("SIGTERM");
  assert.equal((await exited(owner.child)).code, 0);
  assert.match(owner.output.value, /CONTROL_PLANE_OWNERSHIP_RELEASED/u);
});
