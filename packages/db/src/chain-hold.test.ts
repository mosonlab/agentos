import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ChainControlState, Prisma } from "@prisma/client";

import {
  type ChainHoldControl,
  type ChainHoldSubject,
  heldPredicate,
  heldSql,
  heldWhere,
} from "./chain-hold.js";

const control = (overrides: Partial<ChainHoldControl> = {}): ChainHoldControl => ({
  projectId: "project-1",
  chainId: "chain-1",
  state: ChainControlState.HELD,
  heldLayer: 2,
  heldExecutionLayer: 2,
  ...overrides,
});

const subject = (overrides: Partial<ChainHoldSubject> = {}): ChainHoldSubject => ({
  projectId: "project-1",
  chainId: "chain-1",
  layer: 3,
  index: 3,
  ...overrides,
});

test("the package publishes the Chain hold decider as an isolated subpath", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    exports: Record<string, unknown>;
  };
  assert.deepEqual(packageJson.exports["./chain-hold"], {
    types: "./src/chain-hold.ts",
    development: "./src/chain-hold.ts",
    import: "./dist/chain-hold.js",
  });
});

test("heldPredicate uses stored layer, legacy index, and fail-closed missing metadata", () => {
  const fixtures: Array<{ name: string; subject: ChainHoldSubject; expected: boolean }> = [
    { name: "above", subject: subject({ layer: 3, index: 0 }), expected: true },
    { name: "at", subject: subject({ layer: 2, index: 99 }), expected: false },
    { name: "below", subject: subject({ layer: 1, index: 99 }), expected: false },
    { name: "legacy above", subject: subject({ layer: null, index: 3 }), expected: true },
    { name: "legacy below", subject: subject({ layer: null, index: 1 }), expected: false },
    { name: "missing", subject: subject({ layer: null, index: null }), expected: true },
  ];
  for (const fixture of fixtures) {
    assert.equal(heldPredicate(fixture.subject, control()), fixture.expected, fixture.name);
  }
  assert.equal(heldPredicate(subject(), control({ heldLayer: null })), true);
});

test("heldPredicate treats absent, released, chainless, and foreign controls as unheld", () => {
  assert.equal(heldPredicate(subject(), null), false);
  assert.equal(heldPredicate(subject(), control({ state: ChainControlState.RELEASED })), false);
  assert.equal(heldPredicate(subject({ chainId: null }), control()), false);
  assert.equal(heldPredicate(subject({ projectId: "project-2" }), control()), false);
  assert.equal(heldPredicate(subject({ chainId: "chain-2" }), control()), false);
});

test("the before-first sentinel blocks stored layer zero without colliding with an admitted zero layer", () => {
  assert.equal(heldPredicate(
    subject({ layer: 0, index: 0 }),
    control({ heldLayer: 0, heldExecutionLayer: null }),
  ), true, "before-first blocks the lowest supported stored layer");
  assert.equal(heldPredicate(
    subject({ layer: 0, index: 0 }),
    control({ heldLayer: 1, heldExecutionLayer: 0 }),
  ), false, "an admitted stored layer zero remains allowed");
  assert.equal(heldPredicate(
    subject({ layer: 1, index: 1 }),
    control({ heldLayer: 1, heldExecutionLayer: 0 }),
  ), true, "the next stored layer remains held");
});

test("heldWhere encodes the same authoritative layer fallback and missing-layer refusal", () => {
  assert.deepEqual(heldWhere(control()), {
    projectId: "project-1",
    chainId: "chain-1",
    OR: [
      { chainLayer: { gt: 2 } },
      {
        chainLayer: null,
        OR: [
          { chainIndex: { gt: 2 } },
          { chainIndex: null },
        ],
      },
    ],
  });
  assert.deepEqual(heldWhere(control({ heldLayer: null })), {
    projectId: "project-1",
    chainId: "chain-1",
  });
  assert.equal(heldWhere(control({ state: ChainControlState.RELEASED })), null);
});

test("heldSql owns identity, state, effective layer, and fail-closed null SQL", () => {
  const statement = heldSql(Prisma.sql`task`, Prisma.sql`chain_control`);
  const sql = statement.text.replace(/\s+/gu, " ").trim();
  assert.equal(statement.values.length, 1);
  assert.equal(statement.values[0], ChainControlState.HELD);
  assert.match(sql, /chain_control\."projectId" = task\."projectId"/u);
  assert.match(sql, /chain_control\."chainId" = task\."chainId"/u);
  assert.match(sql, /chain_control\."state" = lower\(\$1\)::"ChainControlState"/u);
  assert.match(sql, /COALESCE\(task\."chainLayer", task\."chainIndex"\) IS NULL/u);
  assert.match(sql, /heldLayer" = 0 AND chain_control\."heldExecutionLayer" IS NULL/u);
  assert.match(sql, /COALESCE\(task\."chainLayer", task\."chainIndex"\) > COALESCE\(chain_control\."heldExecutionLayer", chain_control\."heldLayer"\)/u);
});
