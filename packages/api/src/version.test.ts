import "./test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import { type BuildInfo } from "@agentos/build-info";
import type { PrismaClient } from "@agentos/db";

import { createApp } from "./test-app.js";
import { API_SERVICE, apiBuildLine, versionPayload } from "./version.js";

const OID = "0123456789abcdef0123456789abcdef01234567";

const built = (overrides: Partial<BuildInfo> = {}): BuildInfo => ({
  stamped: true,
  commit: OID,
  dirty: false,
  packageName: API_SERVICE,
  version: "0.0.0",
  builtAt: "2026-08-18T00:00:00.000Z",
  ...overrides,
});

test("the version endpoint answers without a token and without touching Prisma", async () => {
  const response = await createApp({} as PrismaClient).request("/version");
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.service, "@agentos/api");
  assert.deepEqual(Object.keys(body).sort(), ["buildSha", "builtAt", "commit", "dirty", "service", "stamped", "version"]);
});

test("a process running from source says so instead of naming a commit", async () => {
  // The unit suites run this app straight from src/ under tsx, where no build
  // stamp exists. Reporting "unbuilt" is the whole point: an operator must
  // never read a commit off a process that was not built from one.
  const body = await (await createApp({} as PrismaClient).request("/version")).json() as Record<string, unknown>;
  assert.equal(body.stamped, false);
  assert.equal(body.commit, null);
  assert.equal(body.buildSha, "unbuilt");
});

test("a built process reports the commit its dist was built from", () => {
  assert.deepEqual(versionPayload(built()), {
    service: "@agentos/api",
    version: "0.0.0",
    buildSha: OID,
    commit: OID,
    dirty: false,
    stamped: true,
    builtAt: "2026-08-18T00:00:00.000Z",
  });
});

test("a build from a dirty worktree is never reported as the bare commit", () => {
  const payload = versionPayload(built({ dirty: true }));
  assert.equal(payload.buildSha, `${OID}-dirty`);
  assert.equal(payload.commit, OID);
  assert.equal(payload.dirty, true);
});

test("the version document carries provenance and nothing else", () => {
  // A field added here is a field served to unauthenticated callers. Anything
  // beyond the build's own identity belongs on an authenticated route.
  assert.deepEqual(Object.keys(versionPayload(built())).sort(),
    ["buildSha", "builtAt", "commit", "dirty", "service", "stamped", "version"]);
});

test("the startup line names the service and the build in one greppable line", () => {
  assert.equal(
    apiBuildLine(built()),
    `AgentOS API build: sha=${OID} package=@agentos/api@0.0.0 builtAt=2026-08-18T00:00:00.000Z`,
  );
  assert.match(apiBuildLine(), /^AgentOS API build: sha=unbuilt /);
});
