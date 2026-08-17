import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RunnerPreference } from "@prisma/client";

import {
  assertCanonicalAgentSources,
  CANONICAL_AGENT_DEFAULTS,
  CANONICAL_TEMPLATE_STEPS,
} from "./agent-contract.js";

const rolesRoot = fileURLToPath(new URL("../../../agents/roles/", import.meta.url));

const frontmatterValue = (source: string, key: string): string => {
  const match = source.match(new RegExp(`^${key}:\\s*(.+)$`, "mu"));
  assert.ok(match, `role source must declare ${key}`);
  return match[1].trim();
};

test("canonical role frontmatter matches the Prisma seed contract", async () => {
  const files = (await readdir(rolesRoot)).filter((file) => file.endsWith(".md")).sort();
  const roles = await Promise.all(files.map(async (file) => {
    const source = await readFile(`${rolesRoot}${file}`, "utf8");
    const runner = frontmatterValue(source, "runner").toUpperCase();
    assert.ok(runner in RunnerPreference, `${file} must declare a supported runner`);
    return {
      name: frontmatterValue(source, "name"),
      model: frontmatterValue(source, "model"),
      runnerPreference: RunnerPreference[runner as keyof typeof RunnerPreference],
    };
  }));

  assert.doesNotThrow(() => assertCanonicalAgentSources(roles));
  assert.equal(roles.length, CANONICAL_AGENT_DEFAULTS.length);
});

test("the canonical nine-step template routes both review passes through Review Coordinator", () => {
  assert.equal(CANONICAL_TEMPLATE_STEPS.length, 9);
  assert.deepEqual(
    CANONICAL_TEMPLATE_STEPS.map(({ stepIndex, agentName, outputKind }) => ({ stepIndex, agentName, outputKind })),
    [
      { stepIndex: 1, agentName: "spec", outputKind: "spec" },
      { stepIndex: 2, agentName: "plan", outputKind: "plan" },
      { stepIndex: 3, agentName: "review-coordinator", outputKind: "plan-review" },
      { stepIndex: 4, agentName: "plan-reviser", outputKind: "revised-plan" },
      { stepIndex: 5, agentName: "implementation-plan-executioner", outputKind: "implementation" },
      { stepIndex: 6, agentName: "review-coordinator", outputKind: "code-review" },
      { stepIndex: 7, agentName: "senior-dev", outputKind: "fixed-implementation" },
      { stepIndex: 8, agentName: "librarian", outputKind: "documentation" },
      { stepIndex: 9, agentName: null, outputKind: "approval" },
    ],
  );
  assert.equal(CANONICAL_TEMPLATE_STEPS.some((step) => step.agentName === "code-reviewer"), false);
});
