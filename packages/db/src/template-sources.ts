import { readdir, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type { Prisma } from "@prisma/client";

import { DIRECT_TEMPLATE_NAME } from "./agent-contract.js";
import { INTEGRATOR_TEMPLATE_NAME } from "./merge-integrator.js";
import { parseInlineList, parsePromptDocument, requiredFrontmatter } from "./prompt-document.js";

const templatesRoot = fileURLToPath(new URL("../../../agents/templates/", import.meta.url));
export const CANONICAL_TEMPLATE_SOURCE_SPECS = [
  {
    name: INTEGRATOR_TEMPLATE_NAME,
    stepCount: 12,
    layers: [1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11],
  },
  {
    name: DIRECT_TEMPLATE_NAME,
    stepCount: 7,
    layers: [1, 2, 2, 3, 4, 5, 6],
  },
] as const;
export type CanonicalTemplateName = (typeof CANONICAL_TEMPLATE_SOURCE_SPECS)[number]["name"];
const STRUCTURAL_FIELDS = [
  "stepIndex",
  "layer",
  "agent",
  "approvalGate",
  "outputKind",
  "attachmentsFromPrevious",
  "priorOutputKinds",
  "opensPullRequest",
  "baseFromStepIndex",
  "spawnPolicy",
] as const;

export type TemplateStepSource = {
  stepIndex: number;
  layer: number;
  agentName: string | null;
  approvalGate: boolean;
  outputKind: string;
  attachmentsFromPrevious: boolean;
  priorOutputKinds: string[];
  opensPullRequest: boolean;
  baseFromStepIndex: number | null;
  spawnPolicy: Prisma.InputJsonObject | null;
  prompt: string;
};

export type PersistedTemplateStepStructure = {
  assigneeAgent: { name: string } | null;
  assigneeType: string;
  /**
   * Optional during the expand phase. The contract slice makes this column
   * required after every writer has been migrated, while the source loader
   * already treats an omitted value as structural drift.
   */
  layer?: number | null;
  approvalGate: boolean;
  outputKind: string;
  attachmentsFromPrevious: boolean;
  priorOutputKinds: string[];
  opensPullRequest: boolean;
  baseFromStepIndex: number | null;
  spawnPolicy: Prisma.JsonValue;
};

export const templateStepStructureDifferences = (
  actual: PersistedTemplateStepStructure,
  expected: TemplateStepSource,
): string[] => {
  const expectedAssigneeType = expected.agentName === null ? "HUMAN" : "AGENT";
  const fields = [
    ["agent", actual.assigneeAgent?.name ?? null, expected.agentName],
    ["assigneeType", actual.assigneeType, expectedAssigneeType],
    ["layer", actual.layer, expected.layer],
    ["approvalGate", actual.approvalGate, expected.approvalGate],
    ["outputKind", actual.outputKind, expected.outputKind],
    ["attachmentsFromPrevious", actual.attachmentsFromPrevious, expected.attachmentsFromPrevious],
    ["priorOutputKinds", actual.priorOutputKinds, expected.priorOutputKinds],
    ["opensPullRequest", actual.opensPullRequest, expected.opensPullRequest],
    ["baseFromStepIndex", actual.baseFromStepIndex, expected.baseFromStepIndex],
    ["spawnPolicy", actual.spawnPolicy, expected.spawnPolicy],
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
  const sourceSpec = CANONICAL_TEMPLATE_SOURCE_SPECS.find((candidate) => candidate.name === templateName);
  if (!sourceSpec) throw new Error(`Unknown canonical template source ${templateName}`);
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
    const expectedKeys = [...STRUCTURAL_FIELDS].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      throw new Error(`${filePath} frontmatter must contain exactly ${STRUCTURAL_FIELDS.join(", ")}`);
    }
    const stepIndex = parseStepIndex(requiredFrontmatter(document, "stepIndex", filePath), filePath);
    if (Number(filename.slice(0, 2)) !== stepIndex) throw new Error(`${filePath} prefix does not match stepIndex ${stepIndex}`);
    const layer = parseLayer(requiredFrontmatter(document, "layer", filePath), filePath);
    const agent = requiredFrontmatter(document, "agent", filePath);
    if (document.body.length === 0) throw new Error(`${filePath} has an empty prompt body`);
    steps.push({
      stepIndex,
      layer,
      agentName: agent === "null" ? null : agent,
      approvalGate: parseBoolean(requiredFrontmatter(document, "approvalGate", filePath), filePath, "approvalGate"),
      outputKind: requiredFrontmatter(document, "outputKind", filePath),
      attachmentsFromPrevious: parseBoolean(requiredFrontmatter(document, "attachmentsFromPrevious", filePath), filePath, "attachmentsFromPrevious"),
      priorOutputKinds: parseInlineList(document.attributes.priorOutputKinds, filePath, "priorOutputKinds"),
      opensPullRequest: parseBoolean(requiredFrontmatter(document, "opensPullRequest", filePath), filePath, "opensPullRequest"),
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
  for (let index = 1; index < steps.length; index += 1) {
    const previous = steps[index - 1]!;
    const current = steps[index]!;
    if (current.layer < previous.layer) {
      throw new Error(`${templateRoot} layer values must be non-decreasing at step ${current.stepIndex}`);
    }
  }

  const stepsByIndex = new Map(steps.map((step) => [step.stepIndex, step]));
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
