import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, extractUsage, recomputeSessionUsage, sumUsage, type PrismaClient, type SessionUsage } from "@agentos/db";

// Fixtures are pasted from spikes/cli-capabilities/samples/, so these assertions
// hold against payloads the CLIs actually emitted rather than inferred shapes.
const CLAUDE_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.049117,
  usage: {
    input_tokens: 4,
    cache_creation_input_tokens: 4436,
    cache_read_input_tokens: 4332,
    output_tokens: 77,
    service_tier: "standard",
  },
};

const CODEX_TURN_COMPLETED = {
  type: "turn.completed",
  usage: { input_tokens: 40764, cached_input_tokens: 35072, cache_write_input_tokens: 0, output_tokens: 253, reasoning_output_tokens: 77 },
};

const PI_AGENT_SETTLED = { type: "agent_settled" };

type SessionColumns = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  costUsd: Prisma.Decimal | null;
};

const emptyColumns = (): SessionColumns =>
  ({ inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, costUsd: null });

/** A Prisma stub holding one session's columns in memory, so a second
 * recompute observes what the first one wrote. */
const stubDatabase = (payloads: unknown[], columns: SessionColumns) => {
  const updates: SessionColumns[] = [];
  const database = {
    sessionEvent: { findMany: async () => payloads.map((payload) => ({ payload })) },
    session: {
      findUnique: async () => columns,
      update: async ({ data }: { data: SessionColumns }) => {
        Object.assign(columns, data);
        updates.push(data);
        return data;
      },
    },
  } as unknown as PrismaClient;
  return { database, updates };
};

test("extractUsage reads the real CLAUDE result payload", () => {
  assert.deepEqual(extractUsage(CLAUDE_RESULT), {
    inputTokens: 4,
    outputTokens: 77,
    cachedInputTokens: 8768,
    costUsd: 0.049117,
  });
});

test("extractUsage reads the real CODEX turn.completed payload and finds no cost", () => {
  const usage: SessionUsage = extractUsage(CODEX_TURN_COMPLETED);
  // CODEX reports no cost, and reasoning_output_tokens is deliberately excluded
  // from outputTokens.
  assert.equal(usage.costUsd, undefined);
  assert.equal(usage.outputTokens, 253);
  assert.deepEqual(usage, { inputTokens: 40764, outputTokens: 253, cachedInputTokens: 35072 });
});

test("extractUsage finds nothing in PI's empty terminal event", () => {
  assert.deepEqual(extractUsage(PI_AGENT_SETTLED), {});
});

test("extractUsage is total over unknown input", () => {
  for (const payload of [null, undefined, 42, "x", [], {}, { usage: null }, { usage: 42 }, { usage: { input_tokens: "nope" } }, { total_cost_usd: "free" }]) {
    assert.deepEqual(extractUsage(payload), {}, JSON.stringify(payload ?? null));
  }
});

test("extractUsage keeps partial usage partial", () => {
  assert.deepEqual(extractUsage({ usage: { output_tokens: 5 } }), { outputTokens: 5 });
  assert.deepEqual(extractUsage({ total_cost_usd: 1.5 }), { costUsd: 1.5 });
});

test("sumUsage never turns an absent field into zero", () => {
  assert.deepEqual(sumUsage([{ inputTokens: 1 }, { outputTokens: 2 }]), { inputTokens: 1, outputTokens: 2 });
  assert.deepEqual(sumUsage([{ costUsd: 1 }, { costUsd: 2 }]), { costUsd: 3 });
  assert.deepEqual(sumUsage([]), {});
});

test("recomputeSessionUsage writes absolute values once and is a no-op on replay", async () => {
  const columns = emptyColumns();
  const { database, updates } = stubDatabase([CLAUDE_RESULT], columns);

  assert.equal(await recomputeSessionUsage(database, "session-1"), true);
  assert.equal(updates.length, 1);
  assert.equal(columns.inputTokens, 4);
  assert.equal(columns.outputTokens, 77);
  assert.equal(columns.cachedInputTokens, 8768);
  assert.equal(columns.totalTokens, 81);
  assert.equal(columns.costUsd?.toString(), "0.0491");

  // Same events in, same columns out: the second call must not write.
  assert.equal(await recomputeSessionUsage(database, "session-1"), false);
  assert.equal(updates.length, 1);
});

test("recomputeSessionUsage stores a cost-only session without inventing token zeroes", async () => {
  const columns = emptyColumns();
  const { database, updates } = stubDatabase([{ type: "result", total_cost_usd: 0.25 }], columns);

  assert.equal(await recomputeSessionUsage(database, "session-1"), true);
  assert.equal(columns.costUsd?.toString(), "0.25");
  assert.equal(columns.inputTokens, null);
  assert.equal(columns.outputTokens, null);
  assert.equal(columns.cachedInputTokens, null);
  assert.equal(columns.totalTokens, null);

  // The old `totalTokens: null` selector would have re-written this forever.
  assert.equal(await recomputeSessionUsage(database, "session-1"), false);
  assert.equal(updates.length, 1);
});

test("recomputeSessionUsage accumulates across resume attempts", async () => {
  const attemptOne = { type: "result", total_cost_usd: 0.1, usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 100 } };
  const attemptTwo = { type: "result", total_cost_usd: 0.2, usage: { input_tokens: 7, output_tokens: 11, cache_read_input_tokens: 50 } };

  const twoRows = emptyColumns();
  await recomputeSessionUsage(stubDatabase([attemptOne, attemptTwo], twoRows).database, "session-1");

  const oneCombinedRow = emptyColumns();
  await recomputeSessionUsage(
    stubDatabase([{ type: "result", total_cost_usd: 0.3, usage: { input_tokens: 17, output_tokens: 14, cache_read_input_tokens: 150 } }], oneCombinedRow).database,
    "session-1",
  );

  assert.equal(twoRows.inputTokens, 17);
  assert.equal(twoRows.outputTokens, 14);
  assert.equal(twoRows.cachedInputTokens, 150);
  assert.equal(twoRows.totalTokens, 31);
  // Accumulation is a property of the stored rows, not of write ordering.
  assert.equal(twoRows.inputTokens, oneCombinedRow.inputTokens);
  assert.equal(twoRows.outputTokens, oneCombinedRow.outputTokens);
  assert.equal(twoRows.totalTokens, oneCombinedRow.totalTokens);
  assert.equal(twoRows.costUsd?.toString(), oneCombinedRow.costUsd?.toString());
});

test("recomputeSessionUsage repairs a session whose second attempt's write was lost", async () => {
  const attemptOne = { type: "result", usage: { input_tokens: 10, output_tokens: 3 } };
  const attemptTwo = { type: "result", usage: { input_tokens: 7, output_tokens: 11 } };
  // Columns hold attempt 1 only, as if the process died between createMany and
  // the usage write. An additive design could never reach this session again.
  const columns: SessionColumns = { inputTokens: 10, outputTokens: 3, cachedInputTokens: null, totalTokens: 13, costUsd: null };
  const { database } = stubDatabase([attemptOne, attemptTwo], columns);

  assert.equal(await recomputeSessionUsage(database, "session-1"), true);
  assert.equal(columns.inputTokens, 17);
  assert.equal(columns.outputTokens, 14);
  assert.equal(columns.totalTokens, 31);
});

test("recomputeSessionUsage does nothing when the session row is gone", async () => {
  const database = {
    sessionEvent: { findMany: async () => [{ payload: CLAUDE_RESULT }] },
    session: { findUnique: async () => null, update: async () => assert.fail("must not write") },
  } as unknown as PrismaClient;
  assert.equal(await recomputeSessionUsage(database, "missing"), false);
});
