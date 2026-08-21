import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  catalogRunnerForModel,
  DIRECT_TEMPLATE_NAME,
} from "../src/agent-contract.js";
import {
  CANONICAL_TEMPLATE_SOURCE_SPECS,
  loadAllTemplateStepSources,
  loadTemplateStepSources,
  templateStepStructureDifferences,
} from "../src/template-sources.js";

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

test("the split review prompts enforce persisted-range, blind-order, adjudication, and regression contracts", async () => {
  const [planReview, firstReview, finalReview] = await Promise.all([
    roleSource("review-coordinator"),
    roleSource("review-coordinator-sol"),
    roleSource("review-coordinator-opus"),
  ]);

  assert.match(planReview, /never review implementation\s+diffs/u);
  assert.match(planReview, /acceptance criterion fail at the frozen base commit/u);
  assert.match(planReview, /mislabelled risk\s+flags/u);

  assert.match(firstReview, /implementation step's persisted output/u);
  assert.match(firstReview, /labelled `implementation_range` entry/u);
  assert.match(firstReview, /complete\s+`base\.\.\.head` diff/u);
  assert.match(firstReview, /reviews\/sol-findings\.md/u);
  assert.match(firstReview, /quote the exact governing\s+specification text/u);
  assert.match(firstReview, /codex exec review -m gpt-5\.6-sol -c model_reasoning_effort=high/u);
  assert.match(firstReview, /review the changes from <implementation base sha> to <delivered head sha>/u);

  const blindWrite = finalReview.indexOf("reviews/opus-blind-findings.md");
  const firstReportRead = finalReview.indexOf("reviews/sol-findings.md", blindWrite);
  assert.ok(blindWrite >= 0 && firstReportRead > blindWrite, "blind findings must be persisted before the first report is read");
  assert.match(finalReview, /revised slice set from `.chain\/<chain branch>\/slices\/` where the chain carries one/u);
  assert.match(finalReview, /reachable in the tree at `head`/u);
  assert.match(finalReview, /same defect reported by both is adopted at the higher severity/u);
  assert.equal(frontmatterValue(finalReview, "inboxAccess"), "true");
  assert.match(finalReview, /stop in this step, and use Inbox to present both\s+bodies of evidence to the human/u);
  assert.match(finalReview, /does not become effective\s+automatically/u);
  assert.match(finalReview, /entire fix diff as one\s+unit/u);
  assert.match(finalReview, /exact fixed head/u);
  assert.match(finalReview, /label `opus_blind_review`/u);
});

test("the canonical twelve-step template sources split code review and preserve mechanical merge", async () => {
  const templateSteps = await loadTemplateStepSources();
  assert.equal(templateSteps.length, 12);
  assert.deepEqual(
    templateSteps.map(({ stepIndex, agentName, outputKind }) => ({ stepIndex, agentName, outputKind })),
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
  assert.equal(templateSteps.some((step) => step.agentName === "code-reviewer"), false);
  assert.equal(templateSteps.find((step) => step.stepIndex === 7)?.attachmentsFromPrevious, false);
  assert.equal(templateSteps.find((step) => step.stepIndex === 9)?.attachmentsFromPrevious, true);
  assert.equal(templateSteps.every((step) => step.prompt.length > 0), true);
  assert.equal(templateSteps.every((step) => step.spawnPolicy === null), true);
  assert.match(templateSteps[1]!.prompt, /this run's id/u);
  assert.match(templateSteps[2]!.prompt, /merge or split decisions priced against frontier width/u);
  assert.match(templateSteps[3]!.prompt, /run id labelled `plan_authoring`/u);
});

test("only implementation opens a pull request, and the integrator is not a model row", async () => {
  const templateSteps = await loadTemplateStepSources();
  const opening = templateSteps.filter((step) => step.opensPullRequest).map((step) => step.stepIndex);
  assert.deepEqual(opening, [5]);
  const integrator = templateSteps.find((step) => step.stepIndex === INTEGRATOR_STEP_INDEX)!;
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

test("the direct template sources keep the review spine, drop planning, and end at the human gate", async () => {
  const directTemplateSteps = await loadTemplateStepSources(DIRECT_TEMPLATE_NAME);
  assert.deepEqual(
    directTemplateSteps.map(({ stepIndex, agentName, outputKind }) => ({ stepIndex, agentName, outputKind })),
    [
      { stepIndex: 1, agentName: "senior-dev", outputKind: "implementation" },
      { stepIndex: 2, agentName: "review-coordinator-sol", outputKind: "sol-findings" },
      { stepIndex: 3, agentName: "review-coordinator-opus", outputKind: "must-fix" },
      { stepIndex: 4, agentName: "senior-dev", outputKind: "fixed-implementation" },
      { stepIndex: 5, agentName: "review-coordinator-opus", outputKind: "regression-verification" },
      { stepIndex: 6, agentName: null, outputKind: "approval" },
    ],
  );
  // Only implementation opens the chain's pull request; the blind review
  // starts blind; regression verification reads the fix diff.
  assert.deepEqual(directTemplateSteps.filter((step) => step.opensPullRequest).map((step) => step.stepIndex), [1]);
  assert.equal(directTemplateSteps.find((step) => step.stepIndex === 3)?.attachmentsFromPrevious, false);
  assert.equal(directTemplateSteps.find((step) => step.stepIndex === 5)?.attachmentsFromPrevious, true);
  assert.match(directTemplateSteps[0]!.prompt, /brief is the specification of record/u);
  assert.match(directTemplateSteps[5]!.prompt, /no mechanical merge step/u);
  // The human pull-request gate is the terminal step: the integrator's
  // bidirectional binding admits no mechanical merge outside the twelve-step
  // template, so no direct step may bind the sentinel.
  const last = directTemplateSteps.at(-1)!;
  assert.equal(last.approvalGate, true);
  assert.equal(last.agentName, null);
  for (const step of directTemplateSteps) {
    assert.notEqual(step.agentName, INTEGRATOR_AGENT_NAME);
    assert.equal(
      integratorBindingValid(step.agentName, { stepIndex: step.stepIndex, outputKind: step.outputKind, taskTemplate: { name: DIRECT_TEMPLATE_NAME } }),
      true,
    );
  }
});

test("the complete template source inventory contains only the twelve-step and direct workflows", async () => {
  const templates = await loadAllTemplateStepSources();
  assert.deepEqual([...templates.keys()], [INTEGRATOR_TEMPLATE_NAME, DIRECT_TEMPLATE_NAME]);
  assert.equal(templates.get(INTEGRATOR_TEMPLATE_NAME)?.length, 12);
  assert.equal(templates.get(DIRECT_TEMPLATE_NAME)?.length, 6);
});

test("the complete template source inventory rejects an unregistered workflow directory", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "agentos-template-sources-"));
  try {
    await Promise.all(CANONICAL_TEMPLATE_SOURCE_SPECS.map(({ name }) => mkdir(join(sourceRoot, name))));
    await mkdir(join(sourceRoot, "unregistered-workflow"));
    await assert.rejects(
      loadAllTemplateStepSources(sourceRoot),
      /canonical template inventory must be exactly/u,
    );
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("canonical prompt sync can detect every Markdown-owned structural field", async () => {
  const expected = (await loadTemplateStepSources(DIRECT_TEMPLATE_NAME))[0]!;
  const persisted = {
    assigneeAgent: { name: expected.agentName! },
    assigneeType: "AGENT",
    approvalGate: expected.approvalGate,
    outputKind: expected.outputKind,
    attachmentsFromPrevious: expected.attachmentsFromPrevious,
    opensPullRequest: expected.opensPullRequest,
    spawnPolicy: expected.spawnPolicy,
  };
  assert.deepEqual(templateStepStructureDifferences(persisted, expected), []);
  assert.deepEqual(
    templateStepStructureDifferences({ ...persisted, attachmentsFromPrevious: !persisted.attachmentsFromPrevious }, expected),
    ["attachmentsFromPrevious"],
  );
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
