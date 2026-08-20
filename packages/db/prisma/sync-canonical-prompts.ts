import { PrismaClient } from "@prisma/client";

import { loadAgentSources } from "../src/agent-sources.js";
import { loadAllTemplateStepSources } from "../src/template-sources.js";

// Every canonical template, every step of each, and every role under agents/
// is synced. Omitting any source here would let a prompt edit silently miss
// production, so the loader owns the complete template inventory.
const main = async (): Promise<void> => {
  const [templateSources, sources] = await Promise.all([loadAllTemplateStepSources(), loadAgentSources()]);
  const rolePrompts = new Map(sources.roles.map((role) => [role.name, role.rolePrompt]));
  const roleNames = [...rolePrompts.keys()];

  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(async (tx) => {
      const updatedSteps: Record<string, Record<number, number>> = {};
      let templateCount = 0;
      for (const [templateName, steps] of templateSources) {
        const templates = await tx.taskTemplate.findMany({
          where: { name: templateName },
          select: { id: true },
        });
        if (templates.length === 0) throw new Error(`Template ${templateName} was not found`);
        templateCount += templates.length;
        const templateIds = templates.map((template) => template.id);
        const present = await tx.taskTemplateStep.count({ where: { taskTemplateId: { in: templateIds } } });
        const expected = templates.length * steps.length;
        if (present !== expected) {
          throw new Error(`Expected ${expected} total steps on ${templates.length} ${templateName} templates; found ${present}`);
        }

        const updated: Record<number, number> = {};
        for (const step of steps) {
          const stepCount = await tx.taskTemplateStep.count({
            where: { taskTemplateId: { in: templateIds }, stepIndex: step.stepIndex },
          });
          if (stepCount !== templates.length) {
            throw new Error(`Expected step ${step.stepIndex} on ${templates.length} ${templateName} templates; found ${stepCount}`);
          }
          updated[step.stepIndex] = (await tx.taskTemplateStep.updateMany({
            where: { taskTemplateId: { in: templateIds }, stepIndex: step.stepIndex, prompt: { not: step.prompt } },
            data: { prompt: step.prompt },
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
