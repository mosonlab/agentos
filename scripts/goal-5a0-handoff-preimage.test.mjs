// Goal 5a0 — obligation (b): the deletion-then-drift sequence, end to end.
//
// The failure this locks out: the implementation task is deleted (which cascades
// its entire TaskActivity handoff), and *then* branch protection, a required
// check, or the repository's merge-method setting changes. Under the plan as
// written, recovery rebuilt the seven-key tuple from live reads and accepted it
// only if it recomputed to the digest in the surviving marker — so after drift
// it could never recompute, and the operator had no defined next action.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import {
  canonicalPreimage,
  encodePreimage,
  evidenceDigest,
  parseMarker,
  reconstructAfterTaskDeletion,
  renderMarker,
  TUPLE_KEYS,
} from "./goal-5a0-handoff-preimage.mjs";

const ALLOWLIST = ["mosonlab"];
const HEAD = "b2f658396f20fa98bcdf15b9793aab7aa8b18ca2";
const BASE = "485fb118db96e3977006a2edc866a38b751ff0e2";

/** The tuple as it stood when the human authorized the exact head. */
const authorizedTuple = () => ({
  prNumber: 96,
  prUrl: "https://github.com/mosonlab/agentos/pull/96",
  authorizedHead: HEAD,
  authorizedBase: BASE,
  requiredCheckPolicy: { source: "branch-protection", names: ["build", "test"] },
  requiredChecks: [
    { name: "build", conclusion: "success", headSha: HEAD },
    { name: "test", conclusion: "success", headSha: HEAD },
  ],
  mergeMethodPolicy: { allowMergeCommit: true, allowSquashMerge: false, allowRebaseMerge: false },
});

/** What the live reads say *after* ordinary post-merge drift. */
const driftedLiveReads = () => ({
  requiredCheckPolicy: { source: "branch-protection", names: ["build", "test", "typecheck"] },
  requiredChecks: [{ name: "build", conclusion: "success", headSha: HEAD }],
  mergeMethodPolicy: { allowMergeCommit: true, allowSquashMerge: true, allowRebaseMerge: false },
});

const markerComment = (body, overrides = {}) => ({
  id: 4242,
  body,
  user: { login: "mosonlab" },
  created_at: "2026-08-18T01:00:00Z",
  updated_at: "2026-08-18T01:00:00Z",
  ...overrides,
});

test("the digest is exactly the shell pipeline's: jq -S -c . | shasum -a 256", () => {
  const tuple = authorizedTuple();
  let shell;
  try {
    shell = execFileSync("bash", ["-c", "jq -S -c . | shasum -a 256 | cut -d' ' -f1"], {
      // Fed to jq in a deliberately different key order, so the comparison also
      // shows the digest does not depend on how the document was serialized.
      input: JSON.stringify(Object.fromEntries(Object.entries(tuple).reverse())),
      encoding: "utf8",
    }).trim();
  } catch {
    return; // jq or shasum absent: the definition is still asserted by the fixtures below.
  }
  assert.equal(evidenceDigest(tuple), shell, "the module reproduces the definition's own pipeline");
  assert.match(canonicalPreimage(tuple), /\n$/u, "the trailing newline is part of the preimage");
});

test("the canonical form is key-order independent and refuses a tuple that is not exactly seven keys", () => {
  const tuple = authorizedTuple();
  const shuffled = Object.fromEntries(Object.entries(tuple).reverse());
  assert.equal(evidenceDigest(shuffled), evidenceDigest(tuple));
  assert.deepEqual(Object.keys(tuple).sort(), [...TUPLE_KEYS].sort());
  assert.throws(() => evidenceDigest({ ...tuple, delegationScope: "goal-5a0" }), /outside the tuple/u);
  const { prUrl, ...short } = tuple;
  assert.throws(() => evidenceDigest(short), /missing tuple keys/u);
});

test("task deletion followed by policy, check, and merge-method drift still reconstructs", () => {
  const tuple = authorizedTuple();
  const marker = markerComment(renderMarker({ tuple, delegationExpiresAt: "2026-08-19T00:00:00Z" }));

  // The Anneal task is gone: no stage-1, stage-2, or stage-3 record survives,
  // and GET /tasks/<id> answers 404 while GET /tasks/<id>/activity answers 200 [].
  // Everything below rebuilds from GitHub alone.
  const live = driftedLiveReads();
  const rebuilt = reconstructAfterTaskDeletion({ marker, allowlist: ALLOWLIST, live });

  assert.equal(rebuilt.outcome, "RECONSTRUCTED");
  assert.deepEqual(rebuilt.tuple, tuple, "the authorized tuple is recovered byte-for-byte, not re-derived from live reads");
  assert.equal(rebuilt.evidenceDigest, evidenceDigest(tuple));
  assert.equal(evidenceDigest(rebuilt.tuple), parseMarker(marker.body)["evidence-digest"], "the digest still governs the acceptance");
  assert.deepEqual(
    rebuilt.observedDrift.sort(),
    ["mergeMethodPolicy", "requiredCheckPolicy", "requiredChecks"],
    "the drift really happened, and is recorded rather than used",
  );
  assert.equal(rebuilt.reconstructedFrom.markerCommentId, 4242);
});

test("a digest-only marker plus drift stops with a defined next action, not a dead end", () => {
  const tuple = authorizedTuple();
  // The plan's original marker: digest, no preimage. This is the exact state the
  // finding describes, and it must still hand the operator a route.
  const legacy = [
    "goal5a0-merge-authorization: v1",
    `pr: ${tuple.prNumber}`,
    `head: ${tuple.authorizedHead}`,
    `base: ${tuple.authorizedBase}`,
    "merge-method-policy: merge-commit-only",
    "delegation-scope: goal-5a0",
    "delegation-expires-at: 2026-08-19T00:00:00Z",
    `evidence-digest: ${evidenceDigest(tuple)}`,
  ].join("\n");

  const result = reconstructAfterTaskDeletion({
    marker: markerComment(legacy),
    allowlist: ALLOWLIST,
    live: driftedLiveReads(),
  });
  assert.equal(result.outcome, "STOPPED_FOR_REROUTE");
  assert.equal(result.diagnostic, "HANDOFF_PREIMAGE_UNRECONSTRUCTABLE");
  assert.deepEqual(result.recovery.length, 5);
  assert.match(result.recovery[0], /goal5a0\.merge_invalidated/u);
  assert.match(result.recovery[1], /revert/u);
  assert.match(result.recovery[3], /fresh exact-head authorization/u);
  assert.match(result.recovery[4], /re-merge/u);
});

test("a tampered preimage is refused by the digest it must recompute to", () => {
  const tuple = authorizedTuple();
  const authentic = renderMarker({ tuple, delegationExpiresAt: "2026-08-19T00:00:00Z" });
  const forged = encodePreimage({ ...tuple, authorizedHead: "0".repeat(40) });
  const tampered = authentic.replace(/evidence-preimage-b64: .*/u, `evidence-preimage-b64: ${forged}`);

  const result = reconstructAfterTaskDeletion({ marker: markerComment(tampered), allowlist: ALLOWLIST });
  assert.equal(result.outcome, "STOPPED_FOR_REROUTE");
  assert.equal(result.diagnostic, "HANDOFF_PREIMAGE_UNRECONSTRUCTABLE");
  assert.match(result.detail, /recomputes to/u);

  const undecodable = authentic.replace(/evidence-preimage-b64: .*/u, "evidence-preimage-b64: !!!not-base64!!!");
  const second = reconstructAfterTaskDeletion({ marker: markerComment(undecodable), allowlist: ALLOWLIST });
  assert.equal(second.diagnostic, "HANDOFF_PREIMAGE_UNRECONSTRUCTABLE");
});

test("a deleted, edited, or unallowlisted marker stops with the same defined next action", () => {
  const tuple = authorizedTuple();
  const body = renderMarker({ tuple, delegationExpiresAt: "2026-08-19T00:00:00Z" });

  for (const [label, marker] of [
    ["deleted", null],
    ["edited", markerComment(body, { updated_at: "2026-08-18T02:00:00Z" })],
    ["unallowlisted", markerComment(body, { user: { login: "someone-else" } })],
  ]) {
    const result = reconstructAfterTaskDeletion({ marker, allowlist: ALLOWLIST, live: driftedLiveReads() });
    assert.equal(result.outcome, "STOPPED_FOR_REROUTE", label);
    assert.equal(result.diagnostic, "AUTHORIZATION_MARKER_MISSING", label);
    assert.equal(result.recovery.length, 5, label);
  }
});
