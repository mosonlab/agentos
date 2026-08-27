import assert from "node:assert/strict";
import { copyFile, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";

import { DIRECT_TEMPLATE_NAME } from "./agent-contract.js";
import { canonicalOutputSchema } from "./canonical-output-schema.js";
import { INTEGRATOR_TEMPLATE_NAME } from "./merge-integrator.js";
import {
  loadTemplateStepSources,
  templateStepStructureDifferences,
  type PersistedTemplateStepStructure,
} from "./template-sources.js";

const templatesRoot = fileURLToPath(new URL("../../../agents/templates/", import.meta.url));

const withTemplateCopy = async (
  templateName: typeof DIRECT_TEMPLATE_NAME | typeof INTEGRATOR_TEMPLATE_NAME,
  mutate: (root: string) => Promise<void>,
  assertion: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "agentos-template-source-test-"));
  try {
    await cp(join(templatesRoot, templateName), join(root, templateName), { recursive: true });
    await mutate(root);
    await assertion(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const updateFrontmatter = async (
  root: string,
  templateName: typeof DIRECT_TEMPLATE_NAME | typeof INTEGRATOR_TEMPLATE_NAME,
  filename: string,
  replace: (source: string) => string,
): Promise<void> => {
  const path = join(root, templateName, filename);
  await writeFile(path, replace(await readFile(path, "utf8")));
};

type PromptContract = {
  format: "json" | "field-list";
  keys: string[];
};

const promptContract = (prompt: string): PromptContract | null => {
  const jsonLiteral = prompt.match(/`(\{"schemaVersion":[^`]+\})`/u)?.[1];
  if (jsonLiteral) {
    const parsed = JSON.parse(jsonLiteral) as unknown;
    assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
    return { format: "json", keys: Object.keys(parsed).sort() };
  }
  const fieldList = prompt.match(/Persist exactly one immutable `blind-findings` JSON object with([\s\S]+?);/u)?.[1];
  if (!fieldList) return null;
  return {
    format: "field-list",
    keys: [...fieldList.matchAll(/`([a-z][A-Za-z]+)`/gu)].map((match) => match[1]!).sort(),
  };
};

test("canonical sources expose the exact layered Direct and Full graphs", async () => {
  const direct = await loadTemplateStepSources(DIRECT_TEMPLATE_NAME);
  const full = await loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME);

  assert.equal(direct.length, 7);
  assert.deepEqual(direct.map(({ layer }) => layer), [1, 2, 2, 3, 4, 5, 6]);
  assert.equal(full.length, 12);
  assert.deepEqual(full.map(({ layer }) => layer), [1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11]);
  for (const templateName of [DIRECT_TEMPLATE_NAME, INTEGRATOR_TEMPLATE_NAME]) {
    assert.equal(
      (await readdir(join(templatesRoot, templateName))).some((filename) => filename.includes("code-review-and-adjudication")),
      false,
    );
  }
  // The fix step now dispositions both review reports itself; no canonical step binds the adjudicator.
  assert.equal(direct.some(({ agentName }) => agentName === "review-adjudicator-opus"), false);
  assert.equal(full.some(({ agentName }) => agentName === "review-adjudicator-opus"), false);
  for (const steps of [direct, full]) {
    assert.deepEqual(
      steps.find(({ outputKind }) => outputKind === "sol-findings")!.priorOutputKinds,
      ["implementation"],
    );
    assert.deepEqual(
      steps.find(({ outputKind }) => outputKind === "blind-findings")!.priorOutputKinds,
      [],
    );
    const librarian = steps.find(({ outputKind }) => outputKind === "documentation");
    if (librarian) assert.deepEqual(librarian.priorOutputKinds, ["implementation", "fixed-implementation"]);
    // The contract the removed adjudication node used to carry, now on the step that replaced it.
    const fix = steps.find(({ outputKind }) => outputKind === "fixed-implementation")!;
    assert.match(fix.prompt, /`sol-findings` and `blind-findings`/u);
    assert.match(fix.prompt, /No adjudication step stands between the reviews and this one/u);
    assert.match(fix.prompt, /exactly one disposition per finding id/u);
    assert.match(fix.prompt, /ADOPTED.*REJECTED.*MERGED/u);
    assert.match(fix.prompt, /every `ADOPTED` disposition has a matching `closedFindings` entry/u);
    const regression = steps.find(({ outputKind }) => outputKind === "regression-verification-v2")!;
    assert.match(regression.prompt, /regression-verification\.sh prepare/u);
    assert.match(regression.prompt, /regression-verification\.sh review-fail/u);
    assert.match(regression.prompt, /regression-verification\.sh finalize/u);
    assert.match(regression.prompt, /finalize exit 77[\s\S]*Repeat the full semantic verification/u);
    assert.match(regression.prompt, /finalize exit 0[\s\S]*`pass`, `gate-fail`,\s+or `refresh-conflict`/u);
    assert.match(regression.prompt, /script persists the one allowed v2 outcome/u);
    assert.doesNotMatch(regression.prompt, /merge-lease\.sh|gate-dispatch\.sh|\{"schemaVersion":2/u);
    assert.ok(regression.prompt.split("\n").length < 30, "the semantic prompt stays materially shorter than the retired 62-line procedure");
  }
});

test("nine authored Full Assurance output contracts match their canonical schemas", async () => {
  const steps = await loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME);
  const contracts = steps
    .map((step) => ({ step, contract: promptContract(step.prompt) }))
    .filter((entry): entry is { step: typeof entry.step; contract: PromptContract } => entry.contract !== null);

  assert.equal(contracts.length, 9);
  assert.equal(contracts.filter(({ contract }) => contract.format === "json").length, 8);
  assert.deepEqual(
    contracts.filter(({ contract }) => contract.format === "field-list").map(({ step }) => step.outputKind),
    ["blind-findings"],
  );
  for (const { step, contract } of contracts) {
    const schema = canonicalOutputSchema(step);
    assert.ok(schema instanceof z.ZodObject, `${step.outputKind} must resolve to an object schema`);
    assert.deepEqual(contract.keys, Object.keys(schema.shape).sort(), step.outputKind);
  }
});

test("missing layer frontmatter is refused by the source loader", async () => {
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "02-code-review-sol.md", (source) => source.replace("layer: 2\n", "")),
    (root) => assert.rejects(
      loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root),
      /frontmatter must contain exactly .*layer/u,
    ),
  );
});

test("missing prior output declaration frontmatter is refused by the source loader", async () => {
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "02-code-review-sol.md", (source) => source.replace(/^priorOutputKinds: .*\n/mu, "")),
    (root) => assert.rejects(
      loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root),
      /frontmatter must contain exactly .*priorOutputKinds/u,
    ),
  );
});

test("prior output declarations are unique and reference only earlier steps", async () => {
  await withTemplateCopy(
    INTEGRATOR_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, INTEGRATOR_TEMPLATE_NAME, "08-apply-review-fixes.md", (source) => source.replace(
      "priorOutputKinds: [sol-findings, blind-findings]",
      "priorOutputKinds: [sol-findings, sol-findings]",
    )),
    (root) => assert.rejects(loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME, root), /duplicate priorOutputKinds sol-findings/u),
  );
  await withTemplateCopy(
    INTEGRATOR_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, INTEGRATOR_TEMPLATE_NAME, "05-implementation.md", (source) => source.replace(
      "priorOutputKinds: [revised-plan]",
      "priorOutputKinds: [sol-findings]",
    )),
    (root) => assert.rejects(loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME, root), /priorOutputKinds sol-findings does not reference an earlier step/u),
  );
});

test("blind review steps cannot declare prior outputs", async () => {
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "03-code-review-opus-blind.md", (source) => source.replace(
      "priorOutputKinds: []",
      "priorOutputKinds: [implementation]",
    )),
    (root) => assert.rejects(
      loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root),
      /blind-findings cannot declare priorOutputKinds/u,
    ),
  );
});

test("inserting a duplicate outputKind into a canonical template is refused", async () => {
  await withTemplateCopy(
    INTEGRATOR_TEMPLATE_NAME,
    async (root) => {
      const templateRoot = join(root, INTEGRATOR_TEMPLATE_NAME);
      const inserted = join(templateRoot, "13-second-merge-execution.md");
      await copyFile(join(templateRoot, "12-merge-execution.md"), inserted);
      await writeFile(inserted, (await readFile(inserted, "utf8")).replace("stepIndex: 12\n", "stepIndex: 13\n"));
    },
    (root) => assert.rejects(
      loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME, root),
      /duplicate outputKind merge-result/u,
    ),
  );
});

test("source layers must be non-decreasing and bases must cross to a lower layer", async () => {
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "03-code-review-opus-blind.md", (source) => source.replace("layer: 2\n", "layer: 1\n")),
    (root) => assert.rejects(loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root), /layer values must be non-decreasing/u),
  );

  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "03-code-review-opus-blind.md", (source) => source.replace("baseFromStepIndex: 1\n", "baseFromStepIndex: 2\n")),
    (root) => assert.rejects(loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root), /must reference a strictly lower layer/u),
  );
});

test("only the exact canonical graphs may contain a multi-node layer", async () => {
  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "04-apply-review-fixes.md", (source) => source.replace("layer: 3\n", "layer: 2\n")),
    (root) => assert.rejects(loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root), /multi-node layer outside the exact canonical graph/u),
  );
});

test("parallel nodes share one non-null base and never open a pull request", async () => {
  await withTemplateCopy(
    INTEGRATOR_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, INTEGRATOR_TEMPLATE_NAME, "06-code-review-sol.md", (source) => source.replace("baseFromStepIndex: 5\n", "baseFromStepIndex: 4\n")),
    (root) => assert.rejects(loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME, root), /must use the same baseFromStepIndex/u),
  );

  await withTemplateCopy(
    DIRECT_TEMPLATE_NAME,
    (root) => updateFrontmatter(root, DIRECT_TEMPLATE_NAME, "02-code-review-sol.md", (source) => source.replace("opensPullRequest: false\n", "opensPullRequest: true\n")),
    (root) => assert.rejects(loadTemplateStepSources(DIRECT_TEMPLATE_NAME, root), /cannot contain a step with opensPullRequest/u),
  );

  for (const [templateName, filename] of [
    [DIRECT_TEMPLATE_NAME, "02-code-review-sol.md"],
    [INTEGRATOR_TEMPLATE_NAME, "06-code-review-sol.md"],
  ] as const) {
    await withTemplateCopy(
      templateName,
      (root) => updateFrontmatter(root, templateName, filename, (source) => source.replace("approvalGate: false\n", "approvalGate: true\n")),
      (root) => assert.rejects(loadTemplateStepSources(templateName, root), /multi-node layer .* cannot contain an approval gate/u),
    );
  }
});

test("layer is a structural field in canonical prompt drift comparison", async () => {
  const expected = (await loadTemplateStepSources(DIRECT_TEMPLATE_NAME))[1]!;
  const persisted: PersistedTemplateStepStructure = {
    assigneeAgent: { name: expected.agentName! },
    assigneeType: "AGENT",
    layer: expected.layer,
    approvalGate: expected.approvalGate,
    outputKind: expected.outputKind,
    attachmentsFromPrevious: expected.attachmentsFromPrevious,
    priorOutputKinds: expected.priorOutputKinds,
    opensPullRequest: expected.opensPullRequest,
    baseFromStepIndex: expected.baseFromStepIndex,
    spawnPolicy: expected.spawnPolicy as PersistedTemplateStepStructure["spawnPolicy"],
  };
  assert.deepEqual(templateStepStructureDifferences(persisted, expected), []);
  assert.deepEqual(templateStepStructureDifferences({ ...persisted, layer: expected.layer + 1 }, expected), ["layer"]);
});
