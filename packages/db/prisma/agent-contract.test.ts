import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  loadAgentSources,
  type PersistedRoleStructure,
  roleSourceStructureDifferences,
} from "../src/agent-sources.js";
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
  type PersistedTemplateStepStructure,
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

test("signed AgentOS model routing stays pinned in the canonical contract", () => {
  const canonical = new Map(CANONICAL_AGENT_DEFAULTS.map((role) => [role.name, role]));
  assert.deepEqual(canonical.get("spec"), {
    name: "spec",
    model: "gpt-5.6-sol:high",
    runner: RunnerPreference.CODEX,
  });
  for (const name of ["frontend-dev", "review-coordinator-opus"] as const) {
    assert.deepEqual(canonical.get(name), {
      name,
      model: "claude-opus-5:medium",
      runner: RunnerPreference.CLAUDE,
    });
  }
  for (const name of ["review-coordinator", "review-coordinator-sol"] as const) {
    assert.deepEqual(canonical.get(name), {
      name,
      model: "openai-codex/gpt-5.6-sol:high",
      runner: RunnerPreference.PI,
    });
  }
  assert.deepEqual(canonical.get("regression-verifier"), {
    name: "regression-verifier",
    model: "openai-codex/gpt-5.6-sol:medium",
    runner: RunnerPreference.PI,
  });
});

test("the split review prompts enforce persisted-range, blind-order, adjudication, and regression contracts", async () => {
  const [planReview, firstReview, finalReview, regressionVerification] = await Promise.all([
    roleSource("review-coordinator"),
    roleSource("review-coordinator-sol"),
    roleSource("review-coordinator-opus"),
    roleSource("regression-verifier"),
  ]);

  assert.match(planReview, /never review implementation\s+diffs/u);
  assert.match(planReview, /acceptance criterion fail at the frozen base commit/u);
  assert.match(planReview, /mislabelled risk\s+flags/u);

  assert.match(firstReview, /implementation step's persisted output/u);
  assert.match(firstReview, /complete\s+`base\.\.\.head` diff/u);
  assert.match(firstReview, /only as the AgentOS task output/u);
  assert.doesNotMatch(firstReview, /reviews\/sol-findings\.md/u);
  assert.match(firstReview, /quote the exact governing\s+specification text/u);
  assert.match(firstReview, /one session, make two sequential explicit passes over the same reviewed range/u);
  assert.match(firstReview, /first complete the Standards pass/u);
  assert.match(firstReview, /only then start a separate Spec pass/u);
  assert.match(firstReview, /merge both passes into one persisted report/u);
  assert.doesNotMatch(firstReview, /codex exec review/u);
  assert.match(firstReview, /post-fix regression verification/u);
  assert.match(firstReview, /entire fix diff as one unit/u);
  assert.match(firstReview, /exact fixed head/u);

  const blindWrite = finalReview.indexOf("intermediate AgentOS task output");
  const firstReportRead = finalReview.indexOf("predecessor step outputs", blindWrite);
  assert.ok(blindWrite >= 0 && firstReportRead > blindWrite, "blind findings must be persisted before the first report is read");
  assert.match(finalReview, /revised slice set from `.chain\/<chain branch>\/slices\/` where the chain carries one/u);
  assert.match(finalReview, /reachable in the tree at `head`/u);
  assert.match(finalReview, /same defect reported by both is adopted at the higher severity/u);
  assert.equal(frontmatterValue(finalReview, "inboxAccess"), "true");
  assert.match(finalReview, /stop in this step, and use Inbox to present both\s+bodies of evidence to the human/u);
  assert.match(finalReview, /does not become effective\s+automatically/u);
  assert.match(finalReview, /entire fix diff as one\s+unit/u);
  assert.match(finalReview, /exact fixed head/u);
  assert.match(finalReview, /provider id in the platform output/u);

  assert.equal(frontmatterValue(regressionVerification, "model"), "openai-codex/gpt-5.6-sol:medium");
  assert.equal(frontmatterValue(regressionVerification, "runner"), "pi");
  assert.equal(frontmatterValue(regressionVerification, "inboxAccess"), "false");
  assert.match(regressionVerification, /complete persisted review package/u);
  assert.match(regressionVerification, /entire fix diff as one unit/u);
  assert.match(regressionVerification, /do not run the full\s+gate/u);
  assert.match(regressionVerification, /one exact-head\s+mechanical gate/u);
  assert.doesNotMatch(regressionVerification, /blind reports mechanically/u);
});

test("the executioner launches ordinary and risk subprocesses with explicit service tiers", async () => {
  const executioner = await roleSource("implementation-plan-executioner");
  assert.match(executioner, /AGENTOS_SUBORDINATE_CODEX_MODEL/u);
  assert.match(executioner, /AGENTOS_SUBORDINATE_CODEX_REASONING_EFFORT/u);
  assert.match(executioner, /AGENTOS_SUBORDINATE_CODEX_SERVICE_TIER/u);
  assert.match(executioner, /service_tier="default"/u);
  assert.doesNotMatch(executioner, /service_tier="standard"/u);
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
      { stepIndex: 9, agentName: "regression-verifier", outputKind: "regression-verification" },
      { stepIndex: 10, agentName: "librarian", outputKind: "documentation" },
      { stepIndex: 11, agentName: "review-coordinator", outputKind: "merge-authorization" },
      { stepIndex: 12, agentName: "merge-integrator", outputKind: "merge-result" },
    ],
  );
  assert.equal(templateSteps.some((step) => step.agentName === "code-reviewer"), false);
  assert.equal(templateSteps.find((step) => step.stepIndex === 7)?.attachmentsFromPrevious, false);
  assert.equal(templateSteps.find((step) => step.stepIndex === 9)?.attachmentsFromPrevious, true);
  const compoundRegression = templateSteps.find((step) => step.stepIndex === 9)!.prompt;
  assert.match(compoundRegression, /platform-pinned `run\.pullRequestBase`[\s\S]*integration\s+line authority/u);
  assert.match(compoundRegression, /`review-fail`[\s\S]*Only after semantic verification passes/u);
  assert.match(compoundRegression, /gate-dispatch\.sh <head-sha> --master <baseHeadSha>/u);
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

test("the direct template sources keep the review spine, drop planning, and end in mechanical readiness and merge", async () => {
  const directTemplateSteps = await loadTemplateStepSources(DIRECT_TEMPLATE_NAME);
  assert.deepEqual(
    directTemplateSteps.map(({ stepIndex, agentName, outputKind }) => ({ stepIndex, agentName, outputKind })),
    [
      { stepIndex: 1, agentName: "senior-dev-luna", outputKind: "implementation" },
      { stepIndex: 2, agentName: "review-coordinator-sol", outputKind: "sol-findings" },
      { stepIndex: 3, agentName: "review-coordinator-opus", outputKind: "must-fix" },
      { stepIndex: 4, agentName: "senior-dev", outputKind: "fixed-implementation" },
      { stepIndex: 5, agentName: "regression-verifier", outputKind: "regression-verification" },
      { stepIndex: 6, agentName: "review-coordinator", outputKind: "merge-authorization" },
      { stepIndex: 7, agentName: "merge-integrator", outputKind: "merge-result" },
    ],
  );
  // Only implementation opens the chain's pull request; the blind review
  // starts blind; regression verification reads the fix diff.
  assert.deepEqual(directTemplateSteps.filter((step) => step.opensPullRequest).map((step) => step.stepIndex), [1]);
  assert.equal(directTemplateSteps.find((step) => step.stepIndex === 3)?.attachmentsFromPrevious, false);
  assert.equal(directTemplateSteps.find((step) => step.stepIndex === 5)?.attachmentsFromPrevious, true);
  const directRegression = directTemplateSteps.find((step) => step.stepIndex === 5)!.prompt;
  assert.match(directRegression, /platform-pinned `run\.pullRequestBase`[\s\S]*integration\s+line authority/u);
  assert.match(directRegression, /`review-fail`[\s\S]*Only after semantic verification passes/u);
  assert.match(directRegression, /gate-dispatch\.sh <head-sha> --master <baseHeadSha>/u);
  assert.match(directTemplateSteps[0]!.prompt, /brief is the specification of record/u);
  assert.match(directTemplateSteps[5]!.prompt, /server-owned mechanical readiness step/u);
  // Readiness is server-owned and the terminal step is the sentinel-bound
  // mechanical executor, with no human approval gate on either.
  const last = directTemplateSteps.at(-1)!;
  assert.equal(last.approvalGate, false);
  assert.equal(last.agentName, INTEGRATOR_AGENT_NAME);
  for (const step of directTemplateSteps) {
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
  assert.equal(templates.get(DIRECT_TEMPLATE_NAME)?.length, 7);
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

test("the complete template source inventory rejects a missing workflow or non-directory entry", async () => {
  const missingRoot = await mkdtemp(join(tmpdir(), "agentos-template-sources-missing-"));
  const fileRoot = await mkdtemp(join(tmpdir(), "agentos-template-sources-file-"));
  try {
    await mkdir(join(missingRoot, INTEGRATOR_TEMPLATE_NAME));
    await assert.rejects(loadAllTemplateStepSources(missingRoot), /canonical template inventory must be exactly/u);

    await mkdir(join(fileRoot, INTEGRATOR_TEMPLATE_NAME));
    await writeFile(join(fileRoot, DIRECT_TEMPLATE_NAME), "not a directory\n");
    await assert.rejects(loadAllTemplateStepSources(fileRoot), /must contain only canonical template directories/u);
  } finally {
    await Promise.all([
      rm(missingRoot, { recursive: true, force: true }),
      rm(fileRoot, { recursive: true, force: true }),
    ]);
  }
});

test("canonical prompt sync can detect every Markdown-owned structural field", async () => {
  const expected = (await loadTemplateStepSources(DIRECT_TEMPLATE_NAME))[0]!;
  const persisted: PersistedTemplateStepStructure = {
    assigneeAgent: { name: expected.agentName! },
    assigneeType: "AGENT",
    approvalGate: expected.approvalGate,
    outputKind: expected.outputKind,
    attachmentsFromPrevious: expected.attachmentsFromPrevious,
    opensPullRequest: expected.opensPullRequest,
    baseFromStepIndex: expected.baseFromStepIndex,
    spawnPolicy: expected.spawnPolicy,
  };
  assert.deepEqual(templateStepStructureDifferences(persisted, expected), []);
  const mutations: Array<[string, PersistedTemplateStepStructure]> = [
    ["agent", { ...persisted, assigneeAgent: { name: "different-agent" } }],
    ["assigneeType", { ...persisted, assigneeType: "HUMAN" }],
    ["approvalGate", { ...persisted, approvalGate: !persisted.approvalGate }],
    ["outputKind", { ...persisted, outputKind: "different-output" }],
    ["attachmentsFromPrevious", { ...persisted, attachmentsFromPrevious: !persisted.attachmentsFromPrevious }],
    ["opensPullRequest", { ...persisted, opensPullRequest: !persisted.opensPullRequest }],
    ["baseFromStepIndex", { ...persisted, baseFromStepIndex: 0 }],
    ["spawnPolicy", { ...persisted, spawnPolicy: { tier: "sub" } }],
  ];
  for (const [field, mutation] of mutations) {
    assert.deepEqual(templateStepStructureDifferences(mutation, expected), [field]);
  }
});

test("canonical prompt sync can detect every role frontmatter field", async () => {
  const role = (await loadAgentSources()).roles.find(({ name }) => name === "librarian")!;
  const persisted: PersistedRoleStructure = {
    title: role.title,
    model: role.model,
    runnerPreference: role.runnerPreference,
    inboxAccess: role.inboxAccess,
    collaborators: role.collaborators.map((name) => ({ allowedAgent: { name } })),
  };
  assert.deepEqual(roleSourceStructureDifferences(persisted, role), []);
  const mutations: Array<[string, PersistedRoleStructure]> = [
    ["title", { ...persisted, title: "Different title" }],
    ["model", { ...persisted, model: "different-model" }],
    ["runnerPreference", { ...persisted, runnerPreference: RunnerPreference.CLAUDE }],
    ["inboxAccess", { ...persisted, inboxAccess: !persisted.inboxAccess }],
    ["collaborators", { ...persisted, collaborators: [{ allowedAgent: { name: "default" } }] }],
  ];
  for (const [field, mutation] of mutations) {
    assert.deepEqual(roleSourceStructureDifferences(mutation, role), [field]);
  }
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
