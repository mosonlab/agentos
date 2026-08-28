import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENFORCED_BY, findModel, joinModel, MODELS, runnerForModel, splitModel, TOOL_KEYS, validateModelPair,
} from "@anneal/db/model-routing";

/** The `mechanical/` provider is not a model provider. `merge-integrator` is a
 *  sentinel role whose "model" names a program, and the picker must *not* offer
 *  it — `findModel` returning null is precisely what keeps it unassignable. The
 *  assertion below states that, so the exclusion cannot silently widen. */
const MECHANICAL_PREFIX = "mechanical/";

test("the catalog covers every canonical roster model", () => {
  const roles = fileURLToPath(new URL("../../../../agents/roles/", import.meta.url));
  const ids = readdirSync(roles).filter((name) => name.endsWith(".md")).map((name) => {
    const source = readFileSync(resolve(roles, name), "utf8");
    return splitModel(source.match(/^model:\s*(\S+)/mu)?.[1] ?? "").model;
  });
  for (const id of ids.filter((id) => !id.startsWith(MECHANICAL_PREFIX))) assert.ok(findModel(id), id);
  const mechanical = ids.filter((id) => id.startsWith(MECHANICAL_PREFIX));
  assert.deepEqual(mechanical, ["mechanical/merge-executor-v1"]);
  for (const id of mechanical) assert.equal(findModel(id), null, id);
  assert.equal(findModel("claude-fable-5")?.defaultEffort, "medium");
  assert.equal(findModel("gpt-5.6-luna")?.defaultEffort, "max");
  assert.equal(findModel("openai-codex/gpt-5.6-sol")?.defaultEffort, "high");
  assert.equal(findModel("openai-codex/gpt-5.6-luna")?.defaultEffort, "max");
});

test("catalog ids are unique and every default effort is selectable", () => {
  assert.equal(new Set(MODELS.map((entry) => entry.id)).size, MODELS.length);
  for (const entry of MODELS) {
    assert.ok(entry.efforts.length > 0, entry.id);
    assert.ok(entry.efforts.includes(entry.defaultEffort), entry.id);
  }
});

test("model effort encoding round-trips on the runner's last-colon rule", () => {
  for (const raw of ["claude-fable-5:medium", "claude-opus-5:high", "gpt-5.6-luna:max", "openai-codex/gpt-5.6-luna:xhigh", "claude-opus-5", ":high"]) {
    const parsed = splitModel(raw);
    assert.equal(joinModel(parsed.model, parsed.effort), raw);
  }
  assert.deepEqual(splitModel(":high"), { model: ":high", effort: null });
});

test("pi-hosted entries override the substring heuristic in the catalog", () => {
  assert.equal(runnerForModel("openai-codex/gpt-5.6-sol:high"), "PI");
  assert.equal(runnerForModel("openai-codex/gpt-5.6-luna:xhigh"), "PI");
});

test("tool keys and enforcement cover exactly the three concrete runners", () => {
  assert.deepEqual(TOOL_KEYS, ["BASH", "READ", "WRITE", "EDIT", "GLOB", "GREP", "WEB_FETCH", "WEB_SEARCH"]);
  assert.deepEqual(Object.keys(ENFORCED_BY).sort(), ["CLAUDE", "CODEX", "PI"]);
});

test("validateModelPair names mismatches and permits the Custom escape hatch", () => {
  assert.deepEqual(validateModelPair("gpt-5.6-luna", "CLAUDE"), { kind: "mismatch", model: "gpt-5.6-luna", expected: "CODEX", actual: "CLAUDE" });
  assert.equal(validateModelPair("gpt-5.6-luna", "CODEX"), null);
  assert.equal(validateModelPair("my-own-model", "INHERIT"), null);
  assert.deepEqual(validateModelPair("", "CLAUDE"), { kind: "empty-model" });
  assert.equal(validateModelPair("claude-opus-5:high", "CLAUDE"), null);
});
