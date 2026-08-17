import assert from "node:assert/strict";
import test from "node:test";

import { chainMarker } from "../lib/chain";

test("the chain marker reads done/total, step, status", () => {
  assert.equal(
    chainMarker({ done: 4, total: 9, activeStepName: "Implementation", activeStatus: "doing" }),
    "4/9 · Implementation · doing",
  );
});

test("a task outside any chain has no marker at all", () => {
  assert.equal(chainMarker(null), null);
  assert.equal(chainMarker(undefined), null);
});

test("a finished chain still reads as n/n rather than collapsing", () => {
  assert.equal(
    chainMarker({ done: 3, total: 3, activeStepName: "Review", activeStatus: "done" }),
    "3/3 · Review · done",
  );
});
