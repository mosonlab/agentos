import { PrismaClient, RunnerPreference, TaskStatus } from "@prisma/client";

import { loadAgentSources, roleSourceStructureDifferences } from "../src/agent-sources.js";
import { loadAllTemplateStepSources, templateStepStructureDifferences } from "../src/template-sources.js";

const REGRESSION_AGENT_NAME = "regression-verifier";
const REGRESSION_AGENT_SOURCE = "review-coordinator-sol";
type AssigneeTransition = { from: readonly string[]; to: string };
const ASSIGNEE_TRANSITIONS = new Map<string, AssigneeTransition>([
  ["compound-engineer-workflow:9", { from: ["review-coordinator-opus", "review-coordinator-sol"], to: REGRESSION_AGENT_NAME }],
  ["direct-engineer-workflow:5", { from: ["review-coordinator-opus", "review-coordinator-sol"], to: REGRESSION_AGENT_NAME }],
]);

const STEP_NAME_TRANSITIONS = new Map([
  ["compound-engineer-workflow:11", { from: "Merge readiness", to: "Merge authorization" }],
  ["direct-engineer-workflow:6", { from: "Merge readiness", to: "Merge authorization" }],
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
      let createdAgents = 0;
      let createdAgentRepoGrants = 0;
      const regressionRole = rolesByName.get(REGRESSION_AGENT_NAME);
      if (!regressionRole) throw new Error(`Canonical role ${REGRESSION_AGENT_NAME} was not found`);
      const existingRegressionAgent = await tx.agent.findUnique({
        where: { projectId_name: { projectId: canonicalProject.id, name: REGRESSION_AGENT_NAME } },
        select: { id: true, archivedAt: true },
      });
      if (existingRegressionAgent?.archivedAt) {
        throw new Error(`Canonical Agent ${REGRESSION_AGENT_NAME} is archived; sync will not resurrect it`);
      }
      if (!existingRegressionAgent) {
        const source = await tx.agent.findUnique({
          where: { projectId_name: { projectId: canonicalProject.id, name: REGRESSION_AGENT_SOURCE } },
          select: {
            environmentId: true,
            disabledTools: true,
            archivedAt: true,
            repoAccess: { select: { projectId: true, repoId: true, mountPath: true, permissions: true } },
          },
        });
        if (!source || source.archivedAt) {
          throw new Error(`Cannot create ${REGRESSION_AGENT_NAME}: active source Agent ${REGRESSION_AGENT_SOURCE} was not found`);
        }
        const created = await tx.agent.create({ data: {
          projectId: canonicalProject.id,
          environmentId: source.environmentId,
          name: regressionRole.name,
          title: regressionRole.title,
          model: regressionRole.model,
          runnerPreference: regressionRole.runnerPreference,
          inboxAccess: regressionRole.inboxAccess,
          disabledTools: source.disabledTools,
          foundationalPrompt: sources.foundationalPrompt,
          rolePrompt: regressionRole.rolePrompt,
        } });
        if (source.repoAccess.length > 0) {
          createdAgentRepoGrants = (await tx.agentRepoAccess.createMany({ data: source.repoAccess.map((grant) => ({
            ...grant,
            agentId: created.id,
          })) })).count;
        }
        createdAgents = 1;
      }
      const updatedSteps: Record<string, Record<number, number>> = {};
      let adoptedAssignees = 0;
      let renamedSteps = 0;
      let templateCount = 0;
      const regressionSteps: Array<{ id: string; projectId: string }> = [];
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
              name: true,
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
              && transition?.from.includes(persisted.assigneeAgent?.name ?? "") === true
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
            const nameTransition = STEP_NAME_TRANSITIONS.get(`${templateName}:${step.stepIndex}`);
            if (nameTransition?.from === persisted.name) {
              await tx.taskTemplateStep.update({
                where: { id: persisted.id },
                data: { name: nameTransition.to },
              });
              renamedSteps += 1;
            }
            if (step.agentName === REGRESSION_AGENT_NAME) {
              const projectId = templates.find(({ id }) => id === persisted.taskTemplateId)?.projectId;
              if (!projectId) throw new Error(`Template project was not found for regression step ${persisted.id}`);
              regressionSteps.push({ id: persisted.id, projectId });
            }
          }
          updated[step.stepIndex] = (await tx.taskTemplateStep.updateMany({
            where: { taskTemplateId: { in: templateIds }, stepIndex: step.stepIndex, prompt: { not: step.prompt } },
            data: { prompt: step.prompt },
          })).count;
        }
        updatedSteps[templateName] = updated;
      }

      let migratedTasks = 0;
      const preservedTaskAssignments = { archived: 0, nonTodo: 0, started: 0, output: 0 };
      for (const step of regressionSteps) {
        const target = await tx.agent.findFirst({
          where: { projectId: step.projectId, name: REGRESSION_AGENT_NAME, archivedAt: null },
          select: { id: true },
        });
        if (!target) throw new Error(`Regression step ${step.id} has no active ${REGRESSION_AGENT_NAME} in its project`);
        const tasks = await tx.task.findMany({
          where: {
            templateStepId: step.id,
            assigneeAgent: { name: { in: ["review-coordinator-opus", "review-coordinator-sol"] } },
          },
          select: {
            id: true,
            assigneeAgentId: true,
            status: true,
            archivedAt: true,
            _count: { select: { runs: true, sessions: true } },
            stepOutput: { select: { id: true } },
          },
        });
        for (const task of tasks) {
          if (task.archivedAt) {
            preservedTaskAssignments.archived += 1;
            continue;
          }
          if (task.status !== TaskStatus.TODO) {
            preservedTaskAssignments.nonTodo += 1;
            continue;
          }
          if (task._count.runs > 0 || task._count.sessions > 0) {
            preservedTaskAssignments.started += 1;
            continue;
          }
          if (task.stepOutput) {
            preservedTaskAssignments.output += 1;
            continue;
          }
          const adopted = await tx.task.updateMany({
            where: {
              id: task.id,
              assigneeAgentId: task.assigneeAgentId,
              status: TaskStatus.TODO,
              archivedAt: null,
              runs: { none: {} },
              sessions: { none: {} },
              stepOutput: { is: null },
            },
            data: { assigneeAgentId: target.id },
          });
          if (adopted.count !== 1) throw new Error(`Regression task ${task.id} changed while canonical routing was being adopted`);
          await tx.taskActivity.create({ data: {
            taskId: task.id,
            actorType: "control-plane",
            body: `Canonical routing reassigned this unstarted regression step to ${REGRESSION_AGENT_NAME}`,
            metadata: {
              kind: "canonicalRouting.regressionVerifier",
              schemaVersion: 1,
              fromAgentId: task.assigneeAgentId,
              toAgentId: target.id,
            },
          } });
          migratedTasks += 1;
        }
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
      return {
        templates: templateCount,
        createdAgents,
        createdAgentRepoGrants,
        adoptedAssignees,
        renamedSteps,
        migratedTasks,
        preservedTaskAssignments,
        adoptedAgentDefaults,
        updatedSteps,
        updatedRoles,
      };
    });
    const updated = result.createdAgents + result.createdAgentRepoGrants + result.adoptedAssignees
      + result.renamedSteps + result.migratedTasks + result.adoptedAgentDefaults + Object.values(result.updatedSteps)
      .flatMap((byStep) => Object.values(byStep))
      .reduce((sum, count) => sum + count, 0)
      + Object.values(result.updatedRoles).reduce((sum, count) => sum + count, 0);
    console.log(JSON.stringify({ ...result, updated }));
  } finally {
    await prisma.$disconnect();
  }
};

await main();
