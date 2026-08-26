import assert from "node:assert/strict";
import test from "node:test";

import { TaskStatus } from "@prisma/client";

import { templateRolloverBlockerCount } from "./canonical-template-transition.js";

test("a parked legacy chain may roll over with its dormant successors intact", () => {
  assert.equal(templateRolloverBlockerCount([
    { chainId: "chain-1", status: TaskStatus.BACKLOG, activeRunCount: 0 },
    { chainId: "chain-1", status: TaskStatus.TODO, activeRunCount: 0 },
    { chainId: "chain-1", status: TaskStatus.TODO, activeRunCount: 0 },
  ]), 0);
});

test("active Runs and unfinished work without a parking point block rollover", () => {
  assert.equal(templateRolloverBlockerCount([
    { chainId: "parked-active", status: TaskStatus.BACKLOG, activeRunCount: 1 },
    { chainId: "unparked", status: TaskStatus.TODO, activeRunCount: 0 },
    { chainId: null, status: TaskStatus.REVIEW, activeRunCount: 0 },
  ]), 3);
});
