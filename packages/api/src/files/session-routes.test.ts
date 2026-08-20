import "../test-workspace-root.js";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PrismaClient } from "@agentos/db";

import { createApp } from "../test-app.js";
import { resetFileStores } from "./config.js";
import type { GrantLike } from "./grants.js";

const token = "agos_session_files_test_token";
const headers = { Authorization: `Bearer ${token}` };
const grant = (folderPath: string, permissions: Partial<GrantLike> = {}): GrantLike => ({
  folderPath, canRead: false, canWrite: false, canDelete: false, ...permissions,
});

test("session file routes enforce grants over a real filesystem", async (suite) => {
  const root = await mkdtemp(join(tmpdir(), "agentos-session-files-"));
  const previousRoot = process.env.FILES_ROOT;
  process.env.FILES_ROOT = root;
  resetFileStores();
  let grants: GrantLike[] = [];
  const database = {
    run: {
      findFirst: async () => ({ id: "run-1", leaseGeneration: 1 }),
      findUnique: async () => ({ agentId: "agent-1" }),
    },
    filesystemGrant: { findMany: async () => grants },
  } as unknown as PrismaClient;
  const app = createApp(database);
  const put = (path: string, content: string, encoding: "utf8" | "base64" = "utf8") => app.request("/session/runs/run-1/files/content", {
    method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ path, content, encoding }),
  });
  const read = (path: string) => app.request(`/session/runs/run-1/files/content?${new URLSearchParams({ path })}`, { headers });
  const list = (dir: string) => app.request(`/session/runs/run-1/files?${new URLSearchParams({ dir })}`, { headers });
  suite.after(async () => {
    resetFileStores();
    if (previousRoot === undefined) delete process.env.FILES_ROOT;
    else process.env.FILES_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  });

  await suite.test("read-only folder grant allows list/read, denies write/outside, then write grant admits", async () => {
    await writeFile(join(root, "slug.txt"), "unrelated");
    await writeFile(join(root, "seed"), "seed");
    await (await import("node:fs/promises")).mkdir(join(root, "slug"));
    await writeFile(join(root, "slug", "inside.txt"), "inside");
    grants = [grant("slug", { canRead: true })];
    assert.equal((await list("slug")).status, 200);
    assert.equal((await read("slug/inside.txt")).status, 200);
    const deniedWrite = await put("slug/new.txt", "new");
    assert.equal(deniedWrite.status, 403);
    assert.match(await deniedWrite.text(), /canWrite/u);
    assert.equal((await read("seed")).status, 403);
    grants.push(grant("slug", { canWrite: true }));
    assert.equal((await put("slug/new.txt", "new")).status, 200);
  });

  await suite.test("root grant reaches every folder", async () => {
    grants = [grant("", { canRead: true })];
    assert.equal((await list("")).status, 200);
    assert.equal((await read("slug/inside.txt")).status, 200);
  });

  await suite.test("drop-box permits write but not read", async () => {
    grants = [grant("drop", { canWrite: true })];
    assert.equal((await put("drop/item.txt", "drop")).status, 200);
    const response = await read("drop/item.txt");
    assert.equal(response.status, 403);
    assert.match(await response.text(), /canRead/u);
  });

  await suite.test("overlapping grants admit when only the broader one has capability", async () => {
    grants = [grant("slug/narrow", { canRead: true }), grant("slug", { canWrite: true })];
    assert.equal((await put("slug/narrow/item.txt", "ok")).status, 200);
  });

  await suite.test("dirty grant rows fail closed and 403 body names the exact capability", async () => {
    grants = [grant("a/", { canDelete: true }), grant("/abs", { canRead: true })];
    const response = await app.request("/session/runs/run-1/files?path=slug%2Finside.txt", { method: "DELETE", headers });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Filesystem grant missing canDelete" });
  });

  await suite.test("5 MB read boundary stats before reading", async () => {
    grants = [grant("limits", { canRead: true })];
    await (await import("node:fs/promises")).mkdir(join(root, "limits"), { recursive: true });
    await writeFile(join(root, "limits", "under.bin"), "");
    await truncate(join(root, "limits", "under.bin"), 5 * 1024 * 1024 - 1);
    await writeFile(join(root, "limits", "over.bin"), "");
    await truncate(join(root, "limits", "over.bin"), 5 * 1024 * 1024 + 1);
    assert.equal((await read("limits/under.bin")).status, 200);
    assert.equal((await read("limits/over.bin")).status, 413);
  });

  await suite.test("25 MB decoded write boundary is enforced", async () => {
    grants = [grant("write-limit", { canWrite: true })];
    const exactly = Buffer.alloc(25 * 1024 * 1024).toString("base64");
    assert.equal((await put("write-limit/exact.bin", exactly, "base64")).status, 200);
    const over = Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64");
    assert.equal((await put("write-limit/over.bin", over, "base64")).status, 413);
  });

  await suite.test("a hardlink under a granted folder leaks no outside file through read or write", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agentos-session-outside-"));
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "SAFE");
    await mkdir(join(root, "granted"), { recursive: true });
    await link(sentinel, join(root, "granted", "innocent.txt"));
    grants = [grant("granted", { canRead: true, canWrite: true })];
    const denied = await read("granted/innocent.txt");
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /Hard link refused/u);
    assert.equal((await put("granted/innocent.txt", "PWNED")).status, 200);
    assert.equal(await readFile(sentinel, "utf8"), "SAFE");
    await rm(outside, { recursive: true, force: true });
  });

  await suite.test("chunked write aborts near the cap instead of materializing the whole stream", async () => {
    grants = [grant("chunked", { canWrite: true })];
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
        if (pulls === 1000) controller.close();
      },
    });
    const request = new Request("http://localhost/session/runs/run-1/files/content", {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await app.fetch(request);
    assert.equal(response.status, 413);
    assert.equal(pulls <= 546, true, `reader pulled ${pulls} chunks`);
  });

  await suite.test("invalid UTF-8 returns a base64 marker and round-trips", async () => {
    grants = [grant("binary", { canRead: true, canWrite: true })];
    const original = Buffer.from([0xff, 0xfe, 0xfd]);
    assert.equal((await put("binary/value.bin", original.toString("base64"), "base64")).status, 200);
    const response = await read("binary/value.bin");
    const body = await response.json() as { encoding: string; content: string };
    assert.equal(body.encoding, "base64");
    assert.deepEqual(Buffer.from(body.content, "base64"), original);
  });
});
