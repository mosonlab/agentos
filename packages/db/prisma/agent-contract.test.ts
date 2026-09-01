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
  catalogRunnerForModel,
  DIRECT_TEMPLATE_NAME,
  PR_TEMPLATE_NAME,
} from "../src/agent-contract.js";
import {
  CANONICAL_TEMPLATE_SOURCE_SPECS,
  loadAllTemplateStepSources,
  loadTemplateStepSources,
  type PersistedTemplateStepStructure,
  templateStepStructureDifferences,
} from "../src/template-sources.js";

const rolesRoot = fileURLToPath(new URL("../../../agents/roles/", import.meta.url));
const prismaRoot = fileURLToPath(new URL("./", import.meta.url));

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
});

test("canonical profiles start at Default and native child capability replaces Agent subprocess profiles", async () => {
  const [seed, publishedMigration, historicalRepair, nativeMigration] = await Promise.all([
    readFile(`${prismaRoot}seed.ts`, "utf8"),
    readFile(`${prismaRoot}migrations/20260823010000_codex_service_tier/migration.sql`, "utf8"),
    readFile(`${prismaRoot}migrations/20260823033000_executioner_subprocess_profiles/migration.sql`, "utf8"),
    readFile(`${prismaRoot}migrations/20260824010000_native_implementation_subagents/migration.sql`, "utf8"),
  ]);

  assert.match(seed, /create:\s*\{[\s\S]*codexServiceTier: CodexServiceTier\.DEFAULT,/u);
  assert.doesNotMatch(seed, /CodexServiceTier\.FAST/u);
  assert.match(publishedMigration, /UPDATE\s+"Agent"[\s\S]*"codexServiceTier"\s*=\s*'fast'/u);
  assert.match(publishedMigration, /ADD COLUMN "codexServiceTier" "CodexServiceTier" NOT NULL DEFAULT 'default'/u);
  assert.match(historicalRepair, /migration\."finished_at" IS NOT NULL/u);
  assert.match(historicalRepair, /agent\."updatedAt" < migration\."finished_at"/u);
  assert.match(nativeMigration, /ADD COLUMN "subagentModel" TEXT/u);
  assert.match(nativeMigration, /"subagentModel" = 'gpt-5\.6-luna:max'/u);
  assert.match(nativeMigration, /"subagentMaxConcurrent" = 8/u);
  assert.match(nativeMigration, /DROP COLUMN "ordinarySubprocessModel"/u);
  assert.match(nativeMigration, /DROP COLUMN "elevatedSubprocessModel"/u);
});

test("template-step dependency provisioning is a non-null true-default migration", async () => {
  const schema = await readFile(`${prismaRoot}schema.prisma`, "utf8");
  const migration = await readFile(`${prismaRoot}migrations/20260901010000_task_template_step_dependency_provisioning/migration.sql`, "utf8");
  assert.match(schema, /provisionDependencies\s+Boolean\s+@default\(true\)/u);
  assert.match(migration, /ALTER TABLE "TaskTemplateStep"[\s\S]*ADD COLUMN "provisionDependencies" BOOLEAN NOT NULL DEFAULT true;/u);
  assert.doesNotMatch(migration, /DROP|UPDATE|CREATE TYPE/u);
});

test("named canonical roles use their model catalog runner and retired role names stay absent", async () => {
  const canonical = new Map((await loadAgentSources()).roles.map((role) => [role.name, role]));
  for (const name of [
    "spec",
    "review-coordinator-opus",
    "frontend-dev",
    "review-coordinator",
    "review-coordinator-sol",
    "regression-verifier",
    "librarian",
    "senior-dev",
    "spec-revalidator",
    "implementation-plan-executioner",
  ]) {
    const role = canonical.get(name);
    assert.ok(role, `role source must contain ${name}`);
    assert.equal(catalogRunnerForModel(role.model), role.runnerPreference);
  }
  assert.equal(canonical.has("senior-dev-high"), false);
  assert.equal(canonical.has("review-adjudicator-opus"), false);
});

test("the split review prompts enforce persisted-range, blindness, and regression contracts", async () => {
  const [planReview, firstReview, blindReview, regressionVerification] = await Promise.all([
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
  assert.match(firstReview, /only as the Anneal task output/u);
  assert.doesNotMatch(firstReview, /reviews\/sol-findings\.md/u);
  assert.match(firstReview, /quote the exact governing\s+specification text/u);
  assert.match(firstReview, /one session, make two sequential explicit passes over the same reviewed range/u);
  assert.match(firstReview, /first complete the Standards pass/u);
  assert.match(firstReview, /only then start a separate Spec pass/u);
  assert.match(firstReview, /merge both passes into one persisted report/u);
  assert.doesNotMatch(firstReview, /codex exec review/u);
  assert.doesNotMatch(firstReview, /service[-_ ]tier/iu);
  // The 2026-08-25 incident: this role ran the full merge gate inside its review
  // step, deadlocked the host twice, and recorded the interrupted gate's FAIL
  // line as review evidence. The gate belongs to the later regression step.
  assert.match(firstReview, /repository merge gate\s+is not yours to run/u);
  assert.match(firstReview, /a gate\s+that is interrupted reports no verdict at all/u);
  assert.match(firstReview, /post-fix regression verification/u);
  assert.match(firstReview, /entire fix diff as one unit/u);
  assert.match(firstReview, /exact fixed head/u);

  assert.match(blindReview, /independent blind Opus review coordinator/u);
  assert.match(blindReview, /immutable `blind-findings` task output/u);
  assert.match(blindReview, /Do not read predecessor task outputs, sibling\s+task outputs/u);
  assert.match(blindReview, /entire task and provider\s+session, both before and after/u);
  assert.match(blindReview, /implementationBaseSha|implementation base and head/u);
  assert.match(blindReview, /repository merge gate is not yours to run/u);
  assert.doesNotMatch(blindReview, /adjudicat/u);
  assert.doesNotMatch(blindReview, /merge matrix/u);
  assert.doesNotMatch(blindReview, /service[-_ ]tier/iu);
  assert.doesNotMatch(blindReview, /codex exec review/u);

  assert.equal(frontmatterValue(regressionVerification, "model"), "gpt-5.6-luna:xhigh");
  assert.equal(frontmatterValue(regressionVerification, "runner"), "codex");
  assert.equal(frontmatterValue(regressionVerification, "inboxAccess"), "false");
  assert.match(regressionVerification, /complete persisted review package/u);
  assert.match(regressionVerification, /Review the whole fix diff/u);
  assert.match(regressionVerification, /platform script prepares the refreshed tree/u);
  assert.match(regressionVerification, /never[\s\S]*operate the merge lease[\s\S]*author the final task output/u);
  assert.doesNotMatch(regressionVerification, /blind reports mechanically/u);
});

test("the executioner delegates only through platform-pinned native Luna children", async () => {
  const executioner = await roleSource("implementation-plan-executioner");
  assert.equal(frontmatterValue(executioner, "model"), "gpt-5.6-sol:high");
  assert.match(executioner, /pins every native child to Luna max/u);
  assert.match(executioner, /eight concurrent child threads/u);
  assert.match(executioner, /Delegation is not one slice per child/u);
  assert.match(executioner, /one long-lived Luna max merger child/u);
  assert.match(executioner, /Do not run a Merge Gate or repository-wide suite during Implementation/u);
  assert.doesNotMatch(executioner, /codex exec/u);
});

test("the canonical twelve-step layered template sources split review and preserve mechanical merge", async () => {
  const templateSteps = await loadTemplateStepSources();
  assert.equal(templateSteps.length, 12);
  assert.deepEqual(
    templateSteps.map(({ stepIndex, layer, agentName, outputKind }) => ({ stepIndex, layer, agentName, outputKind })),
    [
      { stepIndex: 1, layer: 1, agentName: "spec", outputKind: "spec" },
      { stepIndex: 2, layer: 2, agentName: "plan", outputKind: "plan" },
      { stepIndex: 3, layer: 3, agentName: "review-coordinator", outputKind: "plan-review" },
      { stepIndex: 4, layer: 4, agentName: "plan-reviser", outputKind: "revised-plan" },
      { stepIndex: 5, layer: 5, agentName: "implementation-plan-executioner", outputKind: "implementation" },
      { stepIndex: 6, layer: 6, agentName: "review-coordinator-sol", outputKind: "sol-findings" },
      { stepIndex: 7, layer: 6, agentName: "review-coordinator-opus", outputKind: "blind-findings" },
      { stepIndex: 8, layer: 7, agentName: "senior-dev", outputKind: "fixed-implementation" },
      { stepIndex: 9, layer: 8, agentName: "librarian", outputKind: "documentation" },
      { stepIndex: 10, layer: 9, agentName: "regression-verifier", outputKind: "regression-verification-v2" },
      { stepIndex: 11, layer: 10, agentName: "review-coordinator", outputKind: "merge-authorization" },
      { stepIndex: 12, layer: 11, agentName: "merge-integrator", outputKind: "merge-result" },
    ],
  );
  assert.equal(templateSteps.some((step) => step.agentName === "code-reviewer"), false);
  assert.equal(templateSteps.find((step) => step.stepIndex === 6)?.baseFromStepIndex, 5);
  assert.equal(templateSteps.find((step) => step.stepIndex === 7)?.attachmentsFromPrevious, false);
  assert.equal(templateSteps.find((step) => step.stepIndex === 8)?.attachmentsFromPrevious, true);
  assert.equal(templateSteps.find((step) => step.stepIndex === 10)?.attachmentsFromPrevious, true);
  const compoundFix = templateSteps.find((step) => step.stepIndex === 8)!.prompt;
  assert.match(compoundFix, /Read both immutable review outputs from the preceding layer/u);
  assert.match(compoundFix, /`sol-findings`[\s\S]*`blind-findings`/u);
  assert.match(compoundFix, /No adjudication step stands between the reviews and this one/u);
  assert.match(compoundFix, /ADOPTED[\s\S]*REJECTED[\s\S]*MERGED/u);
  const compoundRegression = templateSteps.find((step) => step.stepIndex === 10)!.prompt;
  assert.match(compoundRegression, /platform script owns refresh\/merge[\s\S]*final `regression-verification-v2`/u);
  assert.match(compoundRegression, /regression-verification\.sh prepare/u);
  assert.match(compoundRegression, /regression-verification\.sh review-fail/u);
  assert.match(compoundRegression, /regression-verification\.sh finalize/u);
  assert.match(compoundRegression, /finalize exit 77[\s\S]*Repeat the full semantic verification/u);
  assert.match(compoundRegression, /implementation summary,\s+both review reports/u);
  assert.match(compoundRegression, /fixed implementation with its dispositions/u);
  assert.doesNotMatch(compoundRegression, /all\s+preceding Step outputs/u);
  assert.doesNotMatch(compoundRegression, /merge-lease\.sh|gate-dispatch\.sh|gateProof/u);
  const directRegression = (await loadTemplateStepSources(DIRECT_TEMPLATE_NAME))
    .find((step) => step.stepIndex === 6)!.prompt;
  assert.equal(compoundRegression, directRegression);
  assert.equal(templateSteps.every((step) => step.prompt.length > 0), true);
  assert.equal(templateSteps.every((step) => step.spawnPolicy === null), true);
  assert.match(templateSteps[1]!.prompt, /load-bearing decisions in `decisions\.md`/u);
  assert.doesNotMatch(templateSteps[1]!.prompt, /sessions\.md|plan_authoring/u);
  assert.match(templateSteps[1]!.prompt, /chain-level evidence, including the repository Merge Gate, remains outside the slice set/u);
  assert.match(templateSteps[2]!.prompt, /merge or split decisions priced against frontier width/u);
  assert.match(templateSteps[3]!.prompt, /Start a fresh session — never resume the planning conversation/u);
  assert.match(templateSteps[3]!.prompt, /rewrite its `decisions\.md` entry/u);
  assert.doesNotMatch(templateSteps[3]!.prompt, /sessions\.md|plan_authoring|plan_revision/u);
  assert.match(templateSteps[4]!.prompt, /platform-pinned Implementation proof boundary/u);
});

test("only artifact-producing steps require a commit, only implementation opens a pull request, and the integrator is not a model row", async () => {
  const templateSteps = await loadTemplateStepSources();
  const requiringCommit = templateSteps.filter((step) => step.requiresCommit).map((step) => step.stepIndex);
  assert.deepEqual(requiringCommit, [2, 5]);
  const opening = templateSteps.filter((step) => step.opensPullRequest).map((step) => step.stepIndex);
  assert.deepEqual(opening, [5]);
  const integrator = templateSteps.find((step) => step.stepIndex === INTEGRATOR_STEP_INDEX)!;
  assert.equal(integrator.agentName, INTEGRATOR_AGENT_NAME);
  assert.equal(integrator.outputKind, INTEGRATOR_OUTPUT_KIND);
  assert.equal(integrator.approvalGate, false);

  const sentinel = (await loadAgentSources()).roles.find((agent) => agent.name === INTEGRATOR_AGENT_NAME);
  assert.ok(sentinel);
  assert.equal(sentinel.model, INTEGRATOR_SENTINEL_MODEL);
  assert.equal(sentinel.runnerPreference, RunnerPreference.INHERIT);
  // The load-bearing property: no model-CLI runner is derivable from this
  // string, so `assertCanonicalAgentSources`' runner/model mismatch check
  // cannot fire on it and nothing maps it onto a real adapter.
  assert.equal(catalogRunnerForModel(sentinel.model), null);
});

test("only canonical code-review rows disable dependency provisioning", async () => {
  const templates = await loadAllTemplateStepSources();
  const disabled = [...templates].flatMap(([templateName, steps]) => steps
    .filter((step) => !step.provisionDependencies)
    .map((step) => `${templateName}:${step.stepIndex}`));
  assert.deepEqual(disabled, [
    `${INTEGRATOR_TEMPLATE_NAME}:6`,
    `${INTEGRATOR_TEMPLATE_NAME}:7`,
    `${DIRECT_TEMPLATE_NAME}:3`,
    `${DIRECT_TEMPLATE_NAME}:4`,
    `${PR_TEMPLATE_NAME}:2`,
    `${PR_TEMPLATE_NAME}:3`,
  ]);
  assert.equal([...templates.values()].flat().every((step) => step.provisionDependencies === true || step.provisionDependencies === false), true);
});

test("the direct template sources expose the layered review spine and mechanical tail", async () => {
  const directTemplateSteps = await loadTemplateStepSources(DIRECT_TEMPLATE_NAME);
  assert.deepEqual(
    directTemplateSteps.map(({ stepIndex, layer, agentName, outputKind }) => ({ stepIndex, layer, agentName, outputKind })),
    [
      { stepIndex: 1, layer: 1, agentName: "spec-revalidator", outputKind: "revalidation" },
      { stepIndex: 2, layer: 2, agentName: "senior-dev-luna", outputKind: "implementation" },
      { stepIndex: 3, layer: 3, agentName: "review-coordinator-sol", outputKind: "sol-findings" },
      { stepIndex: 4, layer: 3, agentName: "review-coordinator-opus", outputKind: "blind-findings" },
      { stepIndex: 5, layer: 4, agentName: "senior-dev", outputKind: "fixed-implementation" },
      { stepIndex: 6, layer: 5, agentName: "regression-verifier", outputKind: "regression-verification-v2" },
      { stepIndex: 7, layer: 6, agentName: "review-coordinator", outputKind: "merge-authorization" },
      { stepIndex: 8, layer: 7, agentName: "merge-integrator", outputKind: "merge-result" },
    ],
  );
  // Only implementation opens the chain's pull request; the blind review
  // starts blind; regression verification reads the fix diff.
  assert.deepEqual(directTemplateSteps.filter((step) => step.requiresCommit).map((step) => step.stepIndex), [2]);
  assert.deepEqual(directTemplateSteps.filter((step) => step.opensPullRequest).map((step) => step.stepIndex), [2]);
  assert.equal(directTemplateSteps.find((step) => step.stepIndex === 3)?.baseFromStepIndex, 2);
  assert.equal(directTemplateSteps.find((step) => step.stepIndex === 4)?.attachmentsFromPrevious, false);
  assert.equal(directTemplateSteps.find((step) => step.stepIndex === 5)?.attachmentsFromPrevious, true);
  assert.equal(directTemplateSteps.find((step) => step.stepIndex === 6)?.attachmentsFromPrevious, true);
  const directFix = directTemplateSteps.find((step) => step.stepIndex === 5)!.prompt;
  assert.match(directFix, /Read both immutable review outputs from the preceding layer/u);
  assert.match(directFix, /No adjudication step stands between the reviews and this one/u);
  const directRegression = directTemplateSteps.find((step) => step.stepIndex === 6)!.prompt;
  assert.match(directRegression, /regression-verification\.sh prepare/u);
  assert.match(directRegression, /regression-verification\.sh review-fail/u);
  assert.match(directRegression, /regression-verification\.sh finalize/u);
  assert.match(directRegression, /finalize exit 77[\s\S]*Repeat the full semantic verification/u);
  assert.doesNotMatch(directRegression, /merge-lease\.sh|gate-dispatch\.sh|gateProof/u);
  const directImplementation = directTemplateSteps.find((step) => step.stepIndex === 2)!.prompt;
  assert.match(directImplementation, /brief is the specification of record/u);
  assert.doesNotMatch(directImplementation, /Copy the brief verbatim/u);
  assert.match(
    directImplementation,
    /The platform materializes `\.chain\/\{\{branchName\}\}\/spec\.md` as the specification of record; leave it untouched\./u,
  );
  assert.match(directImplementation, /at least two child-writer branches need integration/u);
  assert.match(directImplementation, /integrate a sole child-writer branch yourself/u);
  assert.match(directImplementation, /resolves only mechanical conflicts[\s\S]*reports semantic conflicts to you/u);
  assert.match(directImplementation, /platform-pinned Implementation proof boundary/u);
  assert.match(directTemplateSteps[6]!.prompt, /server-owned mechanical readiness step/u);
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

test("the complete template source inventory contains exactly the three canonical workflows", async () => {
  const templates = await loadAllTemplateStepSources();
  assert.deepEqual([...templates.keys()], [INTEGRATOR_TEMPLATE_NAME, DIRECT_TEMPLATE_NAME, PR_TEMPLATE_NAME]);
  assert.equal(templates.get(INTEGRATOR_TEMPLATE_NAME)?.length, 12);
  assert.equal(templates.get(DIRECT_TEMPLATE_NAME)?.length, 8);
  assert.equal(templates.get(PR_TEMPLATE_NAME)?.length, 4);
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
    name: expected.name,
    assigneeAgent: { name: expected.agentName! },
    assigneeType: "AGENT",
    layer: expected.layer,
    approvalGate: expected.approvalGate,
    outputKind: expected.outputKind,
    attachmentsFromPrevious: expected.attachmentsFromPrevious,
    priorOutputKinds: expected.priorOutputKinds,
    opensPullRequest: expected.opensPullRequest,
    requiresCommit: expected.requiresCommit,
    provisionDependencies: expected.provisionDependencies,
    baseFromStepIndex: expected.baseFromStepIndex,
    spawnPolicy: expected.spawnPolicy,
  };
  assert.deepEqual(templateStepStructureDifferences(persisted, expected), []);
  const mutations: Array<[string, PersistedTemplateStepStructure]> = [
    ["name", { ...persisted, name: "Different display name" }],
    ["agent", { ...persisted, assigneeAgent: { name: "different-agent" } }],
    ["assigneeType", { ...persisted, assigneeType: "HUMAN" }],
    ["layer", { ...persisted, layer: expected.layer + 1 }],
    ["approvalGate", { ...persisted, approvalGate: !persisted.approvalGate }],
    ["outputKind", { ...persisted, outputKind: "different-output" }],
    ["attachmentsFromPrevious", { ...persisted, attachmentsFromPrevious: !persisted.attachmentsFromPrevious }],
    ["priorOutputKinds", { ...persisted, priorOutputKinds: ["different-output"] }],
    ["opensPullRequest", { ...persisted, opensPullRequest: !persisted.opensPullRequest }],
    ["requiresCommit", { ...persisted, requiresCommit: !persisted.requiresCommit }],
    ["provisionDependencies", { ...persisted, provisionDependencies: !persisted.provisionDependencies }],
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
