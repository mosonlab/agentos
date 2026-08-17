import assert from "node:assert/strict";
import test from "node:test";

import {
  Prisma, deriveUsageColumns, extractUsage, recomputeSessionUsage, sessionUsageLockKey, sumUsage,
  type PrismaClient, type SessionUsage,
} from "@agentos/db";

// Fixtures are the COMPLETE `result` objects pasted from
// spikes/cli-capabilities/samples/, nothing trimmed — regenerate with:
//
//   node -e 'const fs=require("node:fs");for(const f of ["claude-tool-event","claude-start-safe-mode"]){
//     const o=fs.readFileSync(`spikes/cli-capabilities/samples/${f}.stdout`,"utf8")
//       .split("\n").filter(Boolean).map(JSON.parse).find(x=>x.type==="result");
//     console.log(JSON.stringify(o,null,2));}'
//
// Completeness is the point, not tidiness. The previous fixture kept only the
// top-level `usage` block, which made these tests certify the very bug batch 4
// FIXES exists to fix: it has no `modelUsage`, so it could not show that the
// top-level object describes one model out of two. The captures are evidence —
// if an assertion disagrees with one, the code is wrong, never the capture.
const CLAUDE_RESULT = {
  "is_error": false,
  "duration_api_ms": 8945,
  "num_turns": 2,
  "stop_reason": "end_turn",
  "session_id": "12a8ac5d-9577-4c38-a5a3-c4b766398e19",
  "total_cost_usd": 0.049117,
  "usage": {
    "input_tokens": 4,
    "cache_creation_input_tokens": 4436,
    "cache_read_input_tokens": 4332,
    "output_tokens": 77,
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "service_tier": "standard",
    "cache_creation": { "ephemeral_1h_input_tokens": 4436, "ephemeral_5m_input_tokens": 0 },
    "inference_geo": "not_available",
    "iterations": [
      {
        "input_tokens": 2,
        "output_tokens": 3,
        "cache_read_input_tokens": 4332,
        "cache_creation_input_tokens": 104,
        "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 104 },
        "type": "message",
      },
    ],
    "speed": "standard",
  },
  "modelUsage": {
    "claude-haiku-4-5-20251001": {
      "inputTokens": 541,
      "outputTokens": 21,
      "cacheReadInputTokens": 0,
      "cacheCreationInputTokens": 0,
      "webSearchRequests": 0,
      "costUSD": 0.000646,
      "contextWindow": 200000,
      "maxOutputTokens": 32000,
      "canonicalModel": "claude-haiku-4-5",
      "provider": "firstParty",
    },
    "claude-opus-5": {
      "inputTokens": 4,
      "outputTokens": 77,
      "cacheReadInputTokens": 4332,
      "cacheCreationInputTokens": 4436,
      "webSearchRequests": 0,
      "costUSD": 0.048471,
      "contextWindow": 1000000,
      "maxOutputTokens": 64000,
      "canonicalModel": "claude-opus-5",
      "provider": "firstParty",
    },
  },
  "permission_denials": [],
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "fast_mode_disabled_reason": "sdk_opt_in_required",
  "subtype": "success",
  "api_error_status": null,
  "result": "3",
  "ttft_ms": 3900,
  "ttft_stream_ms": 3007,
  "time_to_request_ms": 45,
  "type": "result",
  "duration_ms": 6034,
  "uuid": "eb7bc883-dc0d-461e-b866-99857085d837",
};

/** The second capture, `claude-start-safe-mode.stdout`. A different session with
 *  the same two models, so the extractor is checked against more than one shape
 *  of the same phenomenon. */
const CLAUDE_RESULT_SAFE_MODE = {
  "is_error": false,
  "duration_api_ms": 6948,
  "num_turns": 1,
  "stop_reason": "end_turn",
  "session_id": "cca5c95f-42dd-4752-bc30-ac78af163ef2",
  "total_cost_usd": 0.030392999999999996,
  "usage": {
    "input_tokens": 2,
    "cache_creation_input_tokens": 2969,
    "cache_read_input_tokens": 0,
    "output_tokens": 3,
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "service_tier": "standard",
    "cache_creation": { "ephemeral_1h_input_tokens": 2969, "ephemeral_5m_input_tokens": 0 },
    "inference_geo": "not_available",
    "iterations": [
      {
        "input_tokens": 2,
        "output_tokens": 3,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 2969,
        "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 2969 },
        "type": "message",
      },
    ],
    "speed": "standard",
  },
  "modelUsage": {
    "claude-haiku-4-5-20251001": {
      "inputTokens": 533,
      "outputTokens": 17,
      "cacheReadInputTokens": 0,
      "cacheCreationInputTokens": 0,
      "webSearchRequests": 0,
      "costUSD": 0.0006180000000000001,
      "contextWindow": 200000,
      "maxOutputTokens": 32000,
      "canonicalModel": "claude-haiku-4-5",
      "provider": "firstParty",
    },
    "claude-opus-5": {
      "inputTokens": 2,
      "outputTokens": 3,
      "cacheReadInputTokens": 0,
      "cacheCreationInputTokens": 2969,
      "webSearchRequests": 0,
      "costUSD": 0.029774999999999996,
      "contextWindow": 1000000,
      "maxOutputTokens": 64000,
      "canonicalModel": "claude-opus-5",
      "provider": "firstParty",
    },
  },
  "permission_denials": [],
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "fast_mode_disabled_reason": "sdk_opt_in_required",
  "subtype": "success",
  "api_error_status": null,
  "result": "2",
  "ttft_ms": 4016,
  "ttft_stream_ms": 3465,
  "time_to_request_ms": 23,
  "type": "result",
  "duration_ms": 4114,
  "uuid": "75cac3cf-3b6d-40ae-9c48-fa5fdf83fc42",
};

/** Runs `operation` with `console.warn` captured, so a test can assert that a
 *  rejected value announced itself rather than vanishing silently. */
const withCapturedWarnings = async <T>(operation: () => T | Promise<T>): Promise<{ result: T; warnings: string[] }> => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    return { result: await operation(), warnings };
  } finally {
    console.warn = original;
  }
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
    // `recomputeSessionUsage` runs inside one interactive transaction that takes
    // an advisory lock. The stub runs the callback against itself and answers
    // the two raw statements inertly: a unit test proves the derivation, and
    // `usage.dbtest.ts` proves the lock against a real PostgreSQL.
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(database),
    $executeRawUnsafe: async () => 0,
    $queryRaw: async () => [],
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

test("extractUsage reads the real CLAUDE result payload across every model it used", () => {
  // 545 = 541 (haiku) + 4 (opus); 98 = 21 + 77. The top-level `usage` block
  // reports only opus's 4 / 77, which is the under-count this batch fixes.
  assert.deepEqual(extractUsage(CLAUDE_RESULT), {
    inputTokens: 545,
    outputTokens: 98,
    cachedInputTokens: 8768,
    costUsd: 0.049117,
  });
});

test("extractUsage reads the second real CLAUDE capture the same way", () => {
  assert.deepEqual(extractUsage(CLAUDE_RESULT_SAFE_MODE), {
    inputTokens: 535,
    outputTokens: 20,
    cachedInputTokens: 2969,
    costUsd: 0.030392999999999996,
  });
});

test("the modelUsage branch is exclusive: the primary model is never counted twice", () => {
  // The top-level `usage` object equals the primary model's entry in both real
  // captures, so ADDING the two sources double-counts it. Reading only the
  // top-level one drops every secondary model. Exactly one source, and it is
  // `modelUsage` whenever `modelUsage` carries anything usable.
  assert.deepEqual(
    extractUsage({ usage: { input_tokens: 100, output_tokens: 200 }, modelUsage: { m: { inputTokens: 5, outputTokens: 7 } } }),
    { inputTokens: 5, outputTokens: 7 },
  );
});

test("an unusable modelUsage falls back to the top-level usage block", () => {
  assert.deepEqual(extractUsage({ usage: { input_tokens: 4 }, modelUsage: { m: {} } }), { inputTokens: 4 });
  assert.deepEqual(extractUsage({ usage: { input_tokens: 4 }, modelUsage: {} }), { inputTokens: 4 });
  assert.deepEqual(extractUsage({ usage: { input_tokens: 4 }, modelUsage: "nope" }), { inputTokens: 4 });
});

test("one malformed modelUsage entry does not discard the others", () => {
  assert.deepEqual(extractUsage({ modelUsage: { a: 7, b: { inputTokens: 5 } } }), { inputTokens: 5 });
});

test("absence survives the modelUsage branch: a missing field is absent, not zero", () => {
  const usage = extractUsage({ modelUsage: { a: { inputTokens: 5 } } });
  assert.deepEqual(usage, { inputTokens: 5 });
  assert.equal("outputTokens" in usage, false);
  assert.equal("cachedInputTokens" in usage, false);
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
  assert.equal(columns.inputTokens, 545);
  assert.equal(columns.outputTokens, 98);
  assert.equal(columns.cachedInputTokens, 8768);
  assert.equal(columns.totalTokens, 643);
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
  const database: PrismaClient = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(database),
    $executeRawUnsafe: async () => 0,
    $queryRaw: async () => [],
    sessionEvent: { findMany: async () => [{ payload: CLAUDE_RESULT }] },
    session: { findUnique: async () => null, update: async () => assert.fail("must not write") },
  } as unknown as PrismaClient;
  assert.equal(await recomputeSessionUsage(database, "missing"), false);
});

/* ------------------------------------- SF-1: values PostgreSQL cannot store */

test("a token value the INTEGER column cannot hold is dropped, diagnosed, and does not take its siblings with it", async () => {
  // Each of these used to reach the column: `finite` only asked whether the
  // number was finite, so -7, 1.5 and 2^31 all arrived at an INTEGER column and
  // failed the whole write — which the ingest then swallowed, leaving the
  // session with no usage at all.
  for (const rejected of [-7, 1.5, 2_147_483_648, NaN, Infinity, "5", null, true]) {
    const { result: usage, warnings } = await withCapturedWarnings(
      () => extractUsage({ usage: { input_tokens: rejected, output_tokens: 12 } }),
    );
    const label = JSON.stringify(rejected ?? null);
    assert.equal("inputTokens" in usage, false, `inputTokens must be absent for ${label}`);
    assert.equal(usage.outputTokens, 12, `a valid sibling must survive ${label}`);
    assert.equal(warnings.length, 1, `exactly one diagnostic for ${label}`);
    assert.match(warnings[0] ?? "", /usage\.input_tokens/);
  }
});

test("a missing token field is silent while an explicitly invalid one is diagnosed", async () => {
  // Absent is normal — it means "this payload said nothing about it". Without
  // that split every PI event would log four lines per recompute.
  const absent = await withCapturedWarnings(() => extractUsage({ usage: { input_tokens: 4 } }));
  assert.deepEqual(absent.warnings, []);
  const present = await withCapturedWarnings(() => extractUsage({ usage: { input_tokens: 4, output_tokens: null } }));
  assert.equal(present.warnings.length, 1);
});

test("a sum that leaves INTEGER range stores null for that column only", async () => {
  const events = [{ usage: { input_tokens: 2_000_000_000 } }, { usage: { input_tokens: 2_000_000_000, output_tokens: 9 } }];
  const { result: derived } = await withCapturedWarnings(
    () => deriveUsageColumns(sumUsage(events.map(extractUsage))),
  );
  assert.equal(derived.inputTokens, null);
  assert.equal(derived.totalTokens, null);
  // The overflow is contained: outputTokens is in range and keeps its value.
  assert.equal(derived.outputTokens, 9);
});

test("the summed-overflow session still writes rather than throwing", async () => {
  const columns = emptyColumns();
  const { database } = stubDatabase([{ usage: { input_tokens: 2_000_000_000 } }, { usage: { input_tokens: 2_000_000_000 } }], columns);
  const { result: wrote } = await withCapturedWarnings(() => recomputeSessionUsage(database, "session-1"));
  assert.equal(wrote, false);   // every column derives to null, which is what the row already holds
  assert.equal(columns.inputTokens, null);
});

test("a cost the Decimal(12, 4) column cannot hold is dropped", async () => {
  for (const rejected of [-1, 1e9, 99999999.99999]) {
    // 99999999.99999 is BELOW 10^8 and still fails the write: it rounds to
    // 100000000.0000. The guard has to judge the rounded value, not the raw one.
    const { result: usage } = await withCapturedWarnings(() => extractUsage({ total_cost_usd: rejected }));
    assert.equal("costUsd" in usage, false, `costUsd must be absent for ${rejected}`);
    const { result: derived } = await withCapturedWarnings(() => deriveUsageColumns(sumUsage([usage])));
    assert.equal(derived.costUsd, null);
  }
});

test("cost rejection is per event, so one absurd event cannot erase a valid one", async () => {
  // With the check only after summation, 1e9 + 0.05 leaves the range as a single
  // number and the session loses a cost it legitimately had.
  const events = [{ total_cost_usd: 1e9 }, { total_cost_usd: 0.05 }];
  const { result: derived } = await withCapturedWarnings(
    () => deriveUsageColumns(sumUsage(events.map(extractUsage))),
  );
  // Compared by value, not by rendering: Decimal#toString drops trailing zeroes,
  // so the stored 0.0500 prints as "0.05". The column's scale is 4 either way.
  assert.notEqual(derived.costUsd, null);
  assert.equal(derived.costUsd?.toNumber(), 0.05);
});

test("an aggregate cost overflow across individually storable events is still caught", async () => {
  // 6e7 is storable; 6e7 + 6e7 is not. This is the case the per-event check
  // cannot see, and it is why both guards exist.
  const events = [{ total_cost_usd: 6e7 }, { total_cost_usd: 6e7 }];
  const { result: derived } = await withCapturedWarnings(
    () => deriveUsageColumns(sumUsage(events.map(extractUsage))),
  );
  assert.equal(derived.costUsd, null);
});

/* ------------------------------------------- MF-1: the advisory lock's key */

test("sessionUsageLockKey is deterministic, spread, and inside int4", () => {
  const ids = ["cmswjrnf40t4mmpyjn9u931bk", "cmswjrn9c0t44mpyjs2n4khwn", "cmswjrnbw0t4ampyj86lr3ymb", "ses-1", ""];
  for (const id of ids) {
    const key = sessionUsageLockKey(id);
    assert.equal(key, sessionUsageLockKey(id), `${id} must hash the same way twice`);
    assert.equal(Number.isInteger(key), true);
    assert.ok(key >= -2_147_483_648 && key <= 2_147_483_647, `${id} hashed outside int4: ${key}`);
  }
  // Not a collision-resistance claim — just that the hash is not constant, which
  // would serialise every session in the system against every other.
  assert.equal(new Set(ids.map(sessionUsageLockKey)).size, ids.length);
});
