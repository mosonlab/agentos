import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubReader, GitHubReadError } from "./github-read.js";

test("compare preserves ancestry, rename identity, and fails completeness closed at GitHub's file ceiling", async () => {
  const files = Array.from({ length: 300 }, (_, index) => ({
    filename: index === 299 ? "src/renamed.ts" : `docs/${index}.md`,
    ...(index === 299 ? { previous_filename: "packages/api/src/merge-readiness-worker.ts" } : {}),
    patch: "+added",
  }));
  const reader = createGitHubReader("read-token", async () => new Response(JSON.stringify({
    status: "ahead", behind_by: 0, files,
  }), { status: 200 }))!;
  const compared = await reader.compareCommits!("owner/repo", "a".repeat(40), "b".repeat(40), new AbortController().signal);
  assert.equal(compared.status, "ahead");
  assert.equal(compared.behindBy, 0);
  assert.equal(compared.filesComplete, false);
  assert.equal(compared.files[299]?.previousFilename, "packages/api/src/merge-readiness-worker.ts");
});

test("compare refuses an unknown ancestry status", async () => {
  const reader = createGitHubReader("read-token", async () => new Response(JSON.stringify({
    status: "mystery", behind_by: 0, files: [],
  }), { status: 200 }))!;
  await assert.rejects(
    reader.compareCommits!("owner/repo", "a".repeat(40), "b".repeat(40), new AbortController().signal),
    (error: unknown) => error instanceof GitHubReadError && /invalid status/u.test(error.message),
  );
});

test("transport failures retry with bounded exponential delays", async () => {
  let calls = 0;
  const waits: number[] = [];
  const reader = createGitHubReader("read-token", async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ status: "ahead", behind_by: 0, files: [] }), { status: 200 });
  }, { wait: async (delayMs) => { waits.push(delayMs); } })!;

  const compared = await reader.compareCommits!(
    "owner/repo",
    "a".repeat(40),
    "b".repeat(40),
    new AbortController().signal,
  );

  assert.equal(compared.status, "ahead");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 1_000]);
});

test("permission failures never retry", async () => {
  let calls = 0;
  const waits: number[] = [];
  const reader = createGitHubReader("read-token", async () => {
    calls += 1;
    return new Response("forbidden", { status: 403 });
  }, { wait: async (delayMs) => { waits.push(delayMs); } })!;

  await assert.rejects(
    reader.compareCommits!("owner/repo", "a".repeat(40), "b".repeat(40), new AbortController().signal),
    (error: unknown) => error instanceof GitHubReadError && error.kind === "permission",
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});
