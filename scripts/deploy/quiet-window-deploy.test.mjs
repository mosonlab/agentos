import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DeployFailure,
  dryRunDecision,
  executeUpgrade,
  gitPreflightFailure,
  quietWindowIsOpen,
  runLocked,
  shouldPersistFailure,
} from "./quiet-window-lib.mjs";
import {
  controlledLaunchdPath,
  parseInstallerArgs,
  renderLaunchdPlist,
  verifyBackupConfiguration,
  verifyRenderedToolchain,
} from "./install-launchd.mjs";
import {
  acquireProcessLock,
  blockingRunsStatement,
  deployArtifactPaths,
  inspectGitPreflight,
  publishDirectories,
  workspaceDependencyPaths,
} from "./quiet-window-adapters.mjs";
import {
  backupConfigurationFromEnvironment,
  writePgDumpBackup,
} from "./quiet-window-backup.mjs";
import { createProductionHost } from "./quiet-window-host.mjs";
import { createDeployInterruption } from "./quiet-window-interrupt.mjs";

const revisions = { from: "a".repeat(40), to: "b".repeat(40) };

const fixture = (failure = null) => {
  const calls = [];
  const state = { serving: "previous", escalated: null, notification: null, restarted: false };
  const step = (name, work = async () => undefined) => async () => {
    calls.push(name);
    if (failure === name) {
      const reason = name === "canonical-prompt-sync" ? "canonical-prompt-sync-refused" : `${name}-failed`;
      throw new DeployFailure(reason, "fixture");
    }
    return work();
  };
  const host = {
    fastForward: step("fast-forward", async () => revisions.to),
    createStage: step("create-stage"),
    installDependencies: step("install-dependencies"),
    prismaGenerate: step("prisma-generate"),
    build: step("build"),
    backup: step("backup"),
    guardedMigration: step("guarded-migration"),
    syncCanonicalPrompts: step("canonical-prompt-sync"),
    verifyRuntimePrismaClient: step("verify-runtime-prisma-client"),
    assertQuietBeforeRestart: step("quiet-recheck"),
    publishBuild: step("publish-build", async () => {
      state.serving = "candidate";
      return {
        rollback: async () => { calls.push("rollback-build"); state.serving = "previous"; },
        commit: async () => { calls.push("commit-build"); },
      };
    }),
    restartServices: step("restart-services", async () => { state.restarted = true; }),
    verifyServices: step("verify-services"),
    restorePreviousServices: step("restore-previous-services", async () => { state.restarted = false; }),
    escalate: async (record) => { calls.push("escalate"); state.escalated = record; },
    notify: async (record) => { calls.push(`notify-${record.outcome}`); state.notification = record; },
    cleanupStage: async () => { calls.push("cleanup-stage"); },
  };
  return { host, calls, state };
};

test("quiet-window predicate blocks only claimed, provisioning, and running", () => {
  for (const status of ["claimed", "provisioning", "running", "CLAIMED", "RUNNING"]) {
    assert.equal(quietWindowIsOpen([{ status }]), false, status);
  }
  for (const status of ["queued", "waiting-inbox", "succeeded", "failed"]) {
    assert.equal(quietWindowIsOpen([{ status }]), true, status);
  }
  assert.equal(quietWindowIsOpen([{ status: "queued" }, { status: "waiting-inbox" }]), true);
});

test("production host factory refuses a missing mechanism", () => {
  assert.throws(() => createProductionHost({}), /production-host-adapter-missing:fastForward/u);
});

test("published artifacts derive every workspace dependency tree from the target manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-workspaces-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
  for (const workspace of ["apps/web", "packages/api", "packages/runner"]) {
    mkdirSync(join(root, workspace), { recursive: true });
    writeFileSync(join(root, workspace, "package.json"), JSON.stringify({ name: workspace }));
  }
  const nested = workspaceDependencyPaths(root);
  assert.deepEqual(nested, ["apps/web/node_modules", "packages/api/node_modules", "packages/runner/node_modules"]);
  const artifacts = deployArtifactPaths(root);
  assert.equal(artifacts.at(-1), "node_modules");
  assert.ok(artifacts.includes("packages/api/dist"));
  for (const path of nested) assert.ok(artifacts.includes(path));
  rmSync(root, { recursive: true, force: true });
});

test("git preflight names dirty and non-fast-forward refusals", () => {
  assert.equal(gitPreflightFailure({ dirty: true, head: "a", target: "b", fastForward: true }), "dirty-working-tree");
  assert.equal(gitPreflightFailure({ dirty: false, head: "a", target: "b", fastForward: false }), "non-fast-forward-main");
  assert.equal(gitPreflightFailure({ dirty: false, head: "a", target: "b", fastForward: true }), null);
  assert.equal(gitPreflightFailure({ dirty: false, head: "b", target: "b", fastForward: false }), null);
});

test("dry-run failures never persist escalation state", () => {
  assert.equal(shouldPersistFailure({ dryRun: true, reason: "environment-unreadable" }), false);
  assert.equal(shouldPersistFailure({ dryRun: true, reason: "usage" }), false);
  assert.equal(shouldPersistFailure({ dryRun: false, reason: "environment-unreadable" }), true);
  assert.equal(shouldPersistFailure({ dryRun: false, reason: "usage" }), false);
});

test("idle quiet-wait interruption is non-sticky while an upgrade interruption escalates", () => {
  assert.equal(shouldPersistFailure({
    dryRun: false,
    reason: "deploy-interrupted",
    upgradeStarted: false,
  }), false);
  assert.equal(shouldPersistFailure({
    dryRun: false,
    reason: "deploy-interrupted",
    upgradeStarted: true,
  }), true);
});

test("successful upgrade runs the safety sequence in order", async () => {
  const { host, calls, state } = fixture();
  assert.deepEqual(await executeUpgrade(host, revisions), { ok: true });
  assert.deepEqual(calls, [
    "fast-forward", "create-stage", "install-dependencies", "prisma-generate", "build", "backup",
    "guarded-migration", "canonical-prompt-sync", "verify-runtime-prisma-client", "quiet-recheck",
    "publish-build", "restart-services", "verify-services", "notify-success", "commit-build", "cleanup-stage",
  ]);
  assert.equal(state.serving, "candidate");
  assert.equal(state.notification.from, revisions.from);
  assert.equal(state.notification.to, revisions.to);
});

test("the first failing step stops the pipeline and keeps the previous build serving", async () => {
  const { host, calls, state } = fixture("build");
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "build-failed");
  assert.deepEqual(calls, [
    "fast-forward", "create-stage", "install-dependencies", "prisma-generate", "build",
    "escalate", "notify-failure", "cleanup-stage",
  ]);
  assert.equal(state.serving, "previous");
  assert.equal(state.restarted, false);
  assert.equal(state.escalated.reason, "build-failed");
});

test("structural sync refusal escalates without publishing or restarting", async () => {
  const { host, calls, state } = fixture("canonical-prompt-sync");
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "canonical-prompt-sync-refused");
  assert.equal(calls.includes("publish-build"), false);
  assert.equal(calls.includes("restart-services"), false);
  assert.equal(state.serving, "previous");
  assert.equal(state.escalated.reason, "canonical-prompt-sync-refused");
});

test("restart failure rolls the build back and restarts the previous services", async () => {
  const { host, calls, state } = fixture("restart-services");
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(state.serving, "previous");
  assert.equal(calls.includes("rollback-build"), true);
  assert.equal(calls.includes("restore-previous-services"), true);
  assert.equal(calls.includes("commit-build"), false);
});

test("SIGTERM after publication enters the failure path and restores the previous services", async () => {
  const interruption = createDeployInterruption();
  const { host, calls, state } = fixture();
  host.restartServices = async () => {
    calls.push("restart-services");
    assert.equal(interruption.interrupt("SIGTERM"), true);
    interruption.throwIfInterrupted();
  };
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "deploy-interrupted");
  assert.equal(result.failure.detail, "SIGTERM");
  assert.equal(state.serving, "previous");
  assert.ok(calls.includes("rollback-build"));
  assert.ok(calls.includes("restore-previous-services"));
  assert.ok(calls.includes("notify-failure"));
});

test("a service that exits after kickstart rolls back before success", async () => {
  const { host, calls, state } = fixture("verify-services");
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "verify-services-failed");
  assert.equal(state.serving, "previous");
  assert.ok(calls.includes("rollback-build"));
  assert.ok(calls.includes("restore-previous-services"));
  assert.equal(calls.includes("notify-success"), false);
});

test("a stale /version target is a service-verification failure", async () => {
  const { host, calls, state } = fixture();
  host.verifyServices = async () => {
    calls.push("verify-services-stale-version");
    throw new DeployFailure("service-verification-failed", "stale-version");
  };
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "service-verification-failed");
  assert.equal(state.serving, "previous");
  assert.ok(calls.includes("restore-previous-services"));
});

test("notification revisions use the target fixed by fetch after a quiet wait", async () => {
  const { host, state } = fixture();
  const advanced = "c".repeat(40);
  host.fastForward = async () => advanced;
  assert.deepEqual(await executeUpgrade(host, revisions), { ok: true });
  assert.equal(state.notification.to, advanced);
});

test("a held lock prevents a concurrent pipeline", async () => {
  let ran = false;
  const lines = [];
  const result = await runLocked({ acquireLock: async () => null, log: (line) => lines.push(line) }, async () => {
    ran = true;
  });
  assert.equal(ran, false);
  assert.deepEqual(result, { ok: true, skipped: "lock-held" });
  assert.deepEqual(lines, ["SKIP concurrent-run lock-held"]);
});

test("a lock is released after the owner fails", async () => {
  let released = false;
  await assert.rejects(
    runLocked({
      acquireLock: async () => ({ release: async () => { released = true; } }),
      log: () => undefined,
    }, async () => { throw new Error("fixture"); }),
    /fixture/,
  );
  assert.equal(released, true);
});

test("the production SQL is derived from the blocking-status authority", () => {
  const statement = blockingRunsStatement();
  assert.deepEqual(statement.parameters, ["claimed", "provisioning", "running"]);
  assert.match(statement.sql, /IN \(\$1,\$2,\$3\)/u);
  for (const status of statement.parameters) assert.equal(statement.sql.includes(`'${status}'`), false);
});

test("production Git preflight refuses real dirty and divergent repositories", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-git-"));
  const git = "/usr/bin/git";
  const run = (...args) => execFileSync(git, ["-C", root, ...args], { encoding: "utf8" }).trim();
  run("init", "-b", "main");
  run("config", "user.name", "Fixture");
  run("config", "user.email", "fixture@example.com");
  writeFileSync(join(root, "file"), "base");
  run("add", "file");
  run("commit", "-m", "base");
  const base = run("rev-parse", "HEAD");
  run("checkout", "-b", "target");
  writeFileSync(join(root, "file"), "target");
  run("commit", "-am", "target");
  const target = run("rev-parse", "HEAD");
  run("checkout", "--detach", base);
  assert.equal(inspectGitPreflight({ git, root, target }).refusal, null);
  writeFileSync(join(root, "dirty"), "dirty");
  assert.equal(inspectGitPreflight({ git, root, target }).refusal, "dirty-working-tree");
  rmSync(join(root, "dirty"));
  writeFileSync(join(root, "file"), "divergent");
  run("commit", "-am", "divergent");
  assert.equal(inspectGitPreflight({ git, root, target }).refusal, "non-fast-forward-main");
  rmSync(root, { recursive: true, force: true });
});

test("a killed filesystem-lock owner is reclaimed with process identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-lock-"));
  const lockPath = join(root, "lock");
  const moduleUrl = new URL("./quiet-window-adapters.mjs", import.meta.url).href;
  const code = `import { acquireProcessLock } from ${JSON.stringify(moduleUrl)}; acquireProcessLock({path:${JSON.stringify(lockPath)}}); console.log('READY'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((accept, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (chunk) => chunk.includes("READY") ? accept() : reject(new Error("lock owner not ready")));
    child.once("error", reject);
  });
  assert.equal(acquireProcessLock({ path: lockPath }), null);
  child.kill("SIGKILL");
  await new Promise((accept) => child.once("exit", accept));
  let pipelineRan = false;
  await assert.rejects(
    runLocked({
      acquireLock: async () => acquireProcessLock({ path: lockPath }),
      log: () => undefined,
    }, async () => { pipelineRan = true; }),
    /stale-deploy-owner-recovered/u,
  );
  assert.equal(pipelineRan, false);
  const nextOwner = acquireProcessLock({ path: lockPath });
  assert.equal(nextOwner?.recovered, null);
  await nextOwner?.release();
  rmSync(root, { recursive: true, force: true });
});

test("real directory publication restores previous bytes after a partial swap", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-publish-"));
  const stage = join(root, "stage");
  const previous = join(root, "previous");
  for (const path of ["one/dist", "two/dist"]) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "value"), `old-${path}`);
  }
  mkdirSync(join(stage, "one/dist"), { recursive: true });
  writeFileSync(join(stage, "one/dist/value"), "new-one");
  assert.throws(
    () => publishDirectories({ root, stage, previousDirectory: previous, paths: ["one/dist", "two/dist"] }),
    /build-swap-failed/u,
  );
  assert.equal(readFileSync(join(root, "one/dist/value"), "utf8"), "old-one/dist");
  assert.equal(readFileSync(join(root, "two/dist/value"), "utf8"), "old-two/dist");
  rmSync(root, { recursive: true, force: true });
});

test("publication replaces or removes every workspace-local dependency tree transactionally", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-workspace-publish-"));
  const stage = join(root, "stage");
  const previous = join(root, "previous");
  for (const path of ["packages/api/node_modules", "packages/runner/node_modules"]) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "value"), `old-${path}`);
  }
  mkdirSync(join(stage, "packages/api/node_modules"), { recursive: true });
  writeFileSync(join(stage, "packages/api/node_modules/value"), "new-api");
  const publication = publishDirectories({
    root,
    stage,
    previousDirectory: previous,
    paths: ["packages/api/node_modules", "packages/runner/node_modules"],
    optionalMissingPaths: ["packages/api/node_modules", "packages/runner/node_modules"],
  });
  assert.equal(readFileSync(join(root, "packages/api/node_modules/value"), "utf8"), "new-api");
  assert.equal(existsSync(join(root, "packages/runner/node_modules")), false);
  await publication.rollback();
  assert.equal(readFileSync(join(root, "packages/api/node_modules/value"), "utf8"), "old-packages/api/node_modules");
  assert.equal(readFileSync(join(root, "packages/runner/node_modules/value"), "utf8"), "old-packages/runner/node_modules");
  rmSync(root, { recursive: true, force: true });
});

test("dry-run reads every decision surface and invokes no mutation", async () => {
  const calls = [];
  const result = await dryRunDecision({
    revisions: async () => { calls.push("revisions"); return { from: "a", source: "a", to: "b" }; },
    blockingRuns: async () => { calls.push("runs"); return [{ id: "r1", status: "waiting-inbox" }]; },
    repositoryState: async () => { calls.push("repository"); return { dirty: false, fastForward: "yes" }; },
    serviceState: async () => { calls.push("services"); return { ok: true }; },
    authorityState: async () => { calls.push("authority"); return { ok: true }; },
    backupState: async () => { calls.push("backup"); return { ok: true, mode: "container" }; },
  });
  assert.equal(result.quiet, true);
  assert.deepEqual(new Set(calls), new Set(["revisions", "runs", "repository", "services", "authority", "backup"]));
  assert.ok(result.lines.includes("DRY-RUN backup=ready mode=container"));
  assert.equal(result.lines.filter((line) => line.includes("mutation=skipped")).length, 11);
});

test("dry-run reports a refused container backup contract as a named decision", async () => {
  const result = await dryRunDecision({
    revisions: async () => ({ from: "a", source: "a", to: "b" }),
    blockingRuns: async () => [],
    repositoryState: async () => ({ dirty: false, fastForward: "yes" }),
    serviceState: async () => ({ ok: true }),
    authorityState: async () => ({ ok: true }),
    backupState: async () => ({
      ok: false,
      mode: "container",
      reason: "backup-container-pg-dump-not-executable:/missing/pg_dump",
    }),
  });
  assert.equal(result.backup.ok, false);
  assert.ok(result.lines.includes(
    "DRY-RUN backup=not-ready mode=container reason=backup-container-pg-dump-not-executable:/missing/pg_dump",
  ));
});

const fakeDocker = (root) => {
  const path = join(root, "docker-fixture");
  writeFileSync(path, `#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'true\\n'
  exit 0
fi
if [ -n "$FAKE_DOCKER_LOG" ]; then
  printf '%s\\n' "$@" > "$FAKE_DOCKER_LOG"
  printf 'password=%s\\n' "$PGPASSWORD" >> "$FAKE_DOCKER_LOG"
fi
if [ -n "$FAKE_DOCKER_DELAY" ]; then
  sleep "$FAKE_DOCKER_DELAY"
fi
if [ "$FAKE_DOCKER_FAIL" = "1" ]; then
  printf 'fixture backup failed\\n' >&2
  exit 42
fi
printf 'PGDUMP-CUSTOM-FIXTURE'
`);
  chmodSync(path, 0o755);
  return path;
};

test("installer requires an explicit backup mode and executable configuration", () => {
  assert.throws(() => parseInstallerArgs([]), /installer-option-required:--pg-dump-mode/u);
  assert.throws(
    () => parseInstallerArgs([
      "--pg-dump-mode", "container",
      "--pg-dump-container", "agentos-postgres-1",
      "--container-pg-dump-binary", "/usr/local/bin/pg_dump",
    ]),
    /installer-option-required:--docker-binary/u,
  );
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-installer-refusal-"));
  const docker = join(root, "docker");
  writeFileSync(docker, "#!/bin/sh\nexit 0\n");
  chmodSync(docker, 0o644);
  assert.throws(
    () => verifyBackupConfiguration({
      mode: "container",
      dockerBinary: docker,
      container: "agentos-postgres-1",
      pgDumpBinary: "/usr/local/bin/pg_dump",
    }),
    /backup-configuration-invalid:docker-binary-not-executable/u,
  );
  chmodSync(docker, 0o755);
  assert.throws(
    () => verifyBackupConfiguration({
      mode: "container",
      dockerBinary: docker,
      container: "agentos-postgres-1",
      pgDumpBinary: "/usr/local/bin/pg_dump",
    }, (_program, args) => {
      if (args[0] === "inspect") return "true\n";
      throw new Error("not executable");
    }),
    /backup-container-pg-dump-not-executable/u,
  );
  assert.throws(
    () => backupConfigurationFromEnvironment({ DEPLOY_PG_DUMP_MODE: "container" }),
    /DEPLOY_PG_DUMP_CONTAINER-invalid/u,
  );
  rmSync(root, { recursive: true, force: true });
});

test("installer verifies and renders the production container backup contract", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-installer-"));
  const docker = fakeDocker(root);
  const parsed = parseInstallerArgs([
    "--pg-dump-mode", "container",
    "--docker-binary", docker,
    "--pg-dump-container", "agentos-postgres-1",
    "--container-pg-dump-binary", "/usr/local/bin/pg_dump",
  ]);
  const backup = verifyBackupConfiguration(parsed.backup);
  assert.deepEqual(backup, {
    mode: "container",
    dockerBinary: realpathSync(docker),
    container: "agentos-postgres-1",
    pgDumpBinary: "/usr/local/bin/pg_dump",
  });
  const template = readFileSync(new URL("./com.agentos.auto-deploy.plist.in", import.meta.url), "utf8");
  const rendered = renderLaunchdPlist(template, {
    nodeBinary: "/node&bin",
    deployScript: "/repo/<deploy>",
    repositoryRoot: "/repo",
    stdoutPath: "/logs/out",
    stderrPath: "/logs/err",
    path: "/node&path:/usr/bin:/bin",
    gitBinary: "/usr/bin/git",
    npmBinary: "/opt/homebrew/bin/npm",
    backup,
  });
  assert.match(rendered, /\/node&amp;bin/u);
  assert.match(rendered, /\/node&amp;path:\/usr\/bin:\/bin/u);
  assert.match(rendered, /\/repo\/&lt;deploy&gt;/u);
  assert.match(rendered, /\/opt\/homebrew\/bin\/npm/u);
  assert.match(rendered, /<key>PATH<\/key>/u);
  assert.match(rendered, /DEPLOY_NODE_BINARY/u);
  assert.match(rendered, /DEPLOY_PG_DUMP_MODE/u);
  assert.match(rendered, /agentos-postgres-1/u);
  assert.match(rendered, /DEPLOY_CONTAINER_PG_DUMP_BINARY/u);
  assert.doesNotMatch(rendered, /DEPLOY_PG_DUMP_BINARY/u);
  assert.doesNotMatch(rendered, /__[A-Z_]+__/u);
  const renderedPath = join(root, "rendered.plist");
  writeFileSync(renderedPath, rendered);
  execFileSync("/usr/bin/plutil", ["-lint", renderedPath], { stdio: "ignore" });
  rmSync(root, { recursive: true, force: true });
});

test("installer proves node, git, and npm under the exact rendered launchd PATH", () => {
  const values = {
    nodeBinary: "/opt/node/bin/node",
    gitBinary: "/opt/git/bin/git",
    npmBinary: "/opt/npm/npm-cli.js",
  };
  const path = controlledLaunchdPath(values);
  assert.equal(path, "/opt/node/bin:/opt/git/bin:/usr/local/bin:/usr/bin:/bin");
  const calls = [];
  verifyRenderedToolchain({ ...values, path }, (program, args, options) => {
    calls.push({ program, args, path: options.env.PATH });
    return "fixture\n";
  });
  assert.deepEqual(calls, [
    { program: values.nodeBinary, args: ["--version"], path },
    { program: values.gitBinary, args: ["--version"], path },
    { program: values.nodeBinary, args: [values.npmBinary, "--version"], path },
  ]);
});

test("container backup preserves pg_dump arguments and writes host output atomically", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-backup-"));
  const docker = fakeDocker(root);
  const logPath = join(root, "arguments");
  const output = join(root, "backup.dump");
  await writePgDumpBackup({
    configuration: {
      mode: "container",
      dockerBinary: docker,
      container: "agentos-postgres-1",
      pgDumpBinary: "/usr/local/bin/pg_dump",
    },
    databaseUrl: "postgresql://fixture:placeholder%40value@127.0.0.1:5544/agentos",
    output,
    env: { ...process.env, FAKE_DOCKER_LOG: logPath },
  });
  const flow = readFileSync(logPath, "utf8").split("\n");
  assert.deepEqual(flow.slice(0, 13), [
    "exec", "--env", "PGPASSWORD", "agentos-postgres-1", "/usr/local/bin/pg_dump",
    "-Fc", "--host", "127.0.0.1", "--port", "5544", "--username", "fixture", "--dbname",
  ]);
  assert.equal(flow[13], "agentos");
  assert.equal(flow[14], "password=placeholder@value");
  assert.equal(flow.some((value) => value.includes("placeholder@value") && !value.startsWith("password=")), false);
  assert.equal(readFileSync(output, "utf8"), "PGDUMP-CUSTOM-FIXTURE");
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(root).filter((name) => name.includes(".partial-")), []);
  rmSync(root, { recursive: true, force: true });
});

test("container backup failure leaves no final or partial host backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-backup-failure-"));
  const docker = fakeDocker(root);
  const output = join(root, "backup.dump");
  await assert.rejects(
    writePgDumpBackup({
      configuration: {
        mode: "container",
        dockerBinary: docker,
        container: "agentos-postgres-1",
        pgDumpBinary: "/usr/local/bin/pg_dump",
      },
      databaseUrl: "postgresql://alice:secret@localhost:5432/agentos",
      output,
      env: { ...process.env, FAKE_DOCKER_FAIL: "1" },
    }),
    /pg_dump-exit-42: fixture backup failed/u,
  );
  assert.equal(existsSync(output), false);
  assert.deepEqual(readdirSync(root).filter((name) => name.includes(".partial-")), []);
  rmSync(root, { recursive: true, force: true });
});

test("an interrupted container backup terminates the child and removes its partial file", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-backup-interrupt-"));
  const docker = fakeDocker(root);
  const output = join(root, "backup.dump");
  const controller = new AbortController();
  const pending = writePgDumpBackup({
    configuration: {
      mode: "container",
      dockerBinary: docker,
      container: "agentos-postgres-1",
      pgDumpBinary: "/usr/local/bin/pg_dump",
    },
    databaseUrl: "postgresql://alice:secret@localhost:5432/agentos",
    output,
    env: { ...process.env, FAKE_DOCKER_DELAY: "10" },
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /pg_dump-interrupted/u);
  assert.equal(existsSync(output), false);
  assert.deepEqual(readdirSync(root).filter((name) => name.includes(".partial-")), []);
  rmSync(root, { recursive: true, force: true });
});
