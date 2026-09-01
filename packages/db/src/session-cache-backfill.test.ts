import assert from "node:assert/strict";
import test from "node:test";

import {
  runBackfillSessionCacheUsageCli,
  type SessionCacheBackfillDatabase,
} from "./session-cache-backfill.js";
import { extractCacheSplit, extractUsage } from "./usage.js";

type MemorySession = {
  id: string;
  cacheCreationInputTokens: number | null;
  cachedInputTokens: number | null;
};

const memoryDatabase = (
  sessionRows: MemorySession[],
  payloads: Record<string, unknown[]>,
): SessionCacheBackfillDatabase => ({
  session: {
    findMany: async () => sessionRows.map(({ id, cacheCreationInputTokens }) => ({ id, cacheCreationInputTokens })),
    updateMany: async (args) => {
      const input = args as { where: { id: string; cacheCreationInputTokens: null }; data: { cachedInputTokens: number; cacheCreationInputTokens: number } };
      const row = sessionRows.find((candidate) => candidate.id === input.where.id);
      if (!row || row.cacheCreationInputTokens !== null) return { count: 0 };
      row.cachedInputTokens = input.data.cachedInputTokens;
      row.cacheCreationInputTokens = input.data.cacheCreationInputTokens;
      return { count: 1 };
    },
  },
  sessionEvent: {
    findMany: async (args) => {
      const input = args as { where: { sessionId: string } };
      return (payloads[input.where.sessionId] ?? []).map((payload) => ({ payload }));
    },
  },
});

test("cache split backfill is idempotent and reports stable known/unknown totals", async () => {
  const sessions: MemorySession[] = [
    { id: "known", cacheCreationInputTokens: null, cachedInputTokens: 150 },
    { id: "unknown", cacheCreationInputTokens: null, cachedInputTokens: 7 },
  ];
  const db = memoryDatabase(sessions, {
    known: [{
      type: "result",
      usage: { input_tokens: 160, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
    }],
    unknown: [{ type: "agent_settled" }],
  });

  const firstLines: string[] = [];
  assert.equal(await runBackfillSessionCacheUsageCli({
    db,
    log: (line) => firstLines.push(line),
    error: (line) => firstLines.push(line),
  }), 0);
  assert.deepEqual(sessions, [
    { id: "known", cacheCreationInputTokens: 50, cachedInputTokens: 100 },
    { id: "unknown", cacheCreationInputTokens: null, cachedInputTokens: 7 },
  ]);

  const secondLines: string[] = [];
  assert.equal(await runBackfillSessionCacheUsageCli({
    db,
    log: (line) => secondLines.push(line),
    error: (line) => secondLines.push(line),
  }), 0);
  assert.deepEqual(secondLines, firstLines);
  assert.deepEqual(sessions, [
    { id: "known", cacheCreationInputTokens: 50, cachedInputTokens: 100 },
    { id: "unknown", cacheCreationInputTokens: null, cachedInputTokens: 7 },
  ]);
});

test("a malformed retained payload stops the scan and names its session", async () => {
  const sessions: MemorySession[] = [
    { id: "malformed", cacheCreationInputTokens: null, cachedInputTokens: null },
    { id: "after-malformed", cacheCreationInputTokens: null, cachedInputTokens: null },
  ];
  const lines: string[] = [];
  const errors: string[] = [];
  const exit = await runBackfillSessionCacheUsageCli({
    db: memoryDatabase(sessions, { malformed: [{ type: "result", usage: "not-an-object" }] }),
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
  });

  assert.equal(exit, 1);
  assert.equal(lines[0], "scanned 1, updated 0, failed 1, unknown 0");
  assert.match(errors[0] ?? "", /malformed/u);
  assert.match(errors[0] ?? "", /session malformed/u);
  assert.equal(sessions[0]?.cacheCreationInputTokens, null);
  assert.equal(sessions[1]?.cacheCreationInputTokens, null);
});

test("a provider payload without a complete cache pair remains unknown", async () => {
  const sessions: MemorySession[] = [
    { id: "partial", cacheCreationInputTokens: null, cachedInputTokens: 77 },
  ];
  const lines: string[] = [];
  const exit = await runBackfillSessionCacheUsageCli({
    db: memoryDatabase(sessions, {
      partial: [{
        type: "result",
        modelUsage: { "claude-opus-5": { inputTokens: 160, cacheReadInputTokens: 100 } },
      }],
    }),
    log: (line: string) => lines.push(line),
  });

  assert.equal(exit, 0);
  assert.equal(lines[0], "scanned 1, updated 0, failed 0, unknown 1");
  assert.deepEqual(sessions[0], {
    id: "partial",
    cacheCreationInputTokens: null,
    cachedInputTokens: 77,
  });
});

test("an output-only model sibling does not make a complete modelUsage cache split unknown", async () => {
  const sessions: MemorySession[] = [
    { id: "output-sibling", cacheCreationInputTokens: null, cachedInputTokens: 150 },
  ];
  const exit = await runBackfillSessionCacheUsageCli({
    db: memoryDatabase(sessions, {
      "output-sibling": [{
        type: "result",
        modelUsage: {
          "claude-opus-5": {
            inputTokens: 10,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 50,
          },
          "claude-fable-5": { outputTokens: 7 },
        },
      }],
    }),
  });

  assert.equal(exit, 0);
  assert.deepEqual(sessions[0], {
    id: "output-sibling",
    cacheCreationInputTokens: 50,
    cachedInputTokens: 100,
  });
});

test("the BF-004 modelUsage payload has the same split in ingestion and backfill decoding", () => {
  const payload = {
    type: "result",
    modelUsage: {
      a: { inputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 50 },
      b: { outputTokens: 7 },
    },
  };

  assert.deepEqual(extractUsage(payload), {
    inputTokens: 160,
    outputTokens: 7,
    cachedInputTokens: 100,
    cacheCreationInputTokens: 50,
  });
  assert.deepEqual(extractCacheSplit(payload), {
    kind: "known",
    cachedInputTokens: 100,
    cacheCreationInputTokens: 50,
  });
  assert.deepEqual(extractCacheSplit(payload, { strict: true }), {
    kind: "known",
    cachedInputTokens: 100,
    cacheCreationInputTokens: 50,
  });
});

test("a complete split stays known across output-only and cost-only retained events", async () => {
  const sessions: MemorySession[] = [
    { id: "output-and-cost-only", cacheCreationInputTokens: null, cachedInputTokens: 150 },
  ];
  const exit = await runBackfillSessionCacheUsageCli({
    db: memoryDatabase(sessions, {
      "output-and-cost-only": [
        {
          type: "result",
          modelUsage: {
            a: { inputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 50 },
          },
        },
        { type: "result", usage: { output_tokens: 7 } },
        { type: "result", total_cost_usd: 0.01 },
      ],
    }),
  });

  assert.equal(exit, 0);
  assert.deepEqual(sessions[0], {
    id: "output-and-cost-only",
    cacheCreationInputTokens: 50,
    cachedInputTokens: 100,
  });
});

test("a JSON null input field has the same cache-split classification as absence", () => {
  const payload = {
    type: "result",
    modelUsage: {
      a: { inputTokens: null, cacheReadInputTokens: 100, cacheCreationInputTokens: 50 },
    },
  };

  assert.deepEqual(extractUsage(payload), {
    cachedInputTokens: 100,
    cacheCreationInputTokens: 50,
  });
  assert.deepEqual(extractCacheSplit(payload), {
    kind: "known",
    cachedInputTokens: 100,
    cacheCreationInputTokens: 50,
  });
  assert.deepEqual(extractCacheSplit(payload, { strict: true }), {
    kind: "known",
    cachedInputTokens: 100,
    cacheCreationInputTokens: 50,
  });
});
