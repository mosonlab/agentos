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
