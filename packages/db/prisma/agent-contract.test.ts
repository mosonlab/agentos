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

const roleSource = (name: string): Promise<string> => readFile(`${rolesRoot}${name}.md`, "utf8");

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

test("the split review prompts enforce frozen-range, blind-order, adjudication, and regression contracts", async () => {
  const [planReview, firstReview, finalReview] = await Promise.all([
    roleSource("review-coordinator"),
    roleSource("review-coordinator-sol"),
    roleSource("review-coordinator-opus"),
  ]);

  assert.match(planReview, /never review implementation\s+diffs/u);
  assert.match(planReview, /acceptance criterion fail at the frozen base commit/u);

  assert.match(firstReview, /frozen immediately before implementation began/u);
  assert.match(firstReview, /complete\s+`base\.\.\.head` diff/u);
  assert.match(firstReview, /Persist the complete report as the task output/u);
  assert.match(firstReview, /quote the exact governing\s+specification text/u);

  const blindWrite = finalReview.indexOf("persisted and committed as your task output");
  const firstReportRead = finalReview.indexOf("read the first reviewer's report attachment");
  assert.ok(blindWrite >= 0 && firstReportRead > blindWrite, "blind findings must be persisted before the first report is read");
  assert.match(finalReview, /same defect reported by both is adopted at the higher severity/u);
  assert.equal(frontmatterValue(finalReview, "inboxAccess"), "true");
  assert.match(finalReview, /stop in this step, and use Inbox to present both\s+bodies of evidence to the human/u);
  assert.match(finalReview, /does not become effective\s+automatically/u);
  assert.match(finalReview, /entire fix diff as one\s+unit/u);
  assert.match(finalReview, /exact fixed head/u);
});

test("the canonical twelve-step template splits code review and preserves mechanical merge", () => {
  assert.equal(CANONICAL_TEMPLATE_STEPS.length, 12);
  assert.deepEqual(
    CANONICAL_TEMPLATE_STEPS.map(({ stepIndex, agentName, outputKind }) => ({ stepIndex, agentName, outputKind })),
    [
      { stepIndex: 1, agentName: "spec", outputKind: "spec" },
      { stepIndex: 2, agentName: "plan", outputKind: "plan" },
      { stepIndex: 3, agentName: "review-coordinator", outputKind: "plan-review" },
      { stepIndex: 4, agentName: "plan-reviser", outputKind: "revised-plan" },
      { stepIndex: 5, agentName: "implementation-plan-executioner", outputKind: "implementation" },
      { stepIndex: 6, agentName: "review-coordinator-sol", outputKind: "sol-findings" },
      { stepIndex: 7, agentName: "review-coordinator-opus", outputKind: "must-fix" },
      { stepIndex: 8, agentName: "senior-dev", outputKind: "fixed-implementation" },
      { stepIndex: 9, agentName: "review-coordinator-opus", outputKind: "regression-verification" },
      { stepIndex: 10, agentName: "librarian", outputKind: "documentation" },
      { stepIndex: 11, agentName: null, outputKind: "approval" },
      { stepIndex: 12, agentName: "merge-integrator", outputKind: "merge-result" },
    ],
  );
  assert.equal(CANONICAL_TEMPLATE_STEPS.some((step) => step.agentName === "code-reviewer"), false);
  assert.equal(CANONICAL_TEMPLATE_STEPS.find((step) => step.stepIndex === 7)?.attachmentsFromPrevious, false);
  assert.equal(CANONICAL_TEMPLATE_STEPS.find((step) => step.stepIndex === 9)?.attachmentsFromPrevious, true);
});

test("only implementation opens a pull request, and the integrator is not a model row", () => {
  const opening = CANONICAL_TEMPLATE_STEPS.filter((step) => step.opensPullRequest).map((step) => step.stepIndex);
  assert.deepEqual(opening, [5]);
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

test("the sentinel may bind only step 12, and step 12 only the sentinel", () => {
  const step12 = { stepIndex: INTEGRATOR_STEP_INDEX, outputKind: INTEGRATOR_OUTPUT_KIND, taskTemplate: { name: INTEGRATOR_TEMPLATE_NAME } };
  const step5 = { stepIndex: 5, outputKind: "implementation", taskTemplate: { name: INTEGRATOR_TEMPLATE_NAME } };
  assert.equal(integratorBindingValid(INTEGRATOR_AGENT_NAME, step12), true);
  assert.equal(integratorBindingValid("senior-dev", step5), true);
  assert.equal(integratorBindingValid(INTEGRATOR_AGENT_NAME, step5), false);
  assert.equal(integratorBindingValid("senior-dev", step12), false);
  assert.equal(integratorBindingValid(INTEGRATOR_AGENT_NAME, null), false);
});
