import { readdir, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type { Prisma } from "@prisma/client";

import { DIRECT_TEMPLATE_NAME } from "./agent-contract.js";
import { INTEGRATOR_TEMPLATE_NAME } from "./merge-integrator.js";
import { parsePromptDocument, requiredFrontmatter } from "./prompt-document.js";

const templatesRoot = fileURLToPath(new URL("../../../agents/templates/", import.meta.url));
export const CANONICAL_TEMPLATE_SOURCE_SPECS = [
  { name: INTEGRATOR_TEMPLATE_NAME, stepCount: 12 },
  { name: DIRECT_TEMPLATE_NAME, stepCount: 7 },
] as const;
export type CanonicalTemplateName = (typeof CANONICAL_TEMPLATE_SOURCE_SPECS)[number]["name"];
const COMPOUND_TEMPLATE_STEP_NAMES = [
  "Write a spec",
  "Plan",
  "Plan review",
  "Revise plan",
  "Implementation",
  "Code review (Sol)",
  "Code review and adjudication (Opus)",
  "Apply review fixes",
  "Librarian",
  "Regression verification",
  "Merge authorization",
  "Merge execution",
] as const;
const DIRECT_TEMPLATE_STEP_NAMES = [
  "Implementation",
  "Code review (Sol)",
  "Code review and adjudication (Opus)",
  "Apply review fixes",
  "Regression verification",
  "Merge authorization",
  "Merge execution",
] as const;

export const canonicalTemplateStepName = (templateName: CanonicalTemplateName, stepIndex: number): string => {
  const names = templateName === INTEGRATOR_TEMPLATE_NAME ? COMPOUND_TEMPLATE_STEP_NAMES : DIRECT_TEMPLATE_STEP_NAMES;
  const name = names[stepIndex - 1];
  if (!name) throw new Error(`Missing canonical ${templateName} step name ${stepIndex}`);
  return name;
};
const STRUCTURAL_FIELDS = [
  "stepIndex",
  "agent",
  "approvalGate",
  "outputKind",
  "attachmentsFromPrevious",
  "opensPullRequest",
  "baseFromStepIndex",
  "spawnPolicy",
] as const;

export type TemplateStepSource = {
  stepIndex: number;
  agentName: string | null;
  approvalGate: boolean;
  outputKind: string;
  attachmentsFromPrevious: boolean;
  opensPullRequest: boolean;
  baseFromStepIndex: number | null;
  spawnPolicy: Prisma.InputJsonObject | null;
  prompt: string;
};

export type PersistedTemplateStepStructure = {
  assigneeAgent: { name: string } | null;
  assigneeType: string;
  approvalGate: boolean;
  outputKind: string;
  attachmentsFromPrevious: boolean;
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
    ["approvalGate", actual.approvalGate, expected.approvalGate],
    ["outputKind", actual.outputKind, expected.outputKind],
    ["attachmentsFromPrevious", actual.attachmentsFromPrevious, expected.attachmentsFromPrevious],
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
    const agent = requiredFrontmatter(document, "agent", filePath);
    if (document.body.length === 0) throw new Error(`${filePath} has an empty prompt body`);
    steps.push({
      stepIndex,
      agentName: agent === "null" ? null : agent,
      approvalGate: parseBoolean(requiredFrontmatter(document, "approvalGate", filePath), filePath, "approvalGate"),
      outputKind: requiredFrontmatter(document, "outputKind", filePath),
      attachmentsFromPrevious: parseBoolean(requiredFrontmatter(document, "attachmentsFromPrevious", filePath), filePath, "attachmentsFromPrevious"),
      opensPullRequest: parseBoolean(requiredFrontmatter(document, "opensPullRequest", filePath), filePath, "opensPullRequest"),
      baseFromStepIndex: parseOptionalStepIndex(requiredFrontmatter(document, "baseFromStepIndex", filePath), filePath),
      spawnPolicy: parseSpawnPolicy(requiredFrontmatter(document, "spawnPolicy", filePath), filePath),
      prompt: document.body,
    });
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
    if (step.baseFromStepIndex !== null && !indexes.includes(step.baseFromStepIndex)) {
      throw new Error(`${templateRoot} step ${step.stepIndex} baseFromStepIndex ${step.baseFromStepIndex} does not reference the same template`);
    }
    if (step.baseFromStepIndex !== null && step.baseFromStepIndex >= step.stepIndex) {
      throw new Error(`${templateRoot} step ${step.stepIndex} baseFromStepIndex must reference a strictly earlier stepIndex`);
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
