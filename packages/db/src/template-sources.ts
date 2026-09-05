import { readdir, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type { Prisma } from "@prisma/client";

import { DIRECT_TEMPLATE_NAME, PR_TEMPLATE_NAME } from "./agent-contract.js";
import { gateSlotOf } from "./gate-slot.js";
import { INTEGRATOR_TEMPLATE_NAME } from "./merge-integrator.js";
import { parseInlineList, parsePromptDocument, requiredFrontmatter } from "./prompt-document.js";
import { TEMPLATE_STEP_FRONTMATTER_KEYS } from "./template-step-fields.js";

/**
 * The row-vs-source comparator this module presents, built from the one field
 * table `template-step-fields.ts` holds.
 */
export { templateStepStructureDifferences } from "./template-step-fields.js";

const templatesRoot = fileURLToPath(new URL("../../../agents/templates/", import.meta.url));
/** Migration-only marker: pre-whitelist template rows retain the old all-output handoff. */
export const LEGACY_ALL_PRIOR_OUTPUTS = "__legacy_all_prior_outputs__";
export const CANONICAL_TEMPLATE_SOURCE_SPECS = [
  {
    name: INTEGRATOR_TEMPLATE_NAME,
    description: "Twelve-step Full Assurance workflow with parallel independent code review, operator-free fix adjudication inside the fix step, refreshed exact-head regression verification, mechanical readiness, and mechanical merge execution.",
    stepCount: 12,
    layers: [1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11],
    stepNames: [
      "Write a spec", "Plan", "Plan review", "Revise plan", "Implementation", "Code review (Sol)",
      "Code review (Opus blind)", "Apply review fixes", "Librarian",
      "Regression verification", "Merge authorization", "Merge execution",
    ],
  },
  {
    name: DIRECT_TEMPLATE_NAME,
    description: "Direct-tier workflow: revalidate a bound brief against the current tree, implement from the refreshed brief, run parallel independent code review, adjudicate fixes inside the fix step, verify the exact head, and execute the mechanical merge tail.",
    stepCount: 8,
    layers: [1, 2, 3, 3, 4, 5, 6, 7],
    stepNames: [
      "Revalidate specification", "Implementation", "Code review (Sol)",
      "Code review (Opus blind)", "Apply review fixes", "Regression verification",
      "Merge authorization", "Merge execution",
    ],
  },
  {
    name: PR_TEMPLATE_NAME,
    description: "Four-step pull-request workflow: implement the task, run parallel independent code review, and apply review fixes before leaving an open pull request for the platform.",
    stepCount: 4,
    layers: [1, 2, 2, 3],
    stepNames: [
      "Implementation", "Code review (Sol)", "Code review (Opus blind)", "Apply review fixes",
    ],
  },
] as const;
export type CanonicalTemplateName = (typeof CANONICAL_TEMPLATE_SOURCE_SPECS)[number]["name"];
export const canonicalTemplateSourceSpec = (name: CanonicalTemplateName) => {
  const spec = CANONICAL_TEMPLATE_SOURCE_SPECS.find((candidate) => candidate.name === name);
  if (!spec) throw new Error(`Unknown canonical template source ${name}`);
  return spec;
};

export type TemplateStepSource = {
  stepIndex: number;
  name: string;
  layer: number;
  agentName: string | null;
  approvalGate: boolean;
  optional: boolean;
  outputKind: string;
  attachmentsFromPrevious: boolean;
  priorOutputKinds: string[];
  opensPullRequest: boolean;
  requiresCommit: boolean;
  provisionDependencies: boolean;
  baseFromStepIndex: number | null;
  spawnPolicy: Prisma.InputJsonObject | null;
  prompt: string;
};

export type PersistedTemplateStepStructure = {
  name: string;
  assigneeAgent: { name: string } | null;
  assigneeType: string;
  /**
   * Optional during the expand phase. The contract slice makes this column
   * required after every writer has been migrated, while the source loader
   * already treats an omitted value as structural drift.
   */
  layer?: number | null;
  approvalGate: boolean;
  optional?: boolean;
  outputKind: string;
  attachmentsFromPrevious: boolean;
  priorOutputKinds: string[];
  opensPullRequest: boolean;
  requiresCommit: boolean;
  provisionDependencies: boolean;
  baseFromStepIndex: number | null;
  spawnPolicy: Prisma.JsonValue;
};

export type PersistedTemplateMetadata = {
  name: string;
  description: string;
  variables: string[];
};

export const templateMetadataDifferences = (
  actual: PersistedTemplateMetadata,
  templateName: CanonicalTemplateName,
): string[] => {
  const expected = canonicalTemplateSourceSpec(templateName);
  const fields = [
    ["name", actual.name, templateName],
    ["description", actual.description, expected.description],
    ["variables", actual.variables, ["branchName"]],
  ] as const;
  return fields
    .filter(([, actualValue, expectedValue]) => !isDeepStrictEqual(actualValue, expectedValue))
    .map(([field]) => field);
};

const parseBoolean = (value: string, filePath: string, key: string): boolean => {
  if (value !== "true" && value !== "false") throw new Error(`${filePath} ${key} must be true or false`);
  return value === "true";
};

const parseStepIndex = (value: string, filePath: string): number => {
  if (!/^\d+$/u.test(value)) throw new Error(`${filePath} stepIndex must be a positive integer`);
  const stepIndex = Number(value);
  if (!Number.isSafeInteger(stepIndex) || stepIndex < 1) throw new Error(`${filePath} stepIndex must be a positive integer`);
  return stepIndex;
};

const parseLayer = (value: string, filePath: string): number => {
  if (!/^-?\d+$/u.test(value)) throw new Error(`${filePath} layer must be an integer`);
  const layer = Number(value);
  if (!Number.isSafeInteger(layer)) throw new Error(`${filePath} layer must be an integer`);
  return layer;
};

const parseOptionalStepIndex = (value: string, filePath: string): number | null => (
  value === "null" ? null : parseStepIndex(value, filePath)
);

const parseSpawnPolicy = (value: string, filePath: string): Prisma.InputJsonObject | null => {
  if (value === "null") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${filePath} spawnPolicy must be null or a JSON object`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${filePath} spawnPolicy must be null or a JSON object`);
  }
  return parsed as Prisma.InputJsonObject;
};

export const loadTemplateStepSources = async (
  templateName: CanonicalTemplateName = INTEGRATOR_TEMPLATE_NAME,
  sourceRoot: string = templatesRoot,
): Promise<TemplateStepSource[]> => {
  const sourceSpec = canonicalTemplateSourceSpec(templateName);
  const templateRoot = join(sourceRoot, templateName);
  const files = (await readdir(templateRoot)).sort();
  const steps: TemplateStepSource[] = [];
  for (const filename of files) {
    if (!/^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(filename)) {
      throw new Error(`${join(templateRoot, filename)} must be named <NN>-<slug>.md`);
    }
    const filePath = join(templateRoot, filename);
    const document = parsePromptDocument(await readFile(filePath, "utf8"), filePath);
    const keys = Object.keys(document.attributes).sort();
    const expectedKeys = [...TEMPLATE_STEP_FRONTMATTER_KEYS].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      throw new Error(`${filePath} frontmatter must contain exactly ${TEMPLATE_STEP_FRONTMATTER_KEYS.join(", ")}`);
    }
    const stepIndex = parseStepIndex(requiredFrontmatter(document, "stepIndex", filePath), filePath);
    if (Number(filename.slice(0, 2)) !== stepIndex) throw new Error(`${filePath} prefix does not match stepIndex ${stepIndex}`);
    const layer = parseLayer(requiredFrontmatter(document, "layer", filePath), filePath);
    const agent = requiredFrontmatter(document, "agent", filePath);
    if (document.body.length === 0) throw new Error(`${filePath} has an empty prompt body`);
    steps.push({
      stepIndex,
      name: sourceSpec.stepNames[stepIndex - 1]!,
      layer,
      agentName: agent === "null" ? null : agent,
      approvalGate: parseBoolean(requiredFrontmatter(document, "approvalGate", filePath), filePath, "approvalGate"),
      optional: parseBoolean(requiredFrontmatter(document, "optional", filePath), filePath, "optional"),
      outputKind: requiredFrontmatter(document, "outputKind", filePath),
      attachmentsFromPrevious: parseBoolean(requiredFrontmatter(document, "attachmentsFromPrevious", filePath), filePath, "attachmentsFromPrevious"),
      priorOutputKinds: parseInlineList(document.attributes.priorOutputKinds, filePath, "priorOutputKinds"),
      opensPullRequest: parseBoolean(requiredFrontmatter(document, "opensPullRequest", filePath), filePath, "opensPullRequest"),
      requiresCommit: parseBoolean(requiredFrontmatter(document, "requiresCommit", filePath), filePath, "requiresCommit"),
      provisionDependencies: parseBoolean(requiredFrontmatter(document, "provisionDependencies", filePath), filePath, "provisionDependencies"),
      baseFromStepIndex: parseOptionalStepIndex(requiredFrontmatter(document, "baseFromStepIndex", filePath), filePath),
      spawnPolicy: parseSpawnPolicy(requiredFrontmatter(document, "spawnPolicy", filePath), filePath),
      prompt: document.body,
    });
  }
  const outputKinds = steps.map((step) => step.outputKind);
  if (new Set(outputKinds).size !== outputKinds.length) {
    const duplicate = outputKinds.find((outputKind, index) => outputKinds.indexOf(outputKind) !== index)!;
    throw new Error(`${templateRoot} contains duplicate outputKind ${duplicate}`);
  }
  if (steps.length !== sourceSpec.stepCount) {
    throw new Error(`${templateRoot} must contain exactly ${sourceSpec.stepCount} step prompts; found ${steps.length}`);
  }
  const indexes = steps.map((step) => step.stepIndex);
  if (new Set(indexes).size !== indexes.length) throw new Error(`${templateRoot} contains duplicate stepIndex values`);
  const expectedIndexes = Array.from({ length: sourceSpec.stepCount }, (_, index) => index + 1);
  if (JSON.stringify(indexes) !== JSON.stringify(expectedIndexes)) {
    throw new Error(`${templateRoot} stepIndex values must be contiguous from 1 through ${sourceSpec.stepCount}`);
  }
  for (const step of steps) {
    const duplicatePriorKind = step.priorOutputKinds.find((kind, index) => step.priorOutputKinds.indexOf(kind) !== index);
    if (duplicatePriorKind) {
      throw new Error(`${templateRoot} step ${step.stepIndex} contains duplicate priorOutputKinds ${duplicatePriorKind}`);
    }
    const earlierOutputKinds = new Set(steps
      .filter((candidate) => candidate.stepIndex < step.stepIndex)
      .map((candidate) => candidate.outputKind));
    const nonPriorKind = step.priorOutputKinds.find((kind) => !earlierOutputKinds.has(kind));
    if (nonPriorKind) {
      throw new Error(`${templateRoot} step ${step.stepIndex} priorOutputKinds ${nonPriorKind} does not reference an earlier step`);
    }
    if (step.outputKind === "blind-findings" && step.priorOutputKinds.length > 0) {
      throw new Error(`${templateRoot} step ${step.stepIndex} blind-findings cannot declare priorOutputKinds`);
    }
  }
  for (let index = 1; index < steps.length; index += 1) {
    const previous = steps[index - 1]!;
    const current = steps[index]!;
    if (current.layer < previous.layer) {
      throw new Error(`${templateRoot} layer values must be non-decreasing at step ${current.stepIndex}`);
    }
  }

  const stepsByIndex = new Map(steps.map((step) => [step.stepIndex, step]));

  // Optional steps may be omitted at instantiation, so the entry point,
  // configurable gate slots, and the immediate predecessor of the merge tail
  // must remain present in every materialized chain. A retained step may also
  // not pin its base to a step that can disappear.
  for (const step of steps) {
    if (step.stepIndex === 1 && step.optional) {
      throw new Error(`${templateRoot} step ${step.stepIndex} first_step_optional`);
    }
    if (step.baseFromStepIndex !== null && stepsByIndex.get(step.baseFromStepIndex)?.optional) {
      throw new Error(`${templateRoot} step ${step.stepIndex} base_step_optional ${step.baseFromStepIndex}`);
    }
    if (step.optional && gateSlotOf(step) !== null) {
      throw new Error(`${templateRoot} step ${step.stepIndex} gate_slot_step_optional`);
    }
    const next = stepsByIndex.get(step.stepIndex + 1);
    if (step.optional && (next?.outputKind === "merge-authorization" || next?.outputKind === "merge-result")) {
      throw new Error(`${templateRoot} step ${step.stepIndex} optional_step_precedes_merge_tail`);
    }
  }

  for (const step of steps) {
    if (step.baseFromStepIndex !== null && !indexes.includes(step.baseFromStepIndex)) {
      throw new Error(`${templateRoot} step ${step.stepIndex} baseFromStepIndex ${step.baseFromStepIndex} does not reference the same template`);
    }
    if (step.baseFromStepIndex !== null && step.baseFromStepIndex >= step.stepIndex) {
      throw new Error(`${templateRoot} step ${step.stepIndex} baseFromStepIndex must reference a strictly earlier stepIndex`);
    }
    if (step.baseFromStepIndex !== null) {
      const baseStep = stepsByIndex.get(step.baseFromStepIndex)!;
      if (baseStep.layer >= step.layer) {
        throw new Error(`${templateRoot} step ${step.stepIndex} baseFromStepIndex ${step.baseFromStepIndex} must reference a strictly lower layer`);
      }
    }
  }

  const layerGroups = new Map<number, TemplateStepSource[]>();
  for (const step of steps) {
    const group = layerGroups.get(step.layer) ?? [];
    group.push(step);
    layerGroups.set(step.layer, group);
  }
  const hasMultiNodeLayer = [...layerGroups.values()].some((group) => group.length > 1);
  const expectedLayers = [...sourceSpec.layers];
  const actualLayers = steps.map((step) => step.layer);
  if (hasMultiNodeLayer && JSON.stringify(actualLayers) !== JSON.stringify(expectedLayers)) {
    throw new Error(`${templateRoot} contains a multi-node layer outside the exact canonical graph`);
  }
  for (const [layer, group] of layerGroups) {
    if (group.length < 2) continue;
    if (group.some((step) => step.approvalGate)) {
      throw new Error(`${templateRoot} multi-node layer ${layer} cannot contain an approval gate`);
    }
    if (group.some((step) => step.baseFromStepIndex === null)) {
      throw new Error(`${templateRoot} multi-node layer ${layer} requires a non-null baseFromStepIndex on every node`);
    }
    const baseFromStepIndex = group[0]!.baseFromStepIndex;
    if (group.some((step) => step.baseFromStepIndex !== baseFromStepIndex)) {
      throw new Error(`${templateRoot} multi-node layer ${layer} must use the same baseFromStepIndex on every node`);
    }
    if (group.some((step) => step.opensPullRequest)) {
      throw new Error(`${templateRoot} multi-node layer ${layer} cannot contain a step with opensPullRequest: true`);
    }
  }
  return steps;
};

export const loadAllTemplateStepSources = async (
  sourceRoot: string = templatesRoot,
): Promise<Map<CanonicalTemplateName, TemplateStepSource[]>> => {
  const rootEntries = await readdir(sourceRoot, { withFileTypes: true });
  const nonDirectories = rootEntries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name).sort();
  if (nonDirectories.length > 0) {
    throw new Error(`${sourceRoot} must contain only canonical template directories; found ${nonDirectories.join(", ")}`);
  }
  const actualNames = rootEntries.map((entry) => entry.name).sort();
  const expectedNames = CANONICAL_TEMPLATE_SOURCE_SPECS.map(({ name }) => name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`${sourceRoot} canonical template inventory must be exactly ${expectedNames.join(", ")}; found ${actualNames.join(", ")}`);
  }
  const entries = await Promise.all(CANONICAL_TEMPLATE_SOURCE_SPECS.map(async ({ name }) => (
    [name, await loadTemplateStepSources(name, sourceRoot)] as const
  )));
  return new Map(entries);
};
