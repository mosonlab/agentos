import assert from "node:assert/strict";
import test from "node:test";

import { storage } from "../lib/storage";

type Operation = "get" | "set" | "remove";

const useLocalStorage = (initial: Record<string, string>, blocked: Operation[]): Map<string, string> => {
  const values = new Map(Object.entries(initial));
  const fail = (operation: Operation): void => {
    if (blocked.includes(operation)) throw new DOMException(`${operation} blocked`, "QuotaExceededError");
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem(key: string): string | null { fail("get"); return values.get(key) ?? null; },
        setItem(key: string, value: string): void { fail("set"); values.set(key, value); },
        removeItem(key: string): void { fail("remove"); values.delete(key); },
      },
    },
  });
  return values;
};

test("all-blocked storage uses memory for set and a tombstone for remove", () => {
  useLocalStorage({}, ["get", "set", "remove"]);
  storage.set("all-blocked", "light");
  assert.equal(storage.get("all-blocked"), "light");
  storage.remove("all-blocked");
  assert.equal(storage.get("all-blocked"), null);
});

test("write-blocked storage reads the session value instead of stale persistence", () => {
  useLocalStorage({ "write-blocked": "dark" }, ["set"]);
  storage.set("write-blocked", "light");
  assert.equal(storage.get("write-blocked"), "light");
});

test("remove-blocked storage preserves an in-memory tombstone", () => {
  useLocalStorage({ "remove-blocked": "light" }, ["remove"]);
  storage.remove("remove-blocked");
  assert.equal(storage.get("remove-blocked"), null);
});

test("a failure for one key does not disable cross-tab reads for other keys", () => {
  const values = useLocalStorage({ healthy: "light" }, ["set"]);
  storage.set("degraded-only", "memory");
  values.set("healthy", "dark");
  assert.equal(storage.get("healthy"), "dark");
});
