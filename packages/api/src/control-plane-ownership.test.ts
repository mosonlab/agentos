import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  acquireControlPlaneOwnership,
  CONTROL_PLANE_OWNERSHIP_EXIT_CODE,
  ControlPlaneOwnershipStartupError,
  type ControlPlaneOwnerRecord,
} from "./control-plane-ownership.js";
import {
  classifyControlStateFilesystem,
  controlPlaneIdFilename,
  controlPlaneOwnerFilename,
} from "./control-plane-state.js";
import { canonicalizeWorkspaceRoot } from "./workspace-root.js";

const allowedFilesystem = async (): Promise<number> => 0x1a;

const fixture = async () => {
  const container = await realpath(await mkdtemp(join(tmpdir(), "agentos-ownership-")));
  const workspace = join(container, "workspace");
  const files = join(container, "files");
  const state = join(container, "state");
  await Promise.all([mkdir(workspace), mkdir(files), mkdir(state, { mode: 0o700 })]);
  await chmod(state, 0o700);
  return { container, workspace, files, state };
};

const acquire = async (paths: Awaited<ReturnType<typeof fixture>>, extra: Parameters<typeof acquireControlPlaneOwnership>[0] = {}) => {
  const markers: string[] = [];
  const ownership = await acquireControlPlaneOwnership({
    workspaceRoot: paths.workspace,
    filesRoot: paths.files,
    stateDir: paths.state,
    filesystemTypeProbe: allowedFilesystem,
    markerWriter: (line) => { markers.push(line); },
    ...extra,
  });
  return { ownership, markers };
};

test("UT-OWN-INTEGRITY classifies only the explicit local filesystem allowlist", () => {
  for (const [raw, expected] of [
    [0x1a, "apfs"], [0x4244, "hfs"], [0xef53, "ext"], [0x58465342, "xfs"],
    [0x9123683e, "btrfs"], [0x01021994, "tmpfs"], [0x794c7630, "overlay"],
  ] as const) assert.equal(classifyControlStateFilesystem(raw), expected);
  for (const raw of [0x6969, 0x517b, 0xff534d42, 0x65735546, 0x12345678]) {
    assert.throws(() => classifyControlStateFilesystem(raw), /control-state-filesystem/u);
  }
});

test("UT-OWN-INTEGRITY canonicalizes symlink and lexical aliases to one physical root", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const aliasParent = join(paths.container, "aliases");
  await mkdir(aliasParent);
  await symlink(paths.workspace, join(aliasParent, "root"));
  const [physical, alias] = await Promise.all([
    canonicalizeWorkspaceRoot(paths.workspace),
    canonicalizeWorkspaceRoot(join(aliasParent, "unused", "..", "root")),
  ]);
  assert.equal(alias.canonicalPath, physical.canonicalPath);
  assert.equal(alias.device, physical.device);
  assert.equal(alias.inode, physical.inode);
});

test("UT-OWN-STATE-MATRIX preserves stable identity across clean release and reacquire", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const first = await acquire(paths);
  await first.ownership.release();
  const second = await acquire(paths);
  assert.equal(second.ownership.controlPlaneId, first.ownership.controlPlaneId);
  assert.notEqual(second.ownership.incarnationId, first.ownership.incarnationId);
  assert.match(first.markers.join("\n"), /CONTROL_PLANE_OWNERSHIP_ACQUIRED/u);
  assert.match(first.markers.join("\n"), /CONTROL_PLANE_OWNERSHIP_RELEASED/u);
  await second.ownership.release();
});

test("UT-OWN-STATE-MATRIX advances valid stable-without-owner and removes only bounded temp debris", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const first = await acquire(paths);
  await first.ownership.release();
  const entry = first.ownership.controlStateEntryPath;
  await rm(join(entry, controlPlaneOwnerFilename));
  const debris = join(entry, `.owner.json.tmp-${process.pid}-${crypto.randomUUID()}`);
  await writeFile(debris, "partial", { mode: 0o600 });
  const second = await acquire(paths);
  assert.equal(second.ownership.controlPlaneId, first.ownership.controlPlaneId);
  await assert.rejects(lstat(debris), { code: "ENOENT" });
  await second.ownership.release();
});

test("UT-OWN-STATE-MATRIX refuses malformed and mismatched pairs byte-for-byte", async (t) => {
  const cases = ["owner-without-stable", "malformed-stable", "malformed-owner", "mismatched-owner"] as const;
  for (const shape of cases) {
    await t.test(shape, async () => {
      const paths = await fixture();
      t.after(() => rm(paths.container, { recursive: true, force: true }));
      const first = await acquire(paths);
      await first.ownership.release();
      const entry = first.ownership.controlStateEntryPath;
      const stablePath = join(entry, controlPlaneIdFilename);
      const ownerPath = join(entry, controlPlaneOwnerFilename);
      if (shape === "owner-without-stable") await rm(stablePath);
      if (shape === "malformed-stable") await writeFile(stablePath, "{", { mode: 0o600 });
      if (shape === "malformed-owner") await writeFile(ownerPath, "{", { mode: 0o600 });
      if (shape === "mismatched-owner") {
        const owner = JSON.parse(await readFile(ownerPath, "utf8")) as ControlPlaneOwnerRecord;
        owner.controlPlaneId = crypto.randomUUID();
        await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      }
      const before = await Promise.all([readFile(stablePath).catch(() => null), readFile(ownerPath).catch(() => null)]);
      await assert.rejects(acquire(paths), ControlPlaneOwnershipStartupError);
      const after = await Promise.all([readFile(stablePath).catch(() => null), readFile(ownerPath).catch(() => null)]);
      assert.deepEqual(after, before);
    });
  }
});

test("UT-OWN-STATE-MATRIX recovers only an ESRCH owner and refuses a present PID unchanged", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const first = await acquire(paths);
  await first.ownership.release();
  const ownerPath = join(first.ownership.controlStateEntryPath, controlPlaneOwnerFilename);
  const stale = JSON.parse(await readFile(ownerPath, "utf8")) as ControlPlaneOwnerRecord;
  delete stale.releasedAt;
  stale.state = "owned";
  stale.pid = 2_147_483_000;
  await writeFile(ownerPath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
  const recovered = await acquire(paths, { livenessProbe: () => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); } });
  assert.equal(recovered.ownership.controlPlaneId, first.ownership.controlPlaneId);
  assert.match(recovered.markers.join("\n"), /CONTROL_PLANE_OWNERSHIP_RECOVERED/u);
  await recovered.ownership.release();

  const ambiguous = JSON.parse(await readFile(ownerPath, "utf8")) as ControlPlaneOwnerRecord;
  delete ambiguous.releasedAt;
  ambiguous.state = "owned";
  ambiguous.pid = process.pid;
  await writeFile(ownerPath, `${JSON.stringify(ambiguous)}\n`, { mode: 0o600 });
  const before = await readFile(ownerPath);
  await assert.rejects(acquire(paths), /pid-present-owner-identity-ambiguous/u);
  assert.deepEqual(await readFile(ownerPath), before);
});

test("UT-OWN-INTEGRITY refuses unsupported filesystems and missing FD_CLOEXEC", async (t) => {
  const unsupported = await fixture();
  const noCloexec = await fixture();
  t.after(() => Promise.all([
    rm(unsupported.container, { recursive: true, force: true }),
    rm(noCloexec.container, { recursive: true, force: true }),
  ]));
  await assert.rejects(acquireControlPlaneOwnership({
    workspaceRoot: unsupported.workspace,
    filesRoot: unsupported.files,
    stateDir: unsupported.state,
    filesystemTypeProbe: async () => 0x6969,
    markerWriter: () => undefined,
  }), /unsupported-nfs/u);
  await assert.rejects(acquire(noCloexec, { cloexecProbe: () => false }), /missing-cloexec/u);
});

test("RP-OWN-REPLACE poisons lock replacement and root retarget without rewriting owner evidence", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const first = await acquire(paths);
  const ownerPath = join(first.ownership.controlStateEntryPath, controlPlaneOwnerFilename);
  const lockPath = join(first.ownership.controlStateEntryPath, "ownership.lock");
  const before = await readFile(ownerPath);
  await unlink(lockPath);
  await writeFile(lockPath, "", { mode: 0o600 });
  await assert.rejects(first.ownership.assertHeld(), /poisoned:lock-path-identity-drift/u);
  await first.ownership.release();
  assert.deepEqual(await readFile(ownerPath), before);
  await assert.rejects(acquire(paths), /owner-record-identity-mismatch/u);

  const fresh = await fixture();
  t.after(() => rm(fresh.container, { recursive: true, force: true }));
  await rm(fresh.workspace, { recursive: true });
  await symlink(paths.workspace, fresh.workspace);
  const held = await acquire(fresh);
  await unlink(fresh.workspace);
  await mkdir(join(paths.container, "other-root"));
  await symlink(join(paths.container, "other-root"), fresh.workspace);
  await assert.rejects(held.ownership.assertHeld(), /workspace-root-retargeted/u);
  await held.ownership.release();
});

const waitForLine = (child: ChildProcess, pattern: RegExp, timeoutMs = 10_000): Promise<string> => new Promise((resolve, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}: ${output}`)), timeoutMs);
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (pattern.test(output)) {
      clearTimeout(timer);
      resolve(output);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
});

const waitForExit = (child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

test("RP-OWN-SAME-ALIAS production loser exits 75 before database import, reconciliation, or listen", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const aliasParent = join(paths.container, "alias-parent");
  await mkdir(aliasParent);
  await symlink(paths.workspace, join(aliasParent, "root"));
  const env = {
    ...process.env,
    RUNNER_WORKSPACE_ROOT: paths.workspace,
    FILES_ROOT: paths.files,
    CONTROL_PLANE_STATE_DIR: paths.state,
  };
  const owner = spawn(process.execPath, ["--import", "tsx", "control-plane-ownership-probe.ts"], {
    cwd: dirname(new URL(import.meta.url).pathname), env, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGTERM"); });
  await waitForLine(owner, /OWNERSHIP_PROBE_READY/u);
  const loser = spawn(process.execPath, ["--import", "tsx", "index.ts"], {
    cwd: dirname(new URL(import.meta.url).pathname),
    env: {
      ...env,
      RUNNER_WORKSPACE_ROOT: join(aliasParent, "unused", "..", "root"),
      DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/never-contact",
      API_HOST: "127.0.0.1",
      API_PORT: "0",
      SCHEDULER_POLL_INTERVAL_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let loserOutput = "";
  loser.stdout?.on("data", (chunk: Buffer) => { loserOutput += chunk.toString("utf8"); });
  loser.stderr?.on("data", (chunk: Buffer) => { loserOutput += chunk.toString("utf8"); });
  const result = await waitForExit(loser);
  assert.equal(result.code, CONTROL_PLANE_OWNERSHIP_EXIT_CODE);
  assert.match(loserOutput, /CONTROL_PLANE_OWNERSHIP_CONFLICT/u);
  assert.doesNotMatch(loserOutput, /CONTROL_PLANE_OWNERSHIP_ACQUIRED|Startup reconciliation|listening/u);
  owner.kill("SIGTERM");
  await waitForExit(owner);
});

test("RP-OWN-RECOVERY-DESCENDANT recovers after SIGKILL while execed descendant remains alive", async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.container, { recursive: true, force: true }));
  const env = {
    ...process.env,
    RUNNER_WORKSPACE_ROOT: paths.workspace,
    FILES_ROOT: paths.files,
    CONTROL_PLANE_STATE_DIR: paths.state,
    OWNERSHIP_PROBE_DESCENDANT: "1",
  };
  const owner = spawn(process.execPath, ["--import", "tsx", "control-plane-ownership-probe.ts"], {
    cwd: dirname(new URL(import.meta.url).pathname), env, stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = await waitForLine(owner, /OWNERSHIP_PROBE_READY/u);
  const descendantPid = Number(ready.match(/OWNERSHIP_PROBE_DESCENDANT_PID (\d+)/u)?.[1]);
  assert.ok(descendantPid > 0);
  t.after(() => { try { process.kill(descendantPid, "SIGTERM"); } catch { /* already gone */ } });
  owner.kill("SIGKILL");
  assert.equal((await waitForExit(owner)).signal, "SIGKILL");
  assert.doesNotThrow(() => process.kill(descendantPid, 0));

  const successor = spawn(process.execPath, ["--import", "tsx", "control-plane-ownership-probe.ts"], {
    cwd: dirname(new URL(import.meta.url).pathname),
    env: { ...env, OWNERSHIP_PROBE_DESCENDANT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (successor.exitCode === null && successor.signalCode === null) successor.kill("SIGTERM"); });
  const output = await waitForLine(successor, /OWNERSHIP_PROBE_READY/u);
  assert.match(output, /CONTROL_PLANE_OWNERSHIP_RECOVERED/u);
  successor.kill("SIGTERM");
  await waitForExit(successor);
  process.kill(descendantPid, "SIGTERM");
});
