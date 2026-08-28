import "../test-workspace-root.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PrismaClient } from "@anneal/db";

import { createApp } from "../test-app.js";
import { resetFileStores } from "./config.js";
import type { GrantLike } from "./grants.js";

const NFC = "café";
const NFD = NFC.normalize("NFD");
const operator = { Authorization: "Bearer files-alias-operator-token", "Content-Type": "application/json" };
const session = { Authorization: "Bearer agos_session_alias_test_token" };
const grant = (folderPath: string, permissions: Partial<GrantLike> = {}): GrantLike => ({
  folderPath, canRead: false, canWrite: false, canDelete: false, ...permissions,
});

test("grant keys follow the filesystem rather than the spelling", async (suite) => {
  const root = await mkdtemp(join(tmpdir(), "agentos-alias-"));
  const previousRoot = process.env.FILES_ROOT;
  const previousToken = process.env.OPERATOR_TOKEN;
  process.env.FILES_ROOT = root;
  process.env.OPERATOR_TOKEN = "files-alias-operator-token";
  resetFileStores();
  await mkdir(join(root, "Protected"));
  await writeFile(join(root, "Protected", "value.txt"), "ORIGINAL");
  await mkdir(join(root, NFC));
  await writeFile(join(root, NFC, "value.txt"), "ORIGINAL");
  // The fix asks the filesystem instead of assuming a volume, so the tests ask too.
  const caseInsensitive = existsSync(join(root, "protected", "value.txt"));
  const normalizationInsensitive = existsSync(join(root, NFD, "value.txt"));

  let grants: GrantLike[] = [];
  const database = {
    run: { findFirst: async () => ({ id: "run-1", leaseGeneration: 1 }), findUnique: async () => ({ agentId: "agent-1" }) },
    filesystemGrant: {
      findMany: async () => grants.map((row, index) => ({ id: `grant-${index}`, ...row })),
      upsert: async ({ create }: { create: GrantLike }) => create,
    },
  } as unknown as PrismaClient;
  const app = createApp(database);
  const read = (path: string) => app.request(`/session/runs/run-1/files/content?${new URLSearchParams({ path })}`, { headers: session });
  const put = (path: string, content: string) => app.request("/session/runs/run-1/files/content", {
    method: "PUT", headers: { ...session, "Content-Type": "application/json" }, body: JSON.stringify({ path, content }),
  });
  const createGrant = (folderPath: string) => app.request("/agents/agent-1/filesystem-grants", {
    method: "POST", headers: operator, body: JSON.stringify({ folderPath, canWrite: true }),
  });
  suite.after(async () => {
    resetFileStores();
    if (previousRoot === undefined) delete process.env.FILES_ROOT;
    else process.env.FILES_ROOT = previousRoot;
    if (previousToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  });

  await suite.test("a case alias cannot carry a second, differently permissioned grant", {
    skip: caseInsensitive ? false : "volume is case-sensitive; the two spellings are genuinely two folders here",
  }, async () => {
    grants = [grant("Protected", { canRead: true })];
    // Byte-exact matching denied this while the filesystem served the same directory;
    // one key means the grant covers what it physically covers.
    assert.equal((await read("protected/value.txt")).status, 200);
    // ...and covers it with exactly the capabilities it was given, no more.
    assert.equal((await put("protected/value.txt", "PWNED")).status, 403);
    // The escalation: a writable grant on the other spelling of the same folder.
    const conflict = await createGrant("protected");
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json() as { error: string }).error, /same folder as the existing grant "Protected"/u);
  });

  await suite.test("an NFC/NFD alias cannot carry a second, differently permissioned grant", {
    skip: normalizationInsensitive ? false : "volume is normalization-sensitive; the two spellings are genuinely two folders here",
  }, async () => {
    grants = [grant(NFD, { canRead: true })];
    assert.equal((await read(`${NFC}/value.txt`)).status, 200);
    assert.equal((await put(`${NFC}/value.txt`, "PWNED")).status, 403);
    const conflict = await createGrant(NFC);
    assert.equal(conflict.status, 409);
  });

  await suite.test("a genuinely different folder is not an alias collision", async () => {
    grants = [grant("Protected", { canRead: true })];
    assert.equal((await createGrant("Protected-sibling")).status, 201);
    assert.equal((await read("Protected-sibling/value.txt")).status, 403);
  });
});
