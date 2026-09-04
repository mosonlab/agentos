import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@anneal/db";

import {
  SPAWNED_OPERATOR_TOKEN,
  spawnedSourceEntrypointArgv,
  spawnedStartupEnvironment,
} from "./test-startup-environment.js";
import { testDatabaseUrl } from "./testdb.js";

type ProjectResponse = {
  id: string;
  specGateDefault: boolean;
  mergeGateDefault: boolean;
  skipOptionalSteps: boolean;
};

const waitForListening = (child: ChildProcess): Promise<number> => new Promise((resolve, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error(`API did not start: ${output}`)), 60_000);
  const inspect = (): void => {
    const match = output.match(/Anneal API listening on http:\/\/127\.0\.0\.1:(\d+)/u);
    if (!match) return;
    clearTimeout(timer);
    resolve(Number(match[1]));
  };
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); inspect(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); inspect(); });
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("exit", (code, signal) => {
    if (code !== null || signal !== null) {
      clearTimeout(timer);
      reject(new Error(`API exited before listening (${code ?? signal}): ${output}`));
    }
  });
});

const waitForExit = (child: ChildProcess): Promise<void> => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve();
  else child.once("exit", () => resolve());
});

const request = async (base: string, method: string, path: string, body?: unknown): Promise<Response> => fetch(`${base}${path}`, {
  method,
  headers: {
    Authorization: `Bearer ${SPAWNED_OPERATOR_TOKEN}`,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("fresh projects expose and independently patch the optional-step switch through the real API", async () => {
  const db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const roots = await Promise.all((await Promise.all([
    mkdtemp(join(tmpdir(), "agentos-project-optional-workspace-")),
    mkdtemp(join(tmpdir(), "agentos-project-optional-files-")),
    mkdtemp(join(tmpdir(), "agentos-project-optional-state-")),
  ])).map((root) => realpath(root)));
  const child = spawn(process.execPath, spawnedSourceEntrypointArgv("src/index.ts"), {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      ...spawnedStartupEnvironment({ DATABASE_URL: testDatabaseUrl }),
      RUNNER_WORKSPACE_ROOT: roots[0],
      FILES_ROOT: roots[1],
      CONTROL_PLANE_STATE_DIR: roots[2],
      SCHEDULER_POLL_INTERVAL_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let projectId: string | null = null;
  try {
    const base = `http://127.0.0.1:${await waitForListening(child)}`;
    const createdResponse = await request(base, "POST", "/projects", {
      name: "Project optional steps",
      slug: `project-optional-${process.pid}-${Date.now()}`,
      yamlDocument: "",
    });
    const created = await createdResponse.json() as ProjectResponse;
    assert.equal(createdResponse.status, 201, JSON.stringify(created));
    projectId = created.id;
    assert.deepEqual({
      skipOptionalSteps: created.skipOptionalSteps,
      specGateDefault: created.specGateDefault,
      mergeGateDefault: created.mergeGateDefault,
    }, { skipOptionalSteps: false, specGateDefault: false, mergeGateDefault: false });

    const detailResponse = await request(base, "GET", `/projects/${projectId}`);
    const detail = await detailResponse.json() as ProjectResponse;
    assert.equal(detailResponse.status, 200, JSON.stringify(detail));
    assert.equal(detail.skipOptionalSteps, false);

    const optionalResponse = await request(base, "PATCH", `/projects/${projectId}`, { skipOptionalSteps: true });
    const optional = await optionalResponse.json() as ProjectResponse;
    assert.equal(optionalResponse.status, 200, JSON.stringify(optional));
    assert.deepEqual({
      skipOptionalSteps: optional.skipOptionalSteps,
      specGateDefault: optional.specGateDefault,
      mergeGateDefault: optional.mergeGateDefault,
    }, { skipOptionalSteps: true, specGateDefault: false, mergeGateDefault: false });

    const specResponse = await request(base, "PATCH", `/projects/${projectId}`, { specGateDefault: true });
    const spec = await specResponse.json() as ProjectResponse;
    assert.equal(specResponse.status, 200, JSON.stringify(spec));
    assert.deepEqual({
      skipOptionalSteps: spec.skipOptionalSteps,
      specGateDefault: spec.specGateDefault,
      mergeGateDefault: spec.mergeGateDefault,
    }, { skipOptionalSteps: true, specGateDefault: true, mergeGateDefault: false });

    const mergeResponse = await request(base, "PATCH", `/projects/${projectId}`, { mergeGateDefault: true });
    const merge = await mergeResponse.json() as ProjectResponse;
    assert.equal(mergeResponse.status, 200, JSON.stringify(merge));
    assert.deepEqual({
      skipOptionalSteps: merge.skipOptionalSteps,
      specGateDefault: merge.specGateDefault,
      mergeGateDefault: merge.mergeGateDefault,
    }, { skipOptionalSteps: true, specGateDefault: true, mergeGateDefault: true });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForExit(child);
    if (projectId !== null) await db.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await db.$disconnect();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});
