import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findModel, INTENTIONALLY_ABSENT, joinModel, MODELS, resolveRunner, runnerForModel, splitModel, validateModelPair,
} from "../lib/models";
import { ENFORCED_BY, TOOL_KEYS } from "../lib/tools";
import type { RunnerKind, RunnerPreference } from "../lib/types";

test("the catalog covers every roster model except named retirements", () => {
  const roles = fileURLToPath(new URL("../../../../agents/roles/", import.meta.url));
  const ids = readdirSync(roles).filter((name) => name.endsWith(".md")).map((name) => {
    const source = readFileSync(resolve(roles, name), "utf8");
    return splitModel(source.match(/^model:\s*(\S+)/mu)?.[1] ?? "").model;
  });
  for (const id of ids) assert.ok(findModel(id) || (INTENTIONALLY_ABSENT as readonly string[]).includes(id), id);
  for (const id of INTENTIONALLY_ABSENT) assert.equal(findModel(id), null);
});

test("catalog ids are unique and every default effort is selectable", () => {
  assert.equal(new Set(MODELS.map((entry) => entry.id)).size, MODELS.length);
  for (const entry of MODELS) {
    assert.ok(entry.efforts.length > 0, entry.id);
    assert.ok(entry.efforts.includes(entry.defaultEffort), entry.id);
  }
});

test("model effort encoding round-trips on the runner's last-colon rule", () => {
  for (const raw of ["claude-opus-5:high", "gpt-5.6-luna:max", "openai-codex/gpt-5.6-luna:xhigh", "claude-opus-5", ":high"]) {
    const parsed = splitModel(raw);
    assert.equal(joinModel(parsed.model, parsed.effort), raw);
  }
  assert.deepEqual(splitModel(":high"), { model: ":high", effort: null });
});

test("the pi-hosted Luna entry overrides the substring heuristic in the catalog", () => {
  assert.equal(runnerForModel("openai-codex/gpt-5.6-luna:xhigh"), "PI");
});

test("tool keys and enforcement cover exactly the three concrete runners", () => {
  assert.deepEqual(TOOL_KEYS, ["BASH", "READ", "WRITE", "EDIT", "GLOB", "GREP", "WEB_FETCH", "WEB_SEARCH"]);
  assert.deepEqual(Object.keys(ENFORCED_BY).sort(), ["CLAUDE", "CODEX", "PI"]);
});

test("resolveRunner stays byte-faithful to the runtime heuristic", () => {
  const cases: Array<[RunnerPreference, string, RunnerKind]> = [
    ["CLAUDE", "gpt-5.6-luna", "CLAUDE"],
    ["INHERIT", "gpt-5.6-luna", "CLAUDE"],
    ["INHERIT", "openai-codex/gpt-5.6-luna", "CODEX"],
    ["AUTO", "some-pi-model", "PI"],
    ["AUTO", "deepseek-v3", "PI"],
    ["AUTO", "anything-else", "CLAUDE"],
    ["PI", "openai-codex/gpt-5.6-luna", "PI"],
  ];
  for (const [preference, model, expected] of cases) {
    const actual = resolveRunner(preference, model);
    assert.equal(actual, expected);
    assert.ok(Object.hasOwn(ENFORCED_BY, actual));
  }
});

test("validateModelPair names mismatches and permits the Custom escape hatch", () => {
  assert.deepEqual(validateModelPair("gpt-5.6-luna", "CLAUDE"), { kind: "mismatch", model: "gpt-5.6-luna", expected: "CODEX", actual: "CLAUDE" });
  assert.equal(validateModelPair("gpt-5.6-luna", "CODEX"), null);
  assert.equal(validateModelPair("my-own-model", "INHERIT"), null);
  assert.deepEqual(validateModelPair("", "CLAUDE"), { kind: "empty-model" });
  assert.equal(validateModelPair("claude-opus-5:high", "CLAUDE"), null);
});
