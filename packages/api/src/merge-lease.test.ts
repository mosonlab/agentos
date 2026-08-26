import assert from "node:assert/strict";
import test from "node:test";

import {
  withMergeLease,
  type MergeLeaseAcquirer,
  type MergeLeaseRelease,
  type MergeLeaseReleaser,
} from "./merge-lease.js";

const acquired: MergeLeaseAcquirer = async () => ({ outcome: "acquired" });
const released: MergeLeaseRelease = {
  outcome: "released",
  ref: "refs/merge-lease/holder",
  sha: "abc",
};

test("a completed callback releases the merge Lease", async () => {
  const acquiredFor: string[] = [];
  const releasedFor: string[] = [];
  const result = await withMergeLease("chain-1", async () => ({
    disposition: "release",
    value: 42,
  }), {
    acquire: async (chainId) => {
      acquiredFor.push(chainId);
      return { outcome: "acquired" };
    },
    release: async (chainId) => {
      releasedFor.push(chainId);
      return released;
    },
  });

  assert.deepEqual(result, { outcome: "ran", value: 42 });
  assert.deepEqual(acquiredFor, ["chain-1"]);
  assert.deepEqual(releasedFor, ["chain-1"]);
});

test("retain hands the merge Lease to the downstream consumer", async () => {
  let releaseCalled = false;
  const result = await withMergeLease("chain-2", async () => ({
    disposition: "retain",
    value: "authorized",
  }), {
    acquire: acquired,
    release: async () => {
      releaseCalled = true;
      return released;
    },
  });

  assert.deepEqual(result, { outcome: "ran", value: "authorized" });
  assert.equal(releaseCalled, false);
});

test("a callback exception still releases the merge Lease", async () => {
  const releasedFor: string[] = [];
  await assert.rejects(
    withMergeLease("chain-3", async () => {
      throw new Error("authorization failed");
    }, {
      acquire: acquired,
      release: async (chainId) => {
        releasedFor.push(chainId);
        return released;
      },
    }),
    /authorization failed/u,
  );
  assert.deepEqual(releasedFor, ["chain-3"]);
});

test("a contended merge Lease does not run the callback", async () => {
  let callbackCalled = false;
  let releaseCalled = false;
  const result = await withMergeLease("chain-4", async () => {
    callbackCalled = true;
    return { disposition: "release", value: null };
  }, {
    acquire: async () => ({ outcome: "contended" }),
    release: async () => {
      releaseCalled = true;
      return released;
    },
  });

  assert.deepEqual(result, { outcome: "contended" });
  assert.equal(callbackCalled, false);
  assert.equal(releaseCalled, false);
});

test("the module reports a release anomaly itself", async (t) => {
  const said: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { said.push(args.map(String).join(" ")); });

  await withMergeLease("chain-5", async () => ({ disposition: "release", value: null }), {
    acquire: acquired,
    release: async () => ({ outcome: "skipped", heldFor: "chain-42" }),
  });

  assert.equal(said.length, 1);
  assert.match(said[0]!, /chain-5/u);
  assert.match(said[0]!, /chain-42/u);
});

test("a rejected release adapter is reported as unreachable", async (t) => {
  const said: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { said.push(args.map(String).join(" ")); });
  const releaser: MergeLeaseReleaser = async () => { throw new Error("spawn bash ENOENT"); };

  await withMergeLease("chain-6", async () => ({ disposition: "release", value: null }), {
    acquire: acquired,
    release: releaser,
  });

  assert.equal(said.length, 1);
  assert.match(said[0]!, /chain-6/u);
  assert.match(said[0]!, /spawn bash ENOENT/u);
});

test("a Task without a Chain runs without either Lease adapter", async () => {
  const result = await withMergeLease(null, async () => ({ disposition: "release", value: "unleased" }), {
    acquire: async () => { throw new Error("the acquirer must not be called"); },
    release: async () => { throw new Error("the releaser must not be called"); },
  });

  assert.deepEqual(result, { outcome: "ran", value: "unleased" });
});
