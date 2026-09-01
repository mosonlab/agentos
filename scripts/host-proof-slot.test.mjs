import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = join(repositoryRoot, "scripts", "host-proof-slot.sh");

const testRoot = mkdtempSync(join(tmpdir(), "host-proof-slot-test."));
after(() => rmSync(testRoot, { recursive: true, force: true }));

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitFor = async (predicate, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await delay(10);
  }
};

const cleanEnvironment = (overrides = {}) => {
  const environment = { ...process.env, NO_COLOR: "1" };
  delete environment.AGENTOS_RUN_ID;
  delete environment.AGENTOS_RUN_SCOPE_BYPASS;
  delete environment.AGENTOS_HOST_PROOF_SLOT_DIR;
  delete environment.AGENTOS_HOST_PROOF_SLOTS;
  return { ...environment, ...overrides };
};

const makeSlotDirectory = (count) => {
  const directory = join(testRoot, `slots-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(directory, { mode: 0o755 });
  for (let slot = 1; slot <= count; slot += 1) {
    writeFileSync(join(directory, `slot-${slot}.lock`), "", { mode: 0o666 });
  }
  return directory;
};

const commandThatMarksActive = [
  "const fs = require('node:fs');",
  "const marker = process.argv[1];",
  "const duration = Number(process.argv[2]);",
  "const status = Number(process.argv[3]);",
  "fs.writeFileSync(marker, 'active');",
  "setTimeout(() => { try { fs.unlinkSync(marker); } catch {} process.exit(status); }, duration);",
].join(" ");

const markerCommand = (marker, duration = 100, status = 0) => [
  process.execPath,
  "-e",
  commandThatMarksActive,
  marker,
  String(duration),
  String(status),
];

const spawnWrapper = ({
  slotDirectory,
  slotCount,
  runId = "run-test",
  workspace = "@anneal/test",
  command,
  bypass,
  detached = false,
}) => {
  const child = spawn("bash", [wrapper, "test", workspace, "--", ...command], {
    cwd: repositoryRoot,
    detached,
    env: cleanEnvironment({
      AGENTOS_RUN_ID: runId,
      AGENTOS_HOST_PROOF_SLOT_DIR: slotDirectory,
      AGENTOS_HOST_PROOF_SLOTS: String(slotCount),
      ...(bypass === undefined ? {} : { AGENTOS_RUN_SCOPE_BYPASS: bypass }),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const promise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, promise, get closed() { return child.exitCode !== null || child.signalCode !== null; } };
};

test("host and exact Regression bypass exec the child without touching a missing slot path", async () => {
  const missing = join(testRoot, "must-not-be-created");
  const marker = join(testRoot, "host-fast-path.marker");
  const command = [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ok')", marker];

  const host = spawn("bash", [wrapper, "build", "@anneal/test", "--", ...command], {
    cwd: repositoryRoot,
    env: cleanEnvironment({
      AGENTOS_HOST_PROOF_SLOT_DIR: missing,
      AGENTOS_HOST_PROOF_SLOTS: "not-a-count",
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let hostStdout = "";
  let hostStderr = "";
  host.stdout.setEncoding("utf8");
  host.stderr.setEncoding("utf8");
  host.stdout.on("data", (chunk) => { hostStdout += chunk; });
  host.stderr.on("data", (chunk) => { hostStderr += chunk; });
  const hostResult = await new Promise((resolve, reject) => {
    host.once("error", reject);
    host.once("close", (status, signal) => resolve({ status, signal }));
  });
  assert.equal(hostResult.status, 0);
  assert.equal(hostStdout, "");
  assert.equal(hostStderr, "");
  assert.equal(existsSync(marker), true);
  assert.equal(existsSync(missing), false);

  rmSync(marker, { force: true });
  const bypass = spawnWrapper({
    slotDirectory: missing,
    slotCount: "also-not-a-count",
    runId: "run-bypassed",
    bypass: "regression-verification",
    command,
  });
  const bypassResult = await bypass.promise;
  assert.equal(bypassResult.status, 0);
  assert.equal(bypassResult.stdout, "");
  assert.equal(bypassResult.stderr, "");
  assert.equal(existsSync(marker), true);
  assert.equal(existsSync(missing), false);
});

test("a Run with absent, empty, or wrong bypass does not skip admission", async () => {
  const missing = join(testRoot, "ordinary-run-must-not-create");
  const marker = join(testRoot, "ordinary-run.marker");
  const command = [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker];

  for (const bypass of [undefined, "", "regression", "regression-verification "]) {
    rmSync(marker, { force: true });
    const result = await spawnWrapper({
      slotDirectory: missing,
      slotCount: 1,
      runId: "run-not-bypassed",
      bypass,
      command,
    }).promise;
    assert.notEqual(result.status, 0, `bypass ${String(bypass)} unexpectedly ran`);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(missing), false);
  }
});

test("the acquired slot spans the child and preserves every child status, including 75", async () => {
  const slotDirectory = makeSlotDirectory(1);
  for (const status of [0, 37, 75]) {
    const result = await spawnWrapper({
      slotDirectory,
      slotCount: 1,
      runId: `run-status-${status}`,
      command: [process.execPath, "-e", `process.exit(${status})`],
    }).promise;
    assert.equal(result.status, status);
    assert.equal(result.signal, null);
  }
});

test("N+1 Runs share N slots while retaining each command's exit status", async () => {
  const slotCount = 2;
  const slotDirectory = makeSlotDirectory(slotCount);
  const activeDirectory = join(testRoot, "active-concurrency");
  mkdirSync(activeDirectory);
  const statuses = [0, 17, 23];
  const jobs = statuses.map((status, index) => spawnWrapper({
    slotDirectory,
    slotCount,
    runId: `run-concurrent-${index}`,
    workspace: `@anneal/workspace-${index}`,
    command: markerCommand(join(activeDirectory, `child-${index}`), 300, status),
  }));

  let maximumActive = 0;
  while (jobs.some((job) => !job.closed)) {
    maximumActive = Math.max(maximumActive, readdirSync(activeDirectory).length);
    await delay(10);
  }
  const results = await Promise.all(jobs.map((job) => job.promise));
  maximumActive = Math.max(maximumActive, readdirSync(activeDirectory).length);
  assert.equal(maximumActive, slotCount);
  assert.deepEqual(results.map((result) => result.status), statuses);
  assert.deepEqual(results.map((result) => result.stdout), ["", "", ""]);
  assert.deepEqual(results.map((result) => result.stderr), ["", "", ""]);
});

test("a source-only clock and wait seam reaches the 1,200-second timeout without running the child", async () => {
  const slotDirectory = makeSlotDirectory(1);
  const holderMarker = join(testRoot, "timeout-holder");
  const childMarker = join(testRoot, "timeout-child");
  const holder = spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-timeout-holder",
    command: markerCommand(holderMarker, 10_000),
    detached: true,
  });
  await waitFor(() => existsSync(holderMarker));

  const sourceHarness = [
    '. "$1"',
    "fake_now=0",
    "host_proof_slot_set_now() { HOST_PROOF_SLOT_NOW=$fake_now; }",
    "host_proof_slot_wait() { fake_now=1200; }",
    'host_proof_slot_main test @anneal/timeout -- "$2" "$3" "$4" "$5"',
  ].join("; ");
  const timeout = spawn("bash", ["-c", sourceHarness, "source-host-proof-slot", wrapper, process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", childMarker], {
    cwd: repositoryRoot,
    env: cleanEnvironment({
      AGENTOS_RUN_ID: "run-timeout",
      AGENTOS_HOST_PROOF_SLOT_DIR: slotDirectory,
      AGENTOS_HOST_PROOF_SLOTS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  timeout.stdout.setEncoding("utf8");
  timeout.stderr.setEncoding("utf8");
  timeout.stdout.on("data", (chunk) => { stdout += chunk; });
  timeout.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    timeout.once("error", reject);
    timeout.once("close", (status, signal) => resolve({ status, signal }));
  });

  assert.equal(result.status, 75);
  assert.equal(result.signal, null);
  assert.equal(stdout, "");
  assert.equal(
    stderr,
    `host-proof-slot: test for workspace @anneal/timeout in Run run-timeout timed out after 1200s waiting in ${slotDirectory}\n`,
  );
  assert.equal(existsSync(childMarker), false);

  process.kill(-holder.child.pid, "SIGTERM");
  await holder.promise;
});

test("a killed holder releases its descriptor, while a live holder is never reclaimed", async () => {
  const slotDirectory = makeSlotDirectory(1);
  const holderMarker = join(testRoot, "stale-holder");
  const waiterMarker = join(testRoot, "stale-waiter");
  const holder = spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-live-holder",
    command: markerCommand(holderMarker, 10_000),
    detached: true,
  });
  await waitFor(() => existsSync(holderMarker));

  const waiter = spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-waiter",
    command: markerCommand(waiterMarker, 50),
  });
  await delay(300);
  assert.equal(waiter.closed, false, "a live holder was reclaimed");
  assert.equal(existsSync(waiterMarker), false);

  process.kill(-holder.child.pid, "SIGTERM");
  await holder.promise;
  const waiterResult = await waiter.promise;
  assert.equal(waiterResult.status, 0);
  assert.equal(waiterResult.stdout, "");
  assert.equal(waiterResult.stderr, "");
});
