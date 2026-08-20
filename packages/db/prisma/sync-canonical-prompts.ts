import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import ts from "typescript";

import { loadAgentSources } from "../src/agent-sources.js";
import { INTEGRATOR_TEMPLATE_NAME } from "../src/merge-integrator.js";

// Every step the seed states a prompt for, and every role under agents/, is
// synced. A hand-kept subset is how a prompt edit silently misses production.
const loadStepPrompts = async (): Promise<Map<number, string>> => {
  const seedPath = fileURLToPath(new URL("./seed.ts", import.meta.url));
  const sourceText = await readFile(seedPath, "utf8");
  const source = ts.createSourceFile(seedPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let steps: ts.ArrayLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "steps"
      && node.initializer
      && ts.isAsExpression(node.initializer)
      && ts.isArrayLiteralExpression(node.initializer.expression)) {
      steps = node.initializer.expression;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!steps) throw new Error("Canonical seed steps tuple array was not found in prisma/seed.ts");

  const prompts = new Map<number, string>();
  for (const element of (steps as ts.ArrayLiteralExpression).elements) {
    if (!ts.isArrayLiteralExpression(element)) continue;
    const indexNode = element.elements[0];
    const promptNode = element.elements[7];
    if (!indexNode || !ts.isNumericLiteral(indexNode) || !promptNode || !ts.isStringLiteral(promptNode)) continue;
    prompts.set(Number(indexNode.text), promptNode.text);
  }
  if (prompts.size === 0) throw new Error("No template step prompts were found in prisma/seed.ts");
  return prompts;
};

const main = async (): Promise<void> => {
  const [stepPrompts, sources] = await Promise.all([loadStepPrompts(), loadAgentSources()]);
  const rolePrompts = new Map(sources.roles.map((role) => [role.name, role.rolePrompt]));
  const roleNames = [...rolePrompts.keys()];

  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(async (tx) => {
      const templates = await tx.taskTemplate.findMany({
        where: { name: INTEGRATOR_TEMPLATE_NAME },
        select: { id: true },
      });
      if (templates.length === 0) throw new Error(`Template ${INTEGRATOR_TEMPLATE_NAME} was not found`);
      const templateIds = templates.map((template) => template.id);
      const updatedSteps: Record<number, number> = {};
      for (const stepIndex of [...stepPrompts.keys()].sort((left, right) => left - right)) {
        const prompt = stepPrompts.get(stepIndex)!;
        const present = await tx.taskTemplateStep.count({
          where: { taskTemplateId: { in: templateIds }, stepIndex },
        });
        if (present !== templates.length) {
          throw new Error(`Expected step ${stepIndex} on ${templates.length} canonical templates; found ${present}`);
        }
        updatedSteps[stepIndex] = (await tx.taskTemplateStep.updateMany({
          where: { taskTemplateId: { in: templateIds }, stepIndex, prompt: { not: prompt } },
          data: { prompt },
        })).count;
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
      return { templates: templates.length, updatedSteps, updatedRoles };
    });
    const updated = Object.values(result.updatedSteps).reduce((sum, count) => sum + count, 0)
      + Object.values(result.updatedRoles).reduce((sum, count) => sum + count, 0);
    console.log(JSON.stringify({ ...result, updated }));
  } finally {
    await prisma.$disconnect();
  }
};

await main();
