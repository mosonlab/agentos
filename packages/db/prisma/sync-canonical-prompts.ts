import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import ts from "typescript";

import { DIRECT_TEMPLATE_NAME } from "../src/agent-contract.js";
import { loadAgentSources } from "../src/agent-sources.js";
import { INTEGRATOR_TEMPLATE_NAME } from "../src/merge-integrator.js";

// Every template the seed states prompts for, every step of each, and every
// role under agents/, is synced. A hand-kept subset is how a prompt edit
// silently misses production.
const SEED_STEP_VARIABLES: Record<string, string> = {
  steps: INTEGRATOR_TEMPLATE_NAME,
  directSteps: DIRECT_TEMPLATE_NAME,
};

const loadStepPrompts = async (): Promise<Map<string, Map<number, string>>> => {
  const seedPath = fileURLToPath(new URL("./seed.ts", import.meta.url));
  const sourceText = await readFile(seedPath, "utf8");
  const source = ts.createSourceFile(seedPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const arrays = new Map<string, ts.ArrayLiteralExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text in SEED_STEP_VARIABLES
      && node.initializer
      && ts.isAsExpression(node.initializer)
      && ts.isArrayLiteralExpression(node.initializer.expression)) {
      arrays.set(SEED_STEP_VARIABLES[node.name.text]!, node.initializer.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const missing = Object.values(SEED_STEP_VARIABLES).filter((name) => !arrays.has(name));
  if (missing.length > 0) throw new Error(`Seed steps tuple array(s) not found in prisma/seed.ts for: ${missing.join(", ")}`);

  const byTemplate = new Map<string, Map<number, string>>();
  for (const [templateName, elements] of arrays) {
    const prompts = new Map<number, string>();
    for (const element of elements.elements) {
      if (!ts.isArrayLiteralExpression(element)) continue;
      const indexNode = element.elements[0];
      const promptNode = element.elements[7];
      if (!indexNode || !ts.isNumericLiteral(indexNode) || !promptNode || !ts.isStringLiteral(promptNode)) continue;
      prompts.set(Number(indexNode.text), promptNode.text);
    }
    if (prompts.size === 0) throw new Error(`No step prompts were found in prisma/seed.ts for ${templateName}`);
    byTemplate.set(templateName, prompts);
  }
  return byTemplate;
};

const main = async (): Promise<void> => {
  const [stepPrompts, sources] = await Promise.all([loadStepPrompts(), loadAgentSources()]);
  const rolePrompts = new Map(sources.roles.map((role) => [role.name, role.rolePrompt]));
  const roleNames = [...rolePrompts.keys()];

  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(async (tx) => {
      const updatedSteps: Record<string, Record<number, number>> = {};
      let templateCount = 0;
      for (const [templateName, prompts] of stepPrompts) {
        const templates = await tx.taskTemplate.findMany({
          where: { name: templateName },
          select: { id: true },
        });
        if (templates.length === 0) throw new Error(`Template ${templateName} was not found`);
        templateCount += templates.length;
        const templateIds = templates.map((template) => template.id);
        const updated: Record<number, number> = {};
        for (const stepIndex of [...prompts.keys()].sort((left, right) => left - right)) {
          const prompt = prompts.get(stepIndex)!;
          const present = await tx.taskTemplateStep.count({
            where: { taskTemplateId: { in: templateIds }, stepIndex },
          });
          if (present !== templates.length) {
            throw new Error(`Expected step ${stepIndex} on ${templates.length} ${templateName} templates; found ${present}`);
          }
          updated[stepIndex] = (await tx.taskTemplateStep.updateMany({
            where: { taskTemplateId: { in: templateIds }, stepIndex, prompt: { not: prompt } },
            data: { prompt },
          })).count;
        }
        updatedSteps[templateName] = updated;
      }

      const presentAgents = await tx.agent.findMany({
        where: { name: { in: roleNames } },
        select: { name: true },
      });
      const presentRoleNames = new Set(presentAgents.map((agent) => agent.name));
      for (const name of roleNames) {
        if (!presentRoleNames.has(name)) throw new Error(`Agent ${name} was not found`);
      }
      const updatedRoles: Record<string, number> = {};
      for (const name of roleNames) {
        const rolePrompt = rolePrompts.get(name)!;
        updatedRoles[name] = (await tx.agent.updateMany({
          where: { name, rolePrompt: { not: rolePrompt } },
          data: { rolePrompt },
        })).count;
      }
      return { templates: templateCount, updatedSteps, updatedRoles };
    });
    const updated = Object.values(result.updatedSteps)
      .flatMap((byStep) => Object.values(byStep))
      .reduce((sum, count) => sum + count, 0)
      + Object.values(result.updatedRoles).reduce((sum, count) => sum + count, 0);
    console.log(JSON.stringify({ ...result, updated }));
  } finally {
    await prisma.$disconnect();
  }
};

await main();
