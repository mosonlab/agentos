import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedChainBranch } from "@anneal/db";

import { chainKey } from "./chain.js";

// Edge-case coverage of a pure function. The acceptance bar for this batch is
// `chain-branch.dbtest.ts`, which asserts on the Run rows real API calls wrote.

const REF = /^agentos\/chain\/[a-z0-9][a-z0-9-]{0,23}-[0-9a-f]{8}$/;

test("the same project and chain always derive the same branch", () => {
  const pair = { projectId: "proj_abc", chainId: "batch-4-fixes" };
  assert.equal(sharedChainBranch(pair), sharedChainBranch(pair));
});

test("the derived branch is a legal git ref for free-form chain ids", () => {
  for (const chainId of [
    "batch-4-fixes",
    "___---___",
    "……",
    "Batch 4: 用量正确性 / 迁移安全",
    "a".repeat(100),
    "cmswjrs1g0t5ompyja501sgxe",
  ]) {
    const branch = sharedChainBranch({ projectId: "proj_abc", chainId });
    assert.match(branch, REF, `chainId ${JSON.stringify(chainId)} produced ${branch}`);
  }
});

test("a chain id with no usable characters still yields a branch (E8)", () => {
  const branch = sharedChainBranch({ projectId: "proj_abc", chainId: "……" });
  assert.match(branch, /^agentos\/chain\/chain-[0-9a-f]{8}$/);
});

test("chain ids that slug identically still get different branches (E9)", () => {
  const projectId = "proj_abc";
  const slash = sharedChainBranch({ projectId, chainId: "a/b" });
  const dash = sharedChainBranch({ projectId, chainId: "a-b" });
  assert.equal(slash.slice(0, slash.lastIndexOf("-")), dash.slice(0, dash.lastIndexOf("-")));
  assert.notEqual(slash, dash);
});

test("one chain id in two projects yields two branches (R2, S8)", () => {
  const chainId = "shared-chain-id";
  assert.notEqual(
    sharedChainBranch({ projectId: "proj_one", chainId }),
    sharedChainBranch({ projectId: "proj_two", chainId }),
  );
});

test("the fingerprint is a hash of chainKey, so the duplicated key string cannot drift", () => {
  // `sharedChainBranch` lives in @anneal/db and cannot import `chainKey` from
  // @anneal/api (the dependency runs the other way), so the key string
  // `${projectId}:${chainId}` is written in both packages. This test is what
  // stops the two spellings from drifting apart silently.
  const pair = { projectId: "proj_abc", chainId: "batch-4-fixes" };
  const expected = createHash("sha256").update(chainKey(pair)).digest("hex").slice(0, 8);
  assert.ok(sharedChainBranch(pair).endsWith(`-${expected}`));
});
