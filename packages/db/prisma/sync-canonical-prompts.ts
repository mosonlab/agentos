import { PrismaClient, RunnerPreference } from "@prisma/client";

import { loadAgentSources, roleSourceStructureDifferences } from "../src/agent-sources.js";
import { loadAllTemplateStepSources, templateStepStructureDifferences } from "../src/template-sources.js";

const ASSIGNEE_TRANSITIONS = new Map([
  ["compound-engineer-workflow:9", { from: "review-coordinator-opus", to: "review-coordinator-sol" }],
  ["direct-engineer-workflow:5", { from: "review-coordinator-opus", to: "review-coordinator-sol" }],
]);

const AGENT_TRANSITIONS = new Map([
  ["review-coordinator", {
    from: { model: "gpt-5.6-sol:high", runnerPreference: RunnerPreference.CODEX },
    to: { model: "openai-codex/gpt-5.6-sol:high", runnerPreference: RunnerPreference.PI },
  }],
  ["review-coordinator-sol", {
    from: { model: "gpt-5.6-sol:high", runnerPreference: RunnerPreference.CODEX },
    to: { model: "openai-codex/gpt-5.6-sol:high", runnerPreference: RunnerPreference.PI },
  }],
]);

// Every canonical template, every step of each, and every role under agents/
// is synced. Omitting any source here would let a prompt edit silently miss
// production, so the loader owns the complete template inventory.
const main = async (): Promise<void> => {
  const [templateSources, sources] = await Promise.all([loadAllTemplateStepSources(), loadAgentSources()]);
  const rolesByName = new Map(sources.roles.map((role) => [role.name, role]));
  const roleNames = [...rolesByName.keys()];

  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(async (tx) => {
      const canonicalProject = await tx.project.findUnique({
        where: { slug: "agentos-example" },
        select: { id: true },
      });
      if (!canonicalProject) throw new Error("Canonical project agentos-example was not found");
      const updatedSteps: Record<string, Record<number, number>> = {};
      let adoptedAssignees = 0;
      let templateCount = 0;
      for (const [templateName, steps] of templateSources) {
        const templates = await tx.taskTemplate.findMany({
          where: { name: templateName },
          select: { id: true, projectId: true },
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
          const persistedSteps = await tx.taskTemplateStep.findMany({
            where: { taskTemplateId: { in: templateIds }, stepIndex: step.stepIndex },
            select: {
              id: true,
              taskTemplateId: true,
              assigneeAgent: { select: { name: true } },
              assigneeType: true,
              approvalGate: true,
              outputKind: true,
              attachmentsFromPrevious: true,
              opensPullRequest: true,
              baseFromStepIndex: true,
              spawnPolicy: true,
            },
          });
          if (persistedSteps.length !== templates.length) {
            throw new Error(`Expected step ${step.stepIndex} on ${templates.length} ${templateName} templates; found ${persistedSteps.length}`);
          }
          for (const persisted of persistedSteps) {
            const differences = templateStepStructureDifferences(persisted, step);
            const transition = ASSIGNEE_TRANSITIONS.get(`${templateName}:${step.stepIndex}`);
            const adoptsCanonicalAssignee = differences.length === 1
              && differences[0] === "agent"
              && transition?.from === (persisted.assigneeAgent?.name ?? null)
              && transition.to === step.agentName;
            if (differences.length > 0 && !adoptsCanonicalAssignee) {
              throw new Error(`${templateName} step ${step.stepIndex} on template ${persisted.taskTemplateId} differs from canonical Markdown structure: ${differences.join(", ")}`);
            }
            if (adoptsCanonicalAssignee) {
              const projectId = templates.find(({ id }) => id === persisted.taskTemplateId)?.projectId;
              const assignee = projectId
                ? await tx.agent.findFirst({
                  where: { projectId, name: transition.to, archivedAt: null },
                  select: { id: true },
                })
                : null;
              if (!assignee) {
                throw new Error(`${templateName} step ${step.stepIndex} cannot adopt ${transition.to}: active target Agent was not found in the template project`);
              }
              await tx.taskTemplateStep.update({
                where: { id: persisted.id },
                data: { assigneeAgentId: assignee.id },
              });
              adoptedAssignees += 1;
            }
          }
          updated[step.stepIndex] = (await tx.taskTemplateStep.updateMany({
            where: { taskTemplateId: { in: templateIds }, stepIndex: step.stepIndex, prompt: { not: step.prompt } },
            data: { prompt: step.prompt },
          })).count;
        }
        updatedSteps[templateName] = updated;
      }

      const presentAgents = await tx.agent.findMany({
        where: { projectId: canonicalProject.id, archivedAt: null, name: { in: roleNames } },
        select: {
          id: true,
          name: true,
          title: true,
          model: true,
          runnerPreference: true,
          inboxAccess: true,
          collaborators: { select: { allowedAgent: { select: { name: true } } } },
        },
      });
      const agentsByName = new Map<string, typeof presentAgents>();
      for (const agent of presentAgents) {
        const matches = agentsByName.get(agent.name) ?? [];
        matches.push(agent);
        agentsByName.set(agent.name, matches);
      }
      for (const name of roleNames) {
        if (!agentsByName.has(name)) throw new Error(`Agent ${name} was not found`);
      }
      const updatedRoles: Record<string, number> = {};
      let adoptedAgentDefaults = 0;
      for (const name of roleNames) {
        const role = rolesByName.get(name)!;
        for (const agent of agentsByName.get(name)!) {
          const differences = roleSourceStructureDifferences(agent, role);
          const transition = AGENT_TRANSITIONS.get(name);
          const adoptsCanonicalDefaults = differences.length === 2
            && differences.includes("model")
            && differences.includes("runnerPreference")
            && transition?.from.model === agent.model
            && transition.from.runnerPreference === agent.runnerPreference
            && transition.to.model === role.model
            && transition.to.runnerPreference === role.runnerPreference;
          if (differences.length > 0 && !adoptsCanonicalDefaults) {
            throw new Error(`Agent ${name} (${agent.id}) differs from canonical Markdown structure: ${differences.join(", ")}`);
          }
          if (adoptsCanonicalDefaults) {
            await tx.agent.update({
              where: { id: agent.id },
              data: transition.to,
            });
            adoptedAgentDefaults += 1;
          }
        }
        updatedRoles[name] = (await tx.agent.updateMany({
          where: {
            projectId: canonicalProject.id,
            archivedAt: null,
            name,
            OR: [
              { foundationalPrompt: { not: sources.foundationalPrompt } },
              { rolePrompt: { not: role.rolePrompt } },
            ],
          },
          data: { foundationalPrompt: sources.foundationalPrompt, rolePrompt: role.rolePrompt },
        })).count;
      }
      return { templates: templateCount, adoptedAssignees, adoptedAgentDefaults, updatedSteps, updatedRoles };
    });
    const updated = result.adoptedAssignees + result.adoptedAgentDefaults + Object.values(result.updatedSteps)
      .flatMap((byStep) => Object.values(byStep))
      .reduce((sum, count) => sum + count, 0)
      + Object.values(result.updatedRoles).reduce((sum, count) => sum + count, 0);
    console.log(JSON.stringify({ ...result, updated }));
  } finally {
    await prisma.$disconnect();
  }
};

await main();
