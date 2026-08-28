import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { spawnedStartupEnvironment } from "./test-startup-environment.js";
import { ScratchDatabaseManager } from "./testdb.js";

/**
 * The cross-boundary acceptance for build provenance (issue #140).
 *
 * Every other test in this area proves one hop: that the stamper writes what it
 * says, that the reader reads it, that the deployment check refuses what it
 * should. None of them would notice if the stamp step were quietly dropped from
 * the API's own `build` script, because none of them run it.
 *
 * This one starts from the artefacts the real build produced — `pretest:db`
 * runs `npm run build -w @anneal/api` and `-w @anneal/runner` before this
 * file is loaded — and follows the commit all the way to a real process
 * answering a real port:
 *
 *   real build script -> dist/build-info.json -> deployment check ->
 *   node dist/index.js -> GET /version
 *
 * Delete `node ../build-info/stamp.mjs dist` from either package's build script
 * and this goes red, because the file it asserts on is the one that build makes.
 * It lives at the dbtest layer because the last hop needs a real API process,
 * and a real API process needs a database.
 */

const safeEnvironmentPresent = process.env.AGENTOS_ALLOW_SCRATCH_DATABASES === "1"
  && Boolean(process.env.TEST_DATABASE_URL)
  && Boolean(process.env.TEST_DATABASE_MAINTENANCE_URL);

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const verifyCli = join(repoRoot, "packages", "build-info", "verify-dist.mjs");
const apiDist = join(repoRoot, "packages", "api", "dist");
const runnerDist = join(repoRoot, "packages", "runner", "dist");

type Stamp = {
  commit: string | null;
  dirty: boolean;
  packageName: string;
  version: string;
  builtAt: string;
};

const git = (...args: string[]): string =>
  execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const readStamp = async (dist: string): Promise<Stamp> =>
  JSON.parse(await readFile(join(dist, "build-info.json"), "utf8")) as Stamp;

/** Exit code and output of the real deployment check, run the way a restart
 *  runs it. */
const runVerify = (args: string[]): { status: number; output: string } => {
  try {
    return { status: 0, output: execFileSync(process.execPath, [verifyCli, ...args], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error: unknown) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
};

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

test("build provenance survives the whole path from the build script to /version", { skip: !safeEnvironmentPresent && "explicit safe scratch database environment is required" }, async (t) => {
  const head = git("rev-parse", "HEAD");
  const worktreeIsDirty = git("status", "--porcelain").length > 0;
  const manager = new ScratchDatabaseManager();
  const created: string[] = [];
  const children = new Set<ChildProcess>();
  // Realpath, not the mkdtemp path: on macOS /var/folders is a symlink, and the
  // control plane refuses a state directory reached through an alias.
  const container = await realpath(await mkdtemp(join(tmpdir(), "agentos-provenance-")));
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const name of created.reverse()) await manager.drop(name);
    await manager.disconnect();
    await rm(container, { recursive: true, force: true });
  });

  // --- the real build stamped both artefacts -------------------------------

  const [apiStamp, runnerStamp] = await Promise.all([readStamp(apiDist), readStamp(runnerDist)]);
  assert.equal(apiStamp.packageName, "@anneal/api");
  assert.equal(runnerStamp.packageName, "@anneal/runner");
  for (const stamp of [apiStamp, runnerStamp]) {
    assert.equal(stamp.commit, head, "the stamp names the commit this worktree is at");
    assert.equal(stamp.dirty, worktreeIsDirty, "the stamp agrees with git about uncommitted work");
  }

  // The stamp has to come from the build that produced the modules beside it.
  // Without this, dropping the stamp step from a package's `build` script goes
  // unnoticed in any tree that still has a dist from before: the leftover file
  // satisfies every assertion above. `tsc` rewrites its outputs on every run and
  // the stamper runs after it, so a stamp older than the modules it sits beside
  // is a stamp that some earlier build left behind.
  for (const dist of [apiDist, runnerDist]) {
    const [stampStat, entrypointStat] = await Promise.all([
      stat(join(dist, "build-info.json")),
      stat(join(dist, "index.js")),
    ]);
    assert.ok(
      stampStat.mtimeMs >= entrypointStat.mtimeMs,
      `${dist}/build-info.json (${stampStat.mtime.toISOString()}) predates the dist it describes (${entrypointStat.mtime.toISOString()}); it was not written by this build`,
    );
  }

  // --- the deployment check agrees, and refuses everything else -------------

  const realVerdict = runVerify(["--expected", head]);
  if (worktreeIsDirty) {
    assert.equal(realVerdict.status, 1, realVerdict.output);
    assert.match(realVerdict.output, /uncommitted changes/);
  } else {
    assert.equal(realVerdict.status, 0, realVerdict.output);
    assert.match(realVerdict.output, /every artefact is/);
  }

  const wrongCommit = runVerify(["--expected", "0".repeat(40)]);
  assert.equal(wrongCommit.status, 1);
  assert.match(wrongCommit.output, /do not start this deployment/);

  // Stale, dirty and unstamped, each built from a copy of the real artefact so
  // the refusals are about the real stamp's shape and not a hand-written one.
  const mutated = async (name: string, change: (stamp: Stamp) => Stamp | null): Promise<string> => {
    const directory = join(container, name);
    await mkdir(directory, { recursive: true });
    await copyFile(join(apiDist, "index.js"), join(directory, "index.js"));
    const next = change({ ...apiStamp });
    if (next) await writeFile(join(directory, "build-info.json"), JSON.stringify(next));
    return directory;
  };

  const refusals: Array<[string, string, RegExp]> = [
    ["stale", await mutated("stale", (stamp) => ({ ...stamp, commit: "f".repeat(40) })), /built from f{40}/],
    ["dirty", await mutated("dirty", (stamp) => ({ ...stamp, dirty: true })), /uncommitted changes/],
    ["unstamped", await mutated("unstamped", () => null), /never built/],
    ["wrong package", await mutated("swapped", (stamp) => ({ ...stamp, packageName: "@anneal/runner" })), /holds a @anneal\/runner build/],
  ];
  for (const [label, directory, reason] of refusals) {
    const verdict = runVerify(["--expected", head, "--dist", directory, "--package", "@anneal/api"]);
    assert.equal(verdict.status, 1, `${label}: ${verdict.output}`);
    assert.match(verdict.output, reason, label);
  }

  // --- the built process reports the same stamp over the wire ---------------

  const source = await manager.createMigrated("provenance");
  created.push(source.name);
  const workspace = join(container, "workspace");
  const files = join(container, "files");
  const state = join(container, "state");
  await Promise.all([mkdir(workspace), mkdir(files), mkdir(state, { mode: 0o700 })]);

  const output = { value: "" };
  const child = spawn(process.execPath, [join(apiDist, "index.js")], {
    cwd: join(repoRoot, "packages", "api"),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...spawnedStartupEnvironment({ DATABASE_URL: source.url }),
      SCHEDULER_POLL_INTERVAL_MS: "0",
      RUNNER_WORKSPACE_ROOT: workspace,
      FILES_ROOT: files,
      CONTROL_PLANE_STATE_DIR: state,
    },
  });
  children.add(child);
  const ready = await waitFor(child, /AgentOS API listening/u, output);

  const expectedSha = apiStamp.commit === null
    ? "unknown"
    : `${apiStamp.commit}${apiStamp.dirty ? "-dirty" : ""}`;
  // Printed before ownership, the database or the port could have failed.
  assert.match(
    ready,
    new RegExp(`^AgentOS API build: sha=${expectedSha} package=@anneal/api@${apiStamp.version} builtAt=${apiStamp.builtAt}`, "u"),
  );

  const port = Number(ready.match(/AgentOS API listening on http:\/\/127\.0\.0\.1:(\d+)/u)?.[1]);
  assert.ok(port > 0);
  const base = `http://127.0.0.1:${port}`;

  // Unauthenticated on purpose, like /health: whoever is checking whether a
  // restart took must be able to ask without a credential.
  const response = await fetch(`${base}/version`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    service: "@anneal/api",
    version: apiStamp.version,
    buildSha: expectedSha,
    commit: apiStamp.commit,
    dirty: apiStamp.dirty,
    stamped: true,
    builtAt: apiStamp.builtAt,
  });

  // The last hop the restart script itself takes: ask the running process, not
  // the directory, whether it is the approved commit.
  const running = runVerify(["--expected", head, "--url", base, "--package", "@anneal/api"]);
  assert.equal(running.status, worktreeIsDirty ? 1 : 0, running.output);
  assert.match(running.output, worktreeIsDirty ? /uncommitted changes/ : /every artefact is/);

  const runningWrongCommit = runVerify(["--expected", "0".repeat(40), "--url", base, "--package", "@anneal/api"]);
  assert.equal(runningWrongCommit.status, 1);

  child.kill("SIGTERM");
});
