import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, api } from "../lib/api";

type Call = { url: string; init: RequestInit };

/** Runs `work` against a scripted fetch and hands back what the client sent. */
const withFetch = async (
  responses: Array<{ status: number; body?: string; etag?: string | null }>,
  work: () => Promise<void>,
): Promise<Call[]> => {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  let index = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const scripted = responses[index++] ?? { status: 500 };
      const headers = new Headers();
      if (scripted.etag !== null && scripted.etag !== undefined) headers.set("ETag", scripted.etag);
      return new Response(scripted.status === 304 || scripted.status === 204 ? null : (scripted.body ?? ""), {
        status: scripted.status,
        headers,
      });
    },
  });
  try {
    await work();
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: original });
  }
  return calls;
};

const sentTag = (call: Call): string | null =>
  new Headers(call.init.headers as HeadersInit | undefined).get("If-None-Match");

test("the first poll sends no validator and keeps the one it is given", async () => {
  let polled: Awaited<ReturnType<typeof api.poll>> | null = null;
  const calls = await withFetch([{ status: 200, body: "[1]", etag: 'W/"a"' }], async () => {
    polled = await api.poll("/tasks?view=board", null);
  });
  assert.equal(sentTag(calls[0]!), null);
  assert.deepEqual(polled, { changed: true, body: "[1]", etag: 'W/"a"' });
});

test("an unchanged poll costs a header exchange, not a payload", async () => {
  // The regression this exists for: 1.58 MB of identical board JSON, 24 times a
  // minute. A 304 carries no body at all, so there is nothing to parse, nothing
  // to compare and nothing to re-render.
  let polled: Awaited<ReturnType<typeof api.poll>> | null = null;
  const calls = await withFetch([{ status: 304, etag: 'W/"a"' }], async () => {
    polled = await api.poll("/tasks?view=board", 'W/"a"');
  });
  assert.equal(sentTag(calls[0]!), 'W/"a"');
  assert.deepEqual(polled, { changed: false, body: "", etag: 'W/"a"' });
});

test("a 304 without a repeated ETag keeps the validator the caller already held", async () => {
  // RFC 9110 lets a 304 omit the tag. Dropping it would send the next poll out
  // unconditional and pull the whole payload back for nothing.
  await withFetch([{ status: 304, etag: null }], async () => {
    assert.deepEqual(await api.poll("/tasks", 'W/"a"'), { changed: false, body: "", etag: 'W/"a"' });
  });
});

test("a control plane that mints no validator still polls, just without the saving", async () => {
  // The board must not break against an older control plane; it only loses the
  // 304. `usePoll`'s body comparison is what still saves the parse there.
  await withFetch([{ status: 200, body: "[1]", etag: null }], async () => {
    assert.deepEqual(await api.poll("/tasks", null), { changed: true, body: "[1]", etag: null });
  });
});

test("the browser cache is bypassed, so a replayed 200 cannot pose as a fresh one", async () => {
  const calls = await withFetch([{ status: 200, body: "[]", etag: 'W/"a"' }], async () => {
    await api.poll("/tasks", null);
  });
  assert.equal(calls[0]!.init.cache, "no-store");
});

test("a failed poll raises ApiError rather than a silent empty board", async () => {
  await withFetch([{ status: 503, body: '{"error":"down"}' }], async () => {
    await assert.rejects(() => api.poll("/tasks", 'W/"a"'), (reason: unknown) => {
      assert.ok(reason instanceof ApiError);
      assert.equal(reason.status, 503);
      assert.equal(reason.message, "down");
      return true;
    });
  });
});

test("a 204 is a change to nothing, not an unchanged poll", async () => {
  await withFetch([{ status: 204, etag: 'W/"e"' }], async () => {
    assert.deepEqual(await api.poll("/tasks", null), { changed: true, body: "", etag: 'W/"e"' });
  });
});
