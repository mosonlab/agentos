import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
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

const makeCallerFixture = (name) => {
  const directory = mkdtempSync(join(tmpdir(), "host-proof-caller."));
  const script = join(directory, name);
  writeFileSync(script, "#!/usr/bin/env bash\nbash \"$@\"\n", { mode: 0o755 });
  chmodSync(script, 0o755);
  return { directory, script };
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

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
  callerScript,
  toolsDirectory,
  detached = false,
}) => {
  const invocation = callerScript === undefined
    ? [wrapper, "test", workspace, "--", ...command]
    : [callerScript, wrapper, "test", workspace, "--", ...command];
  const child = spawn("bash", invocation, {
    cwd: repositoryRoot,
    detached,
    env: cleanEnvironment({
      AGENTOS_RUN_ID: runId,
      AGENTOS_HOST_PROOF_SLOT_DIR: slotDirectory,
      AGENTOS_HOST_PROOF_SLOTS: String(slotCount),
      ...(toolsDirectory === undefined ? {} : { AGENTOS_TOOLS: toolsDirectory }),
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

test("the host fast path execs the child without touching a missing slot path", async () => {
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
});

test("the host fast path executes only builtins before exec", async () => {
  const missing = join(testRoot, "must-not-be-probed");
  const traceFastPath = async (environment) => {
    const child = spawn("bash", ["-x", wrapper, "build", "@anneal/test", "--", process.execPath, "-e", "process.exit(0)"], {
      cwd: repositoryRoot,
      env: cleanEnvironment({
        AGENTOS_HOST_PROOF_SLOT_DIR: missing,
        AGENTOS_HOST_PROOF_SLOTS: "not-a-count",
        ...environment,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let trace = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { trace += chunk; });
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => resolve({ status, signal }));
    });
    assert.deepEqual(result, { status: 0, signal: null });
    assert.equal(trace.includes(missing), false, "the fast path inspected the sentinel slot path");
    assert.match(trace, /^\+ \[\[ .* \]\]\n(?:\+ \[\[ .* \]\]\n)?\+ host_proof_slot_exec_child .*\n\+ shift 3\n\+ exec /u);
    assert.equal(existsSync(missing), false);
  };

  await traceFastPath({});
});

test("a forged Regression bypass takes the slot path and audits the caller command line", async (t) => {
  const caller = makeCallerFixture("forged-host-proof-bypass-caller.sh");
  t.after(() => rmSync(caller.directory, { recursive: true, force: true }));
  const missing = join(testRoot, "forged-bypass-slot-directory");
  const marker = join(testRoot, "forged-bypass-child.marker");
  t.after(() => rmSync(marker, { force: true }));

  const result = await spawnWrapper({
    slotDirectory: missing,
    slotCount: 1,
    runId: "run-forged-host-proof-bypass",
    bypass: "regression-verification",
    callerScript: caller.script,
    toolsDirectory: caller.directory,
    command: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker],
  }).promise;
  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    new RegExp(`host-proof-slot: test for workspace @anneal/test in Run run-forged-host-proof-bypass cannot admit: slot directory ${escapeRegExp(missing)} is not a non-symlink directory`, "u"),
  );
  assert.ok(
    result.stderr.split("\n").some((line) => line.includes(caller.script)),
    `forged bypass audit did not include caller command line: ${result.stderr}`,
  );
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(missing), false);
});

test("host-proof-slot accepts the bypass only for a regression-verification.sh ancestor under AGENTOS_TOOLS", async (t) => {
  const caller = makeCallerFixture("regression-verification.sh");
  t.after(() => rmSync(caller.directory, { recursive: true, force: true }));
  const missing = join(testRoot, "legitimate-bypass-slot-directory");
  const marker = join(testRoot, "legitimate-bypass-child.marker");
  t.after(() => rmSync(marker, { force: true }));
  const command = [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ok')", marker];

  const result = await spawnWrapper({
    slotDirectory: missing,
    slotCount: "also-not-a-count",
    runId: "run-legitimate-host-proof-bypass",
    bypass: "regression-verification",
    callerScript: caller.script,
    toolsDirectory: caller.directory,
    command,
  }).promise;
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
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
    assert.equal(
      result.stderr,
      `host-proof-slot: test for workspace @anneal/test in Run run-not-bypassed cannot admit: slot directory ${missing} is not a non-symlink directory\n`,
    );
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(missing), false);
  }
});

test("an ordinary Run rejects a slot count above the runner maximum", async () => {
  const slotDirectory = makeSlotDirectory(1);
  const result = await spawnWrapper({
    slotDirectory,
    slotCount: 1025,
    runId: "run-too-many-slots",
    command: [process.execPath, "-e", "process.exit(0)"],
  }).promise;
  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "host-proof-slot: test for workspace @anneal/test in Run run-too-many-slots cannot admit: AGENTOS_HOST_PROOF_SLOTS must be a positive integer no greater than 1024\n",
  );
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

test("a signal-terminated child terminates the wrapper by the same signal and releases the slot", async () => {
  const slotDirectory = makeSlotDirectory(1);
  const result = await spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-signal",
    command: ["/bin/sh", "-c", "kill -TERM $$"],
  }).promise;
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGTERM");

  const successor = await spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-after-signal",
    command: [process.execPath, "-e", "process.exit(0)"],
  }).promise;
  assert.equal(successor.status, 0);
});

test("a background grandchild cannot inherit and pin the acquired slot", async () => {
  const slotDirectory = makeSlotDirectory(1);
  const orphaning = await spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-orphaning",
    command: ["/bin/sh", "-c", "/bin/sleep 2 </dev/null >/dev/null 2>&1 &"],
  }).promise;
  assert.equal(orphaning.status, 0);

  const startedAt = Date.now();
  const successor = await spawnWrapper({
    slotDirectory,
    slotCount: 1,
    runId: "run-after-orphan",
    command: [process.execPath, "-e", "process.exit(0)"],
  }).promise;
  assert.equal(successor.status, 0);
  assert.ok(Date.now() - startedAt < 1_000, "an orphaned descendant retained the slot descriptor");
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

test("the source-only clock seam enforces the timeout while scanning slots", async () => {
  const slotDirectory = makeSlotDirectory(1);
  const childMarker = join(testRoot, "inner-timeout-child");
  const sourceHarness = [
    '. "$1"',
    "fake_calls=0",
    "host_proof_slot_set_now() { fake_calls=$((fake_calls + 1)); if (( fake_calls >= 3 )); then HOST_PROOF_SLOT_NOW=1200; else HOST_PROOF_SLOT_NOW=0; fi; }",
    'host_proof_slot_main test @anneal/inner-timeout -- "$2" "$3" "$4" "$5"',
  ].join("; ");
  const timeout = spawn("bash", ["-c", sourceHarness, "source-host-proof-slot", wrapper, process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", childMarker], {
    cwd: repositoryRoot,
    env: cleanEnvironment({
      AGENTOS_RUN_ID: "run-inner-timeout",
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

  assert.deepEqual(result, { status: 75, signal: null });
  assert.equal(stdout, "");
  assert.equal(
    stderr,
    `host-proof-slot: test for workspace @anneal/inner-timeout in Run run-inner-timeout timed out after 1200s waiting in ${slotDirectory}\n`,
  );
  assert.equal(existsSync(childMarker), false);
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

test("all workspace proof manifests are wrapped exactly once without changing commands or lifecycle hooks", () => {
  const expected = {
    "apps/web/package.json": {
      name: "@anneal/web",
      scripts: {
        build: "/bin/sh -c 'tsc -b && vite build'",
        typecheck: "tsc -b --pretty false",
        test: "/bin/sh -c 'TSX_TSCONFIG_PATH=tsconfig.app.json node --conditions=development --import tsx --test \"src/**/*.test.ts\" \"src/**/*.test.tsx\"'",
      },
      hooks: {},
    },
    "packages/api/package.json": {
      name: "@anneal/api",
      scripts: {
        build: "/bin/sh -c 'tsc -p tsconfig.json && node ../build-info/stamp.mjs dist'",
        typecheck: "tsc -p tsconfig.json --noEmit",
        test: "node --conditions=development --import tsx --test src/*.test.ts src/routes/*.test.ts src/files/*.test.ts",
        "test:db": "node --conditions=development --import tsx scripts/dbtest.mjs",
      },
      hooks: {},
    },
    "packages/build-info/package.json": {
      name: "@anneal/build-info",
      scripts: { test: "node --conditions=development --test *.test.mjs" },
      hooks: {},
    },
    "packages/db/package.json": {
      name: "@anneal/db",
      scripts: {
        build: "tsc -p tsconfig.json",
        typecheck: "/bin/sh -c 'tsc -p tsconfig.json --noEmit && npm run typecheck:cli'",
        test: "node --conditions=development --import tsx --test prisma/*.test.ts src/*.test.ts",
        "test:db": "node --conditions=development --import tsx --test --test-concurrency=1 src/*.dbtest.ts",
      },
      hooks: {},
    },
    "packages/github-client/package.json": {
      name: "@anneal/github-client",
      scripts: {
        build: "tsc -p tsconfig.json",
        typecheck: "tsc -p tsconfig.json --noEmit",
        test: "node --conditions=development --import tsx --test src/*.test.ts",
      },
      hooks: {},
    },
    "packages/inbox/package.json": {
      name: "@anneal/inbox",
      scripts: {
        build: "tsc -p tsconfig.json",
        typecheck: "tsc -p tsconfig.json --noEmit",
        test: "node --conditions=development --import tsx --test src/*.test.ts",
      },
      hooks: {},
    },
    "packages/merge-executor/package.json": {
      name: "@anneal/merge-executor",
      scripts: {
        build: "tsc -p tsconfig.json",
        typecheck: "tsc -p tsconfig.json --noEmit",
        test: "node --conditions=development --import tsx --test src/*.test.ts",
      },
      hooks: {},
    },
    "packages/runner/package.json": {
      name: "@anneal/runner",
      scripts: {
        build: "/bin/sh -c 'tsc -p tsconfig.json && node scripts/build-runtime-tools.mjs && node ../build-info/stamp.mjs dist'",
        typecheck: "tsc -p tsconfig.json --noEmit",
        test: "node --conditions=development --import tsx --test src/*.test.ts src/adapters/*.test.ts scripts/*.test.mjs",
      },
      hooks: {},
    },
  };

  const proofNames = new Set(["build", "typecheck", "lint", "test", "test:db"]);
  let wrappedCount = 0;
  for (const [relativePath, contract] of Object.entries(expected)) {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, relativePath), "utf8"));
    assert.equal(manifest.name, contract.name);
    assert.equal("lint" in manifest.scripts, false, `${contract.name} unexpectedly added lint`);
    if ("start" in manifest.scripts) {
      assert.doesNotMatch(
        manifest.scripts.start,
        /--conditions(?:=|\s+)development/u,
        `${contract.name} production start selected development exports`,
      );
    }
    assert.deepEqual(
      Object.keys(manifest.scripts).filter((name) => proofNames.has(name)).sort(),
      Object.keys(contract.scripts).sort(),
      `${contract.name} changed the exact proof-script surface`,
    );
    for (const [scriptName, innerCommand] of Object.entries(contract.scripts)) {
      const prefix = `bash ../../scripts/host-proof-slot.sh ${scriptName} ${contract.name} -- `;
      assert.equal(manifest.scripts[scriptName], `${prefix}${innerCommand}`);
      assert.equal(manifest.scripts[scriptName].split("scripts/host-proof-slot.sh").length - 1, 1);
      wrappedCount += 1;
    }
    for (const [hookName, command] of Object.entries(contract.hooks)) {
      assert.equal(manifest.scripts[hookName], command, `${contract.name} changed ${hookName}`);
      assert.equal(manifest.scripts[hookName].includes("host-proof-slot.sh"), false);
    }
  }
  assert.equal(wrappedCount, 24);
});

test("Runner child fixtures keep their audited development-condition counts", () => {
  const audits = [
    {
      path: "packages/runner/src/regression-verification-script.test.ts",
      execPathReferences: 1,
      developmentConditions: 0,
      childMarker: "REGRESSION_FIXTURE_NODE: process.execPath",
    },
    {
      path: "packages/runner/src/adapters.test.ts",
      execPathReferences: 7,
      developmentConditions: 0,
      childMarker: 'runAsPrefix: [process.execPath, "-e", stubScript]',
    },
    {
      path: "packages/runner/src/run-output.test.ts",
      execPathReferences: 1,
      developmentConditions: 1,
      childMarker: "pathToFileURL(fileURLToPath(new URL(\"./mcp-server.ts\", import.meta.url))).href",
    },
  ];

  for (const audit of audits) {
    const source = readFileSync(join(repositoryRoot, audit.path), "utf8");
    assert.equal(
      source.match(/process\.execPath/gu)?.length ?? 0,
      audit.execPathReferences,
      `${audit.path} added or removed a Node child; audit its transitive graph and select development exports if it reaches repository source`,
    );
    assert.match(source, new RegExp(audit.childMarker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.equal(
      source.match(/--conditions=development/gu)?.length ?? 0,
      audit.developmentConditions,
      `${audit.path} changed the audited child condition count`,
    );
  }
});
