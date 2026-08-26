import assert from "node:assert/strict";
import test from "node:test";

import {
  releaseMergeLeaseSafely,
  reportMergeLeaseAnomaly,
  type MergeLeaseRelease,
  type MergeLeaseReleaser,
} from "./merge-lease.js";

const errorsFrom = (t: test.TestContext, body: () => void): string[] => {
  const said: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { said.push(args.map(String).join(" ")); });
  body();
  return said;
};

const releaserSaying = (release: MergeLeaseRelease): MergeLeaseReleaser => async () => release;

test("a release that freed the lease is not reported as an anomaly", (t) => {
  const said = errorsFrom(t, () => {
    reportMergeLeaseAnomaly("chain-1", { outcome: "released", ref: "refs/merge-lease/holder", sha: "abc" });
    reportMergeLeaseAnomaly("chain-1", { outcome: "not-held" });
  });
  assert.deepEqual(said, []);
});

// The defect: the script exits 0, the lease is still standing for somebody
// else's task, and the merge tail used to carry on as though it had freed it.
test("a skipped release is reported as an anomaly naming the task the lease is held for", async (t) => {
  const release = await releaseMergeLeaseSafely(
    releaserSaying({ outcome: "skipped", heldFor: "chain-42" }),
    "chain-43",
  );
  assert.deepEqual(release, { outcome: "skipped", heldFor: "chain-42" });
  const said = errorsFrom(t, () => { reportMergeLeaseAnomaly("chain-43", release); });
  assert.equal(said.length, 1);
  assert.match(said[0]!, /chain-43/u);
  assert.match(said[0]!, /chain-42/u);
});

test("a refused release is reported as an anomaly naming the holder", (t) => {
  const said = errorsFrom(t, () => {
    reportMergeLeaseAnomaly("chain-43", { outcome: "refused", heldBy: "other@host" });
  });
  assert.equal(said.length, 1);
  assert.match(said[0]!, /other@host/u);
});

test("a release that never reached the script becomes unreachable rather than silence", async (t) => {
  const said: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { said.push(args.map(String).join(" ")); });
  const release = await releaseMergeLeaseSafely(
    () => Promise.reject(new Error("spawn bash ENOENT")),
    "chain-44",
  );
  assert.deepEqual(release, { outcome: "unreachable", detail: "spawn bash ENOENT" });
  reportMergeLeaseAnomaly("chain-44", release);
  // The catch still logs, as it always did; what is new is that the caller is
  // told, rather than the log being the only record.
  assert.equal(said.length, 2);
  assert.match(said[1]!, /spawn bash ENOENT/u);
});

test("no chain is no release and no anomaly", async (t) => {
  const release = await releaseMergeLeaseSafely(
    () => { throw new Error("the releaser must not be called"); },
    null,
  );
  assert.equal(release, null);
  assert.deepEqual(errorsFrom(t, () => { reportMergeLeaseAnomaly(null, release); }), []);
});
