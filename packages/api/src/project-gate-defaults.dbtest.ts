import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
  yamlDocument: string;
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
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve();
    return;
  }
  child.once("exit", () => resolve());
});

const request = async (base: string, method: string, path: string, body?: unknown): Promise<Response> => fetch(`${base}${path}`, {
  method,
  headers: {
    Authorization: `Bearer ${SPAWNED_OPERATOR_TOKEN}`,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("fresh project defaults are returned by the real API and patch independently", async () => {
  const db = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const roots = await Promise.all([
    mkdtemp(join(tmpdir(), "agentos-project-gates-workspace-")),
    mkdtemp(join(tmpdir(), "agentos-project-gates-files-")),
    mkdtemp(join(tmpdir(), "agentos-project-gates-state-")),
  ]);
  const child = spawn(process.execPath, spawnedSourceEntrypointArgv("index.ts"), {
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
    const port = await waitForListening(child);
    const base = `http://127.0.0.1:${port}`;
    const slug = `project-gates-${process.pid}-${Date.now()}`;
    const createdResponse = await request(base, "POST", "/projects", {
      name: "Project gate defaults",
      slug,
      yamlDocument: "",
    });
    const created = await createdResponse.json() as ProjectResponse;
    assert.equal(createdResponse.status, 201, JSON.stringify(created));
    projectId = created.id;
    assert.deepEqual(
      { specGateDefault: created.specGateDefault, mergeGateDefault: created.mergeGateDefault },
      { specGateDefault: false, mergeGateDefault: false },
    );

    const listedResponse = await request(base, "GET", "/projects");
    const listed = await listedResponse.json() as ProjectResponse[];
    assert.equal(listedResponse.status, 200);
    assert.deepEqual(listed.find(({ id }) => id === projectId), created);

    const detailResponse = await request(base, "GET", `/projects/${projectId}`);
    const detail = await detailResponse.json() as ProjectResponse;
    assert.equal(detailResponse.status, 200);
    assert.deepEqual(
      { specGateDefault: detail.specGateDefault, mergeGateDefault: detail.mergeGateDefault },
      { specGateDefault: false, mergeGateDefault: false },
    );

    const specOnResponse = await request(base, "PATCH", `/projects/${projectId}`, { specGateDefault: true });
    const specOn = await specOnResponse.json() as ProjectResponse;
    assert.equal(specOnResponse.status, 200);
    assert.deepEqual(
      { specGateDefault: specOn.specGateDefault, mergeGateDefault: specOn.mergeGateDefault },
      { specGateDefault: true, mergeGateDefault: false },
    );

    const mergeOnResponse = await request(base, "PATCH", `/projects/${projectId}`, { mergeGateDefault: true });
    const mergeOn = await mergeOnResponse.json() as ProjectResponse;
    assert.equal(mergeOnResponse.status, 200);
    assert.deepEqual(
      { specGateDefault: mergeOn.specGateDefault, mergeGateDefault: mergeOn.mergeGateDefault },
      { specGateDefault: true, mergeGateDefault: true },
    );

    const preserveResponse = await request(base, "PATCH", `/projects/${projectId}`, { yamlDocument: "kept" });
    const preserved = await preserveResponse.json() as ProjectResponse;
    assert.equal(preserveResponse.status, 200);
    assert.deepEqual(
      { specGateDefault: preserved.specGateDefault, mergeGateDefault: preserved.mergeGateDefault },
      { specGateDefault: true, mergeGateDefault: true },
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForExit(child);
    if (projectId !== null) await db.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await db.$disconnect();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});
