import { AssigneeType, Prisma, PrismaClient } from "@prisma/client";

import { CANONICAL_TEMPLATE_STEPS } from "../src/agent-contract.js";
import { loadAgentSources } from "../src/agent-sources.js";

// The loader this seed used to carry moved to `packages/db/src/agent-sources.ts`
// so that OSS-B0's first-run onboarding can read the same `agents/` contract
// without running this seed, which creates the internal multi-role
// installation. Nothing this file seeds changed with the move.
const prisma = new PrismaClient();

const main = async (): Promise<void> => {
  const sources = await loadAgentSources();
  const project = await prisma.project.upsert({
    where: { slug: "agentos-example" },
    update: {},
    create: {
      name: "AgentOS Example",
      slug: "agentos-example",
      yamlDocument: "# Managed by AgentOS; YAML sync arrives after v1.\n",
    },
  });

  const environment = await prisma.environment.upsert({
    where: { projectId_name: { projectId: project.id, name: "local" } },
    update: {},
    create: {
      projectId: project.id,
      name: "local",
      networking: "OPEN",
      allowedHosts: [],
    },
  });

  for (const role of sources.roles) {
    await prisma.agent.upsert({
      where: { projectId_name: { projectId: project.id, name: role.name } },
      update: {
        environmentId: environment.id,
        title: role.title,
        model: role.model,
        runnerPreference: role.runnerPreference,
        inboxAccess: role.inboxAccess,
        foundationalPrompt: sources.foundationalPrompt,
        rolePrompt: role.rolePrompt,
      },
      create: {
        projectId: project.id,
        environmentId: environment.id,
        name: role.name,
        title: role.title,
        model: role.model,
        runnerPreference: role.runnerPreference,
        inboxAccess: role.inboxAccess,
        foundationalPrompt: sources.foundationalPrompt,
        rolePrompt: role.rolePrompt,
      },
    });
  }

  const agentByName = new Map((await prisma.agent.findMany({ where: { projectId: project.id } })).map((agent) => [agent.name, agent]));
  const skillBySlug = new Map<string, { id: string }>();
  for (const skill of sources.skills) {
    const record = await prisma.skill.upsert({
      where: { projectId_slug: { projectId: project.id, slug: skill.slug } },
      update: { name: skill.name, kind: skill.kind, body: skill.body, filePath: null },
      create: { projectId: project.id, name: skill.name, slug: skill.slug, kind: skill.kind, body: skill.body },
    });
    skillBySlug.set(skill.slug, record);
  }
  const seededAgentIds = sources.roles.map((role) => {
    const agent = agentByName.get(role.name);
    if (!agent) throw new Error(`Missing seeded agent ${role.name}`);
    return agent.id;
  });
  await prisma.agentSkill.deleteMany({ where: { agentId: { in: seededAgentIds } } });
  await prisma.agentCollaboration.deleteMany({ where: { agentId: { in: seededAgentIds } } });
  for (const role of sources.roles) {
    const agent = agentByName.get(role.name)!;
    for (const slug of role.skills) {
      const skill = skillBySlug.get(slug);
      if (!skill) throw new Error(`Agent ${role.name} references unknown skill ${slug}`);
      await prisma.agentSkill.create({ data: { agentId: agent.id, skillId: skill.id, projectId: project.id } });
    }
    for (const collaboratorName of role.collaborators) {
      const collaborator = agentByName.get(collaboratorName);
      if (!collaborator || !seededAgentIds.includes(collaborator.id)) {
        throw new Error(`Agent ${role.name} references unknown collaborator ${collaboratorName}`);
      }
      await prisma.agentCollaboration.create({
        data: { agentId: agent.id, allowedAgentId: collaborator.id, projectId: project.id },
      });
    }
  }
  const template = await prisma.taskTemplate.upsert({
    where: { projectId_name: { projectId: project.id, name: "compound-engineer-workflow" } },
    update: {
      description: "Twelve-step Full Assurance workflow with dual independent code review, regression verification, human approval, and mechanical merge execution.",
      variables: ["branchName"],
    },
    create: {
      projectId: project.id,
      name: "compound-engineer-workflow",
      description: "Twelve-step Full Assurance workflow with dual independent code review, regression verification, human approval, and mechanical merge execution.",
      variables: ["branchName"],
    },
  });
  const canonicalStep = (stepIndex: number) => {
    const step = CANONICAL_TEMPLATE_STEPS.find((candidate) => candidate.stepIndex === stepIndex);
    if (!step) throw new Error(`Missing canonical template step ${stepIndex}`);
    return step;
  };
  // The tuple carries `opensPullRequest` as its tenth element and both branches
  // of the upsert set it. `templates.ts` copies the value onto every materialized
  // task row. Only implementation creates the chain PR; every later row reuses it.
  const steps = [
    [1, "Write a spec", canonicalStep(1).agentName, AssigneeType.AGENT, null, canonicalStep(1).approvalGate, canonicalStep(1).outputKind, "Write a detailed feature specification for {{branchName}} and persist it for human approval.", null, canonicalStep(1).opensPullRequest],
    [2, "Plan", canonicalStep(2).agentName, AssigneeType.AGENT, null, canonicalStep(2).approvalGate, canonicalStep(2).outputKind, "Turn the approved spec into a concrete ordered implementation plan.", null, canonicalStep(2).opensPullRequest],
    [3, "Plan review", canonicalStep(3).agentName, AssigneeType.AGENT, null, canonicalStep(3).approvalGate, canonicalStep(3).outputKind, "Review the plan through feasibility, scope, coherence, security, and a distinct risk-focused verification pass; consolidate must-fix and should-fix findings.", null, canonicalStep(3).opensPullRequest],
    [4, "Revise plan", canonicalStep(4).agentName, AssigneeType.AGENT, null, canonicalStep(4).approvalGate, canonicalStep(4).outputKind, "Revise the plan using every must-fix plan-review finding and persist the implementation-authority artifact.", null, canonicalStep(4).opensPullRequest],
    [5, "Implementation", canonicalStep(5).agentName, AssigneeType.AGENT, null, canonicalStep(5).approvalGate, canonicalStep(5).outputKind, "Implement the approved plan on {{branchName}} and run end-to-end tests.", null, canonicalStep(5).opensPullRequest],
    [6, "Code review (Sol)", canonicalStep(6).agentName, AssigneeType.AGENT, null, canonicalStep(6).approvalGate, canonicalStep(6).outputKind, "Review the complete integrated implementation diff from the frozen pre-implementation base through the delivered head. Persist stable evidence-backed findings as the task output.", null, canonicalStep(6).opensPullRequest],
    [7, "Code review and adjudication (Opus)", canonicalStep(7).agentName, AssigneeType.AGENT, null, canonicalStep(7).approvalGate, canonicalStep(7).outputKind, "Blind-review the complete integrated implementation diff and persist independent findings before reading the first review. Then apply the canonical merge matrix and persist the closed must-fix list.", null, canonicalStep(7).opensPullRequest],
    [8, "Apply review fixes", canonicalStep(8).agentName, AssigneeType.AGENT, null, canonicalStep(8).approvalGate, canonicalStep(8).outputKind, "Apply the complete closed must-fix list and rerun every affected regression.", null, canonicalStep(8).opensPullRequest],
    [9, "Regression verification", canonicalStep(9).agentName, AssigneeType.AGENT, null, canonicalStep(9).approvalGate, canonicalStep(9).outputKind, "Review the full fix diff as one unit, account for every must-fix ID, rerun relevant regressions, and bind the verdict to the exact fixed head for human review.", null, canonicalStep(9).opensPullRequest],
    [10, "Librarian", canonicalStep(10).agentName, AssigneeType.AGENT, null, canonicalStep(10).approvalGate, canonicalStep(10).outputKind, "Update internal documentation to match the delivered code.", null, canonicalStep(10).opensPullRequest],
    [11, "Human PR review", canonicalStep(11).agentName, AssigneeType.HUMAN, null, canonicalStep(11).approvalGate, canonicalStep(11).outputKind, "Review the pull request for {{branchName}} at the exact head approved by regression verification and authorize its merge against the evidence presented in the approval card.", null, canonicalStep(11).opensPullRequest],
    [12, "Merge execution", canonicalStep(12).agentName, AssigneeType.AGENT, null, canonicalStep(12).approvalGate, canonicalStep(12).outputKind, "Execute the authorized merge mechanically. No model runs this step: @agentos/merge-executor claims it, re-verifies every precondition against the live pull request, and merges only under the step-11 human authorization for that exact head.", null, canonicalStep(12).opensPullRequest],
  ] as const;
  for (const [stepIndex, name, agentName, assigneeType, runner, approvalGate, outputKind, prompt, spawnPolicy, opensPullRequest] of steps) {
    const assigneeAgentId: string | null = agentName ? (agentByName.get(agentName)?.id ?? null) : null;
    if (agentName && !assigneeAgentId) throw new Error(`Missing seeded agent ${agentName}`);
    await prisma.taskTemplateStep.upsert({
      where: { taskTemplateId_stepIndex: { taskTemplateId: template.id, stepIndex } },
      update: { name, assigneeAgentId, assigneeType, runner, approvalGate, outputKind, prompt, opensPullRequest, attachmentsFromPrevious: stepIndex > 1, spawnPolicy: spawnPolicy ?? Prisma.JsonNull },
      create: { taskTemplateId: template.id, stepIndex, name, assigneeAgentId, assigneeType, runner, approvalGate, outputKind, prompt, opensPullRequest, attachmentsFromPrevious: stepIndex > 1, spawnPolicy: spawnPolicy ?? Prisma.JsonNull },
    });
  }

  console.log(`Seeded ${project.name} from agents/ with ${sources.roles.length} agents, ${sources.skills.length} skills, and the twelve-step feature template.`);
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
