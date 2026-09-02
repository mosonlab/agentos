import assert from "node:assert/strict";
import test from "node:test";

import { Prisma } from "@prisma/client";

import type { JsonSerialized, SerializesTo } from "./wire-serialization.js";

/** A contract written the way the shared ones are: wire forms by default, and
 *  the native forms supplied by the projecting route. */
type Report<DateTime = string, DecimalValue = string> = {
  id: string;
  startedAt: DateTime | null;
  usd: DecimalValue;
  tags: string[];
  nested: { at: DateTime };
};

type NativeReport = Report<Date, Prisma.Decimal>;

const nativeReport = (): NativeReport => ({
  id: "run-1",
  startedAt: new Date(0),
  usd: new Prisma.Decimal("1.25"),
  tags: ["merge"],
  nested: { at: new Date(0) },
});

const wireReport: Report = {
  id: "run-1",
  startedAt: "1970-01-01T00:00:00.000Z",
  usd: "1.25",
  tags: ["merge"],
  nested: { at: "1970-01-01T00:00:00.000Z" },
};

test("the serialized form the proof claims is the one JSON.stringify produces", () => {
  const projection = nativeReport() satisfies SerializesTo<NativeReport, Report>;
  const serialized: JsonSerialized<NativeReport> = JSON.parse(JSON.stringify(projection));
  assert.deepEqual(serialized, wireReport);
});

test("a contract that still declares a Decimal is refused", () => {
  type DecimalContract = Omit<Report, "usd"> & { usd: Prisma.Decimal };
  // @ts-expect-error the projected Decimal reaches the browser as a string, never as a Decimal.
  const projection = nativeReport() satisfies SerializesTo<NativeReport, DecimalContract>;
  assert.equal(projection.usd.toString(), "1.25");
});

test("a nested Date the contract leaves unserialized is refused", () => {
  type NestedDateContract = Omit<Report, "nested"> & { nested: { at: Date } };
  // @ts-expect-error the nested Date reaches the browser as an ISO string.
  const projection = nativeReport() satisfies SerializesTo<NativeReport, NestedDateContract>;
  assert.equal(projection.nested.at.getTime(), 0);
});

test("a key the contract does not name is refused", () => {
  type SurplusReport = NativeReport & { internalRowVersion: number };
  const surplus: SurplusReport = { ...nativeReport(), internalRowVersion: 3 };
  // @ts-expect-error the projection carries a key no browser contract names.
  const projection = surplus satisfies SerializesTo<SurplusReport, Report>;
  assert.equal(projection.internalRowVersion, 3);
});

test("a key the contract names and the projection drops is refused", () => {
  type PartialReport = Omit<NativeReport, "tags">;
  const { tags, ...withoutTags } = nativeReport();
  assert.deepEqual(tags, ["merge"]);
  // @ts-expect-error the contract names `tags` and the projection never emits it.
  const projection = withoutTags satisfies SerializesTo<PartialReport, Report>;
  assert.equal(projection.id, "run-1");
});

test("a key the projection makes optional and the contract requires is refused", () => {
  type OptionalTagsReport = Omit<NativeReport, "tags"> & { tags?: string[] };
  const optional: OptionalTagsReport = nativeReport();
  // @ts-expect-error an absent key is not the same wire shape as a present one,
  // which is why the proof compares type identity and not assignability.
  const projection = optional satisfies SerializesTo<OptionalTagsReport, Report>;
  assert.deepEqual(projection.tags, ["merge"]);
});
