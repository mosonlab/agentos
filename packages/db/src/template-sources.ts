import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Prisma } from "@prisma/client";

import { DIRECT_TEMPLATE_NAME } from "./agent-contract.js";
import { INTEGRATOR_TEMPLATE_NAME } from "./merge-integrator.js";
import { parsePromptDocument, requiredFrontmatter } from "./prompt-document.js";

const templatesRoot = fileURLToPath(new URL("../../../agents/templates/", import.meta.url));
export const CANONICAL_TEMPLATE_SOURCE_SPECS = [
  { name: INTEGRATOR_TEMPLATE_NAME, stepCount: 12 },
  { name: DIRECT_TEMPLATE_NAME, stepCount: 6 },
] as const;
export type CanonicalTemplateName = (typeof CANONICAL_TEMPLATE_SOURCE_SPECS)[number]["name"];
const STRUCTURAL_FIELDS = [
  "stepIndex",
  "agent",
  "approvalGate",
  "outputKind",
  "attachmentsFromPrevious",
  "opensPullRequest",
  "spawnPolicy",
] as const;

export type TemplateStepSource = {
  stepIndex: number;
  agentName: string | null;
  approvalGate: boolean;
  outputKind: string;
  attachmentsFromPrevious: boolean;
  opensPullRequest: boolean;
  spawnPolicy: Prisma.InputJsonObject | null;
  prompt: string;
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
): Promise<TemplateStepSource[]> => {
  const sourceSpec = CANONICAL_TEMPLATE_SOURCE_SPECS.find((candidate) => candidate.name === templateName);
  if (!sourceSpec) throw new Error(`Unknown canonical template source ${templateName}`);
  const templateRoot = `${templatesRoot}${templateName}/`;
  const files = (await readdir(templateRoot)).sort();
  const steps: TemplateStepSource[] = [];
  for (const filename of files) {
    if (!/^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(filename)) {
      throw new Error(`${templateRoot}${filename} must be named <NN>-<slug>.md`);
    }
    const filePath = `${templateRoot}${filename}`;
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
  return steps;
};

export const loadAllTemplateStepSources = async (): Promise<Map<CanonicalTemplateName, TemplateStepSource[]>> => {
  const entries = await Promise.all(CANONICAL_TEMPLATE_SOURCE_SPECS.map(async ({ name }) => (
    [name, await loadTemplateStepSources(name)] as const
  )));
  return new Map(entries);
};
