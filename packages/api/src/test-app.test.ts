import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PrismaClient } from "@anneal/db";

import { createApp } from "./test-app.js";

const withWorkspaceRootEnv = async (value: string | undefined, body: () => void | Promise<void>) => {
  const previous = process.env.RUNNER_WORKSPACE_ROOT;
  if (value === undefined) delete process.env.RUNNER_WORKSPACE_ROOT;
  else process.env.RUNNER_WORKSPACE_ROOT = value;
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.RUNNER_WORKSPACE_ROOT;
    else process.env.RUNNER_WORKSPACE_ROOT = previous;
  }
};

test("test-app refuses to start without an explicit workspace root", async () => {
  await withWorkspaceRootEnv(undefined, () => {
    assert.throws(() => createApp({} as PrismaClient), /requires an explicit workspace root/u);
  });
});

test("test-app refuses the production default root even when set explicitly", async () => {
  const production = join(homedir(), ".agentos", "runs");
  await withWorkspaceRootEnv(production, () => {
    assert.throws(() => createApp({} as PrismaClient), /refuses workspace root/u);
  });
  await withWorkspaceRootEnv(undefined, () => {
    assert.throws(() => createApp({} as PrismaClient, { workspaceRoot: production }), /refuses workspace root/u);
  });
});

test("test-app refuses a symlink alias of a forbidden root", async () => {
  // A forbidden root reached through a symlink must not defeat the string check.
  const forbidden = await mkdtemp(join(tmpdir(), "agentos-test-app-owned-"));
  const stateDir = await mkdtemp(join(tmpdir(), "agentos-test-app-state-"));
  await mkdir(join(stateDir, "plane-1"));
  await writeFile(join(stateDir, "plane-1", "owner.json"), JSON.stringify({ canonicalWorkspaceRoot: forbidden }));
  const aliasParent = await mkdtemp(join(tmpdir(), "agentos-test-app-alias-"));
  const alias = join(aliasParent, "root");
  await symlink(forbidden, alias);
  const previousStateDir = process.env.CONTROL_PLANE_STATE_DIR;
  process.env.CONTROL_PLANE_STATE_DIR = stateDir;
  try {
    await withWorkspaceRootEnv(undefined, () => {
      assert.throws(() => createApp({} as PrismaClient, { workspaceRoot: forbidden }), /refuses workspace root/u);
      assert.throws(() => createApp({} as PrismaClient, { workspaceRoot: alias }), /refuses workspace root/u);
    });
  } finally {
    if (previousStateDir === undefined) delete process.env.CONTROL_PLANE_STATE_DIR;
    else process.env.CONTROL_PLANE_STATE_DIR = previousStateDir;
  }
});

test("test-app accepts an isolated temporary root", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-test-app-ok-"));
  await withWorkspaceRootEnv(undefined, () => {
    assert.ok(createApp({} as PrismaClient, { workspaceRoot: root }));
  });
});
