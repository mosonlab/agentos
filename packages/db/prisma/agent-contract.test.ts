import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RunnerPreference } from "@prisma/client";

import {
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_STEP_INDEX,
  INTEGRATOR_TEMPLATE_NAME,
  integratorBindingValid,
} from "../src/merge-integrator.js";

import {
  assertCanonicalAgentSources,
  CANONICAL_AGENT_DEFAULTS,
  CANONICAL_TEMPLATE_STEPS,
  catalogRunnerForModel,
} from "../src/agent-contract.js";

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

test("the canonical ten-step template routes both review passes through Review Coordinator", () => {
  assert.equal(CANONICAL_TEMPLATE_STEPS.length, 10);
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
      { stepIndex: 10, agentName: "merge-integrator", outputKind: "merge-result" },
    ],
  );
  assert.equal(CANONICAL_TEMPLATE_STEPS.some((step) => step.agentName === "code-reviewer"), false);
});

test("the integrator row is the only step that publishes nothing, and it is not a model row", () => {
  const publishing = CANONICAL_TEMPLATE_STEPS.filter((step) => !step.opensPullRequest).map((step) => step.stepIndex);
  assert.deepEqual(publishing, [INTEGRATOR_STEP_INDEX]);
  const integrator = CANONICAL_TEMPLATE_STEPS.find((step) => step.stepIndex === INTEGRATOR_STEP_INDEX)!;
  assert.equal(integrator.agentName, INTEGRATOR_AGENT_NAME);
  assert.equal(integrator.outputKind, INTEGRATOR_OUTPUT_KIND);
  assert.equal(integrator.approvalGate, false);

  const sentinel = CANONICAL_AGENT_DEFAULTS.find((agent) => agent.name === INTEGRATOR_AGENT_NAME)!;
  assert.equal(sentinel.model, INTEGRATOR_SENTINEL_MODEL);
  // The load-bearing property: no model-CLI runner is derivable from this
  // string, so `assertCanonicalAgentSources`' runner/model mismatch check
  // cannot fire on it and nothing maps it onto a real adapter.
  assert.equal(catalogRunnerForModel(sentinel.model), null);
});

test("the sentinel may bind only step 10, and step 10 only the sentinel", () => {
  const step10 = { stepIndex: 10, outputKind: INTEGRATOR_OUTPUT_KIND, taskTemplate: { name: INTEGRATOR_TEMPLATE_NAME } };
  const step5 = { stepIndex: 5, outputKind: "implementation", taskTemplate: { name: INTEGRATOR_TEMPLATE_NAME } };
  assert.equal(integratorBindingValid(INTEGRATOR_AGENT_NAME, step10), true);
  assert.equal(integratorBindingValid("senior-dev", step5), true);
  assert.equal(integratorBindingValid(INTEGRATOR_AGENT_NAME, step5), false);
  assert.equal(integratorBindingValid("senior-dev", step10), false);
  assert.equal(integratorBindingValid(INTEGRATOR_AGENT_NAME, null), false);
});
