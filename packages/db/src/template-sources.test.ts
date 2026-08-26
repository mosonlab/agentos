import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

import { DIRECT_TEMPLATE_NAME } from "./agent-contract.js";
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
    // The contract the removed adjudication node used to carry, now on the step that replaced it.
    const fix = steps.find(({ outputKind }) => outputKind === "fixed-implementation")!;
    assert.match(fix.prompt, /`sol-findings` and `blind-findings`/u);
    assert.match(fix.prompt, /No adjudication step stands between the reviews and this one/u);
    assert.match(fix.prompt, /exactly one disposition per finding id/u);
    assert.match(fix.prompt, /ADOPTED.*REJECTED.*MERGED/u);
    assert.match(fix.prompt, /every `ADOPTED` disposition has a matching `closedFindings` entry/u);
    const regression = steps.find(({ outputKind }) => outputKind === "regression-verification")!;
    assert.match(regression.prompt, /merge-lease\.sh acquire --task \{\{chainId\}\}/u);
    assert.match(regression.prompt, /retry it up to three times/u);
    assert.match(regression.prompt, /exits 75 or 76[\s\S]*up to two[\s\S]*more times/u);
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
    opensPullRequest: expected.opensPullRequest,
    baseFromStepIndex: expected.baseFromStepIndex,
    spawnPolicy: expected.spawnPolicy as PersistedTemplateStepStructure["spawnPolicy"],
  };
  assert.deepEqual(templateStepStructureDifferences(persisted, expected), []);
  assert.deepEqual(templateStepStructureDifferences({ ...persisted, layer: expected.layer + 1 }, expected), ["layer"]);
});
