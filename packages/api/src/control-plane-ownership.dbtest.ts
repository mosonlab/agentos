import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@anneal/db";

import { CONTROL_PLANE_OWNERSHIP_EXIT_CODE } from "./control-plane-ownership.js";
import { controlPlaneOwnerFilename } from "./control-plane-state.js";
import { SPAWNED_OPERATOR_TOKEN, SPAWNED_RUNNER_TOKEN, spawnedStartupEnvironment } from "./test-startup-environment.js";
import { ScratchDatabaseManager } from "./testdb.js";

const safeEnvironmentPresent = process.env.AGENTOS_ALLOW_SCRATCH_DATABASES === "1"
  && Boolean(process.env.TEST_DATABASE_URL)
  && Boolean(process.env.TEST_DATABASE_MAINTENANCE_URL);

const waitFor = (child: ChildProcess, pattern: RegExp, output: { value: string }, timeoutMs = 60_000): Promise<string> => new Promise((resolvePromise, reject) => {
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

const waitForDatabaseLockWaiter = async (db: PrismaClient, applicationName: string): Promise<number> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const waiting = await db.$queryRawUnsafe<Array<{ pid: number }>>(`
      SELECT pid::int AS pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = $1
        AND wait_event_type = 'Lock'
      ORDER BY query_start DESC
      LIMIT 1
    `, applicationName);
    if (waiting[0]) return waiting[0].pid;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("API did not reach the startup reconciliation database-lock wait queue");
};

const withApplicationName = (databaseUrl: string, applicationName: string): string => {
  const parsed = new URL(databaseUrl);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
};

const insertExpiredRunSentinel = async (
  db: PrismaClient,
  label: string,
  workspacePath: string,
): Promise<{ id: string; before: unknown }> => {
  const project = await db.project.create({ data: { name: `${label} project`, slug: `${label}-project` } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: `${label} environment`, allowedHosts: [] },
  });
  const agent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: `${label} agent`,
      title: "ownership sentinel",
      model: "sentinel",
      foundationalPrompt: "sentinel",
      rolePrompt: "sentinel",
    },
  });
  const task = await db.task.create({
    data: {
      projectId: project.id,
      assigneeAgentId: agent.id,
      name: `${label} task`,
      description: "must remain active when ownership acquisition loses",
      status: "DOING",
    },
  });
  const run = await db.run.create({
    data: {
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      runNumber: 1,
      dedupeKey: `${label}-expired-run`,
      status: "RUNNING",
      runner: "CODEX",
      runnerId: `${label}-runner`,
      leaseGeneration: 1,
      fencingToken: `${label}-fencing-token`,
      leaseExpiresAt: new Date("2000-01-01T00:00:00.000Z"),
      workspacePath,
      model: "sentinel",
      promptHash: `${label}-prompt-hash`,
    },
  });
  const before = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  return { id: run.id, before };
};

const spawnApi = (environment: NodeJS.ProcessEnv): { child: ChildProcess; output: { value: string } } => {
  const output = { value: "" };
  const entrypoint = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const args = environment.AGENTOS_TEST_SPAWN_OWNERSHIP_DESCENDANT === "1"
    ? ["--import", fileURLToPath(new URL("../dist/control-plane-production-fixture.js", import.meta.url)), entrypoint]
    : [entrypoint];
  const child = spawn(process.execPath, args, {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, output };
};

const markerFields = (output: string, marker: string): Record<string, unknown> => {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const encoded = output.match(new RegExp(`${escaped} (\\{[^\\n]+\\})`, "u"))?.[1];
  assert.ok(encoded, `${marker} marker was not found in output`);
  return JSON.parse(encoded) as Record<string, unknown>;
};

const durableStateSnapshot = async (stateRoot: string): Promise<{ entry: string; files: Array<{ name: string; bytes: Buffer; device: bigint; inode: bigint }> }> => {
  const entries = (await readdir(stateRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.equal(entries.length, 1);
  const entry = join(stateRoot, entries[0]!.name);
  const files = await Promise.all((await readdir(entry)).sort().map(async (name) => {
    const path = join(entry, name);
    const identity = await lstat(path, { bigint: true });
    return { name, bytes: await readFile(path), device: identity.dev, inode: identity.ino };
  }));
  return { entry, files };
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
  const physicalFiles = join(container, "physical-files");
  const state = join(container, "state");
  await Promise.all([mkdir(workspace), mkdir(physicalFiles), mkdir(state, { mode: 0o700 })]);
  await symlink(physicalFiles, files);
  await chmod(state, 0o700);
  // Each spawn names its own database, and the POSTGRES_* cross-check values
  // have to be derived from that exact URL (see test-startup-environment.ts),
  // so the shared part is a function of the URL rather than one frozen object.
  const common = (databaseUrl: string): NodeJS.ProcessEnv => ({
    ...process.env,
    ...spawnedStartupEnvironment({ DATABASE_URL: databaseUrl }),
    SCHEDULER_POLL_INTERVAL_MS: "0",
    RUNNER_WORKSPACE_ROOT: workspace,
    FILES_ROOT: files,
    CONTROL_PLANE_STATE_DIR: state,
  });
  const owner = spawnApi(common(source.url));
  children.add(owner.child);
  const ready = await waitFor(owner.child, /AgentOS API listening/u, owner.output);
  assert.match(ready, /CONTROL_PLANE_OWNERSHIP_ACQUIRED[\s\S]*Startup reconciliation:[\s\S]*AgentOS API listening/u);
  const canonicalRoot = (JSON.parse(ready.match(/CONTROL_PLANE_OWNERSHIP_ACQUIRED (\{[^\n]+\})/u)?.[1] ?? "{}") as { canonicalWorkspaceRoot?: string }).canonicalWorkspaceRoot;
  assert.equal(canonicalRoot, workspace);

  const listenPort = Number(ready.match(/AgentOS API listening on http:\/\/127\.0\.0\.1:(\d+)/u)?.[1]);
  assert.ok(listenPort > 0);
  const apiBase = `http://127.0.0.1:${listenPort}`;
  const ownershipBeforeFilesAndRunners = await durableStateSnapshot(state);
  const runnerPoll = (runnerId: string): Promise<Response> => fetch(`${apiBase}/runner/tasks/claim`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SPAWNED_RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId, leaseSeconds: 60, workspaceRoot: workspace }),
  });
  assert.equal((await runnerPoll("runner-a")).status, 204);
  assert.equal((await runnerPoll("runner-b")).status, 204);
  const runnersResponse = await fetch(`${apiBase}/runners`, {
    headers: { Authorization: `Bearer ${SPAWNED_OPERATOR_TOKEN}` },
  });
  assert.equal(runnersResponse.status, 200);
  const runnersBody = await runnersResponse.json() as { total: number; daemons: Array<{ runnerId: string; workspaceRoot: string | null }> };
  assert.equal(runnersBody.total, 2);
  assert.deepEqual(runnersBody.daemons.map(({ runnerId, workspaceRoot }) => ({ runnerId, workspaceRoot })), [
    { runnerId: "runner-a", workspaceRoot: workspace },
    { runnerId: "runner-b", workspaceRoot: workspace },
  ]);

  const stateEntryName = ownershipBeforeFilesAndRunners.entry.slice(state.length + 1);
  await unlink(files);
  await symlink(state, files);
  try {
    const filesAliasWrite = await fetch(`${apiBase}/files/content?${new URLSearchParams({ path: `${stateEntryName}/ownership.lock` })}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${SPAWNED_OPERATOR_TOKEN}` },
      body: "replacement",
    });
    assert.equal(filesAliasWrite.status, 200);
    assert.deepEqual(await durableStateSnapshot(state), ownershipBeforeFilesAndRunners);
    assert.equal(await readFile(join(physicalFiles, stateEntryName, "ownership.lock"), "utf8"), "replacement");
    const [authoritativeLock, harmlessFilesCopy] = await Promise.all([
      lstat(join(ownershipBeforeFilesAndRunners.entry, "ownership.lock"), { bigint: true }),
      lstat(join(physicalFiles, stateEntryName, "ownership.lock"), { bigint: true }),
    ]);
    assert.notEqual(harmlessFilesCopy.ino, authoritativeLock.ino);
  } finally {
    await unlink(files);
    await symlink(physicalFiles, files);
  }
  t.diagnostic("RP-RUNNERS-TWO production owned API passed");
  t.diagnostic("RP-OWN-FILES-WRITER retargeted Files alias stayed pinned away from ownership state");

  const orphan = join(workspace, "orphan-sentinel");
  await mkdir(orphan);
  const sourceDb = new PrismaClient({ datasources: { db: { url: source.url } } });
  const sameDbSentinel = await insertExpiredRunSentinel(sourceDb, "same-db", orphan);
  await sourceDb.$disconnect();
  const aliasParent = join(container, "alias");
  await mkdir(aliasParent);
  await symlink(workspace, join(aliasParent, "root"));
  const sameDbLoser = spawnApi({
    ...common(source.url),
    RUNNER_WORKSPACE_ROOT: join(aliasParent, "unused", "..", "root"),
  });
  children.add(sameDbLoser.child);
  await waitFor(sameDbLoser.child, /CONTROL_PLANE_OWNERSHIP_CONFLICT/u, sameDbLoser.output);
  assert.equal((await exited(sameDbLoser.child)).code, CONTROL_PLANE_OWNERSHIP_EXIT_CODE);
  assert.doesNotMatch(sameDbLoser.output.value, /CONTROL_PLANE_OWNERSHIP_ACQUIRED|Startup reconciliation|listening/u);
  assert.equal((await lstat(orphan)).isDirectory(), true);
  const sourceDbAfter = new PrismaClient({ datasources: { db: { url: source.url } } });
  assert.deepEqual(await sourceDbAfter.run.findUniqueOrThrow({ where: { id: sameDbSentinel.id } }), sameDbSentinel.before);
  await sourceDbAfter.$disconnect();
  assert.match(sameDbLoser.output.value, new RegExp(canonicalRoot?.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") ?? "never", "u"));

  const copyDb = new PrismaClient({ datasources: { db: { url: copy.url } } });
  const copiedDbSentinel = await insertExpiredRunSentinel(copyDb, "copied-db", orphan);
  const beforeMigrations = await copyDb.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM "_prisma_migrations"`;
  await copyDb.$disconnect();
  const copiedDbLoser = spawnApi(common(copy.url));
  children.add(copiedDbLoser.child);
  await waitFor(copiedDbLoser.child, /CONTROL_PLANE_OWNERSHIP_CONFLICT/u, copiedDbLoser.output);
  assert.equal((await exited(copiedDbLoser.child)).code, CONTROL_PLANE_OWNERSHIP_EXIT_CODE);
  assert.doesNotMatch(copiedDbLoser.output.value, /CONTROL_PLANE_OWNERSHIP_ACQUIRED|Startup reconciliation|listening/u);
  assert.equal((await lstat(orphan)).isDirectory(), true);
  const copyDbAfter = new PrismaClient({ datasources: { db: { url: copy.url } } });
  const afterMigrations = await copyDbAfter.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM "_prisma_migrations"`;
  assert.deepEqual(await copyDbAfter.run.findUniqueOrThrow({ where: { id: copiedDbSentinel.id } }), copiedDbSentinel.before);
  await copyDbAfter.$disconnect();
  assert.deepEqual(afterMigrations, beforeMigrations);
  t.diagnostic("RP-OWN-SAME-ALIAS passed");
  t.diagnostic("RP-OWN-COPY passed");

  const secondRoot = join(container, "lifecycle-root");
  const secondState = join(container, "lifecycle-state");
  await Promise.all([mkdir(secondRoot), mkdir(secondState, { mode: 0o700 })]);
  await chmod(secondState, 0o700);
  const addressLoser = spawnApi({
    ...common(copy.url),
    API_PORT: String(listenPort),
    RUNNER_WORKSPACE_ROOT: secondRoot,
    CONTROL_PLANE_STATE_DIR: secondState,
  });
  children.add(addressLoser.child);
  await waitFor(addressLoser.child, /CONTROL_PLANE_OWNERSHIP_RELEASED/u, addressLoser.output);
  assert.equal((await exited(addressLoser.child)).code, 1);
  assert.match(addressLoser.output.value, /CONTROL_PLANE_OWNERSHIP_ACQUIRED[\s\S]*Startup reconciliation:[\s\S]*EADDRINUSE[\s\S]*CONTROL_PLANE_OWNERSHIP_RELEASED/u);
  t.diagnostic("RP-OWN-LIFECYCLE EADDRINUSE cleanup passed");

  const signalRoot = join(container, "signal-root");
  const signalState = join(container, "signal-state");
  await Promise.all([mkdir(signalRoot), mkdir(signalState, { mode: 0o700 })]);
  await chmod(signalState, 0o700);
  const blocker = new PrismaClient({ datasources: { db: { url: copy.url } } });
  const observer = new PrismaClient({ datasources: { db: { url: copy.url } } });
  let releaseDatabaseLock!: () => void;
  let reportDatabaseLock!: () => void;
  const databaseLockReleased = new Promise<void>((resolvePromise) => { releaseDatabaseLock = resolvePromise; });
  const databaseLockHeld = new Promise<void>((resolvePromise) => { reportDatabaseLock = resolvePromise; });
  const blockingTransaction = blocker.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('LOCK TABLE "Run" IN ACCESS EXCLUSIVE MODE');
    reportDatabaseLock();
    await databaseLockReleased;
  }, { maxWait: 5_000, timeout: 30_000 });
  await databaseLockHeld;
  const signalApplicationName = "cp-a-signal-success";
  const signaledDuringReconciliation = spawnApi({
    ...common(withApplicationName(copy.url, signalApplicationName)),
    RUNNER_WORKSPACE_ROOT: signalRoot,
    CONTROL_PLANE_STATE_DIR: signalState,
  });
  children.add(signaledDuringReconciliation.child);
  try {
    await waitFor(signaledDuringReconciliation.child, /CONTROL_PLANE_OWNERSHIP_ACQUIRED/u, signaledDuringReconciliation.output);
    await waitForDatabaseLockWaiter(observer, signalApplicationName);
    signaledDuringReconciliation.child.kill("SIGTERM");
    await waitFor(signaledDuringReconciliation.child, /Received SIGTERM/u, signaledDuringReconciliation.output);
    assert.doesNotMatch(signaledDuringReconciliation.output.value, /AgentOS API listening/u);
  } finally {
    releaseDatabaseLock();
    await blockingTransaction;
    await Promise.all([blocker.$disconnect(), observer.$disconnect()]);
  }
  await waitFor(signaledDuringReconciliation.child, /CONTROL_PLANE_OWNERSHIP_RELEASED/u, signaledDuringReconciliation.output);
  assert.equal((await exited(signaledDuringReconciliation.child)).code, 0);
  assert.match(signaledDuringReconciliation.output.value, /CONTROL_PLANE_OWNERSHIP_ACQUIRED[\s\S]*Received SIGTERM[\s\S]*Startup reconciliation:[\s\S]*CONTROL_PLANE_OWNERSHIP_RELEASED/u);
  assert.doesNotMatch(signaledDuringReconciliation.output.value, /AgentOS API listening/u);
  t.diagnostic("RP-OWN-LIFECYCLE signal-during-reconciliation cleanup passed");

  const failingSignalRoot = join(container, "signal-failure-root");
  const failingSignalState = join(container, "signal-failure-state");
  await Promise.all([mkdir(failingSignalRoot), mkdir(failingSignalState, { mode: 0o700 })]);
  await chmod(failingSignalState, 0o700);
  const failureBlocker = new PrismaClient({ datasources: { db: { url: copy.url } } });
  const failureObserver = new PrismaClient({ datasources: { db: { url: copy.url } } });
  let releaseFailureLock!: () => void;
  let reportFailureLock!: () => void;
  const failureLockReleased = new Promise<void>((resolvePromise) => { releaseFailureLock = resolvePromise; });
  const failureLockHeld = new Promise<void>((resolvePromise) => { reportFailureLock = resolvePromise; });
  const failureBlockingTransaction = failureBlocker.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('LOCK TABLE "Run" IN ACCESS EXCLUSIVE MODE');
    reportFailureLock();
    await failureLockReleased;
  }, { maxWait: 5_000, timeout: 30_000 });
  await failureLockHeld;
  const failureApplicationName = "cp-a-signal-failure";
  const signalThenFailure = spawnApi({
    ...common(withApplicationName(copy.url, failureApplicationName)),
    RUNNER_WORKSPACE_ROOT: failingSignalRoot,
    CONTROL_PLANE_STATE_DIR: failingSignalState,
  });
  children.add(signalThenFailure.child);
  try {
    await waitFor(signalThenFailure.child, /CONTROL_PLANE_OWNERSHIP_ACQUIRED/u, signalThenFailure.output);
    const waitingPid = await waitForDatabaseLockWaiter(failureObserver, failureApplicationName);
    signalThenFailure.child.kill("SIGTERM");
    await waitFor(signalThenFailure.child, /Received SIGTERM/u, signalThenFailure.output);
    const terminated = await failureObserver.$queryRawUnsafe<Array<{ terminated: boolean }>>(
      "SELECT pg_terminate_backend($1::int) AS terminated",
      waitingPid,
    );
    assert.equal(terminated[0]?.terminated, true);
  } finally {
    releaseFailureLock();
    await failureBlockingTransaction;
    await Promise.all([failureBlocker.$disconnect(), failureObserver.$disconnect()]);
  }
  await waitFor(signalThenFailure.child, /CONTROL_PLANE_OWNERSHIP_RELEASED/u, signalThenFailure.output);
  assert.equal((await exited(signalThenFailure.child)).code, 1);
  assert.match(signalThenFailure.output.value, /CONTROL_PLANE_OWNERSHIP_ACQUIRED[\s\S]*Received SIGTERM[\s\S]*AgentOS API startup failed[\s\S]*CONTROL_PLANE_OWNERSHIP_RELEASED/u);
  assert.doesNotMatch(signalThenFailure.output.value, /AgentOS API listening/u);
  const failedSignalState = await durableStateSnapshot(failingSignalState);
  const failedSignalOwner = JSON.parse(failedSignalState.files.find(({ name }) => name === controlPlaneOwnerFilename)?.bytes.toString("utf8") ?? "{}") as { state?: string; releasedAt?: string };
  assert.equal(failedSignalOwner.state, "released");
  assert.ok(failedSignalOwner.releasedAt);
  t.diagnostic("RP-OWN-LIFECYCLE signal plus reconciliation failure exits nonzero and releases passed");

  const recoveryRoot = join(container, "recovery-root");
  const recoveryFiles = join(container, "recovery-files");
  const recoveryState = join(container, "recovery-state");
  await Promise.all([mkdir(recoveryRoot), mkdir(recoveryFiles), mkdir(recoveryState, { mode: 0o700 })]);
  await chmod(recoveryState, 0o700);
  const recoveryOwner = spawnApi({
    ...common(copy.url),
    RUNNER_WORKSPACE_ROOT: recoveryRoot,
    FILES_ROOT: recoveryFiles,
    CONTROL_PLANE_STATE_DIR: recoveryState,
    AGENTOS_TEST_SPAWN_OWNERSHIP_DESCENDANT: "1",
  });
  children.add(recoveryOwner.child);
  const recoveryOwnerReady = await waitFor(recoveryOwner.child, /AgentOS API listening/u, recoveryOwner.output);
  const descendantPid = Number(recoveryOwnerReady.match(/OWNERSHIP_PRODUCTION_DESCENDANT_PID (\d+)/u)?.[1]);
  assert.ok(descendantPid > 0);
  let descendantAlive = true;
  t.after(() => {
    if (!descendantAlive) return;
    try { process.kill(descendantPid, "SIGTERM"); } catch { /* already gone */ }
  });
  const priorAcquired = markerFields(recoveryOwnerReady, "CONTROL_PLANE_OWNERSHIP_ACQUIRED");
  recoveryOwner.child.kill("SIGKILL");
  assert.equal((await exited(recoveryOwner.child)).signal, "SIGKILL");
  assert.doesNotThrow(() => process.kill(descendantPid, 0));
  const crashedState = await durableStateSnapshot(recoveryState);
  const crashedOwner = JSON.parse(crashedState.files.find(({ name }) => name === controlPlaneOwnerFilename)?.bytes.toString("utf8") ?? "{}") as { state?: string; controlPlaneId?: string; incarnationId?: string };
  assert.equal(crashedOwner.state, "owned");
  assert.equal(crashedOwner.controlPlaneId, priorAcquired.controlPlaneId);
  assert.equal(crashedOwner.incarnationId, priorAcquired.incarnationId);

  const recoverySuccessor = spawnApi({
    ...common(copy.url),
    RUNNER_WORKSPACE_ROOT: recoveryRoot,
    FILES_ROOT: recoveryFiles,
    CONTROL_PLANE_STATE_DIR: recoveryState,
  });
  children.add(recoverySuccessor.child);
  const recoveredReady = await waitFor(recoverySuccessor.child, /AgentOS API listening/u, recoverySuccessor.output);
  const recovered = markerFields(recoveredReady, "CONTROL_PLANE_OWNERSHIP_RECOVERED");
  const successorAcquired = markerFields(recoveredReady, "CONTROL_PLANE_OWNERSHIP_ACQUIRED");
  assert.equal(successorAcquired.controlPlaneId, priorAcquired.controlPlaneId);
  assert.notEqual(successorAcquired.incarnationId, priorAcquired.incarnationId);
  assert.equal(recovered.priorIncarnationId, priorAcquired.incarnationId);
  assert.equal(recovered.incarnationId, successorAcquired.incarnationId);
  assert.equal(recovered.priorPid, recoveryOwner.child.pid);
  assert.match(recoveredReady, /CONTROL_PLANE_OWNERSHIP_RECOVERED[\s\S]*CONTROL_PLANE_OWNERSHIP_ACQUIRED[\s\S]*Startup reconciliation:[\s\S]*AgentOS API listening/u);
  recoverySuccessor.child.kill("SIGTERM");
  assert.equal((await exited(recoverySuccessor.child)).code, 0);
  assert.match(recoverySuccessor.output.value, /CONTROL_PLANE_OWNERSHIP_RELEASED/u);
  process.kill(descendantPid, "SIGTERM");
  descendantAlive = false;
  t.diagnostic("RP-OWN-RECOVERY-DESCENDANT production stable identity, new incarnation, reconcile, and listen passed");

  owner.child.kill("SIGTERM");
  assert.equal((await exited(owner.child)).code, 0);
  assert.match(owner.output.value, /CONTROL_PLANE_OWNERSHIP_RELEASED/u);
});
