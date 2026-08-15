import { AssigneeType, Prisma, PrismaClient, RunnerKind, RunnerPreference } from "@prisma/client";

const prisma = new PrismaClient();

const foundationalPrompt = `You are an AgentOS worker. Work only on the assigned task in the provided working directory. Record useful progress in the task activity stream, obey the task scope, and finish with a concise result. Access that is not explicitly granted is denied.`;

// These role prompts are reconstructed from BLUEPRINT.md; they are not Danny
// Postma's verbatim prompts.
const agents = [
  ["default", "Default", "claude", RunnerPreference.CLAUDE, "Complete the assigned general task."],
  ["plan", "Planner", "claude", RunnerPreference.CLAUDE, "Turn an approved spec into a concrete ordered implementation plan."],
  ["spec", "Specification Writer", "claude", RunnerPreference.CLAUDE, "Produce a detailed feature specification for human review."],
  ["senior-dev", "Senior Developer", "codex", RunnerPreference.CODEX, "Implement scoped work or apply review fixes."],
  ["review-coordinator", "Review Coordinator", "claude", RunnerPreference.CLAUDE, "Coordinate specialist review and consolidate findings."],
  ["feasibility", "Feasibility Reviewer", "claude", RunnerPreference.CLAUDE, "Review a plan for technical feasibility."],
  ["scope-guardian", "Scope Guardian", "claude", RunnerPreference.CLAUDE, "Review a plan for unnecessary scope expansion."],
  ["coherence", "Coherence Reviewer", "claude", RunnerPreference.CLAUDE, "Review a plan for internal coherence and missing links."],
  ["implementation-plan-executioner", "Implementation Plan Executioner", "codex", RunnerPreference.CODEX, "Implement the approved plan faithfully."],
  ["librarian", "Librarian", "openai-codex/gpt-5.6-luna", RunnerPreference.PI, "Update internal documentation from how the codebase actually works."],
] as const;

const main = async (): Promise<void> => {
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

  for (const [name, title, model, runnerPreference, rolePrompt] of agents) {
    await prisma.agent.upsert({
      where: { projectId_name: { projectId: project.id, name } },
      update: { title, model, runnerPreference, rolePrompt },
      create: {
        projectId: project.id,
        environmentId: environment.id,
        name,
        title,
        model,
        runnerPreference,
        foundationalPrompt,
        rolePrompt,
      },
    });
  }

  const agentByName = new Map((await prisma.agent.findMany({ where: { projectId: project.id } })).map((agent) => [agent.name, agent]));
  const template = await prisma.taskTemplate.upsert({
    where: { projectId_name: { projectId: project.id, name: "compound-engineer-workflow" } },
    update: {
      description: "Nine-step managed feature workflow with spec, plan, and PR approval gates.",
      variables: ["branchName"],
    },
    create: {
      projectId: project.id,
      name: "compound-engineer-workflow",
      description: "Nine-step managed feature workflow with spec, plan, and PR approval gates.",
      variables: ["branchName"],
    },
  });
  const steps = [
    [1, "Write a spec", "spec", AssigneeType.AGENT, RunnerKind.CLAUDE, true, "spec", "Write a detailed feature specification for {{branchName}} and persist it for human approval.", null],
    [2, "Plan", "plan", AssigneeType.AGENT, RunnerKind.CLAUDE, false, "plan", "Turn the approved spec into a concrete ordered implementation plan.", null],
    [3, "Plan review", "review-coordinator", AssigneeType.AGENT, RunnerKind.CLAUDE, false, "plan-review", "Coordinate four independent plan reviews and consolidate must-fix and should-fix findings.", { reviewers: ["feasibility", "scope-guardian", "coherence", "feasibility"], mode: "parallel", reconstructedFourthPass: true }],
    [4, "Revise plan", "plan", AssigneeType.AGENT, RunnerKind.CLAUDE, false, "revised-plan", "Revise the plan using every must-fix plan-review finding.", null],
    [5, "Implementation", "implementation-plan-executioner", AssigneeType.AGENT, RunnerKind.CODEX, false, "implementation", "Implement the approved plan on {{branchName}} and run end-to-end tests.", null],
    [6, "Code review", "review-coordinator", AssigneeType.AGENT, RunnerKind.CLAUDE, false, "code-review", "Review the implementation and consolidate must-fix and should-fix findings.", null],
    [7, "Apply review fixes", "senior-dev", AssigneeType.AGENT, RunnerKind.CODEX, false, "fixed-implementation", "Apply all must-fix review findings and rerun end-to-end tests.", null],
    [8, "Librarian", "librarian", AssigneeType.AGENT, RunnerKind.PI, false, "documentation", "Update internal documentation to match the delivered code.", null],
    [9, "Human PR review", null, AssigneeType.HUMAN, null, true, "approval", "Review and merge the pull request for {{branchName}}.", null],
  ] as const;
  for (const [stepIndex, name, agentName, assigneeType, runner, approvalGate, outputKind, prompt, spawnPolicy] of steps) {
    const assigneeAgentId: string | null = agentName ? (agentByName.get(agentName)?.id ?? null) : null;
    if (agentName && !assigneeAgentId) throw new Error(`Missing seeded agent ${agentName}`);
    await prisma.taskTemplateStep.upsert({
      where: { taskTemplateId_stepIndex: { taskTemplateId: template.id, stepIndex } },
      update: { name, assigneeAgentId, assigneeType, runner, approvalGate, outputKind, prompt, attachmentsFromPrevious: stepIndex > 1, spawnPolicy: spawnPolicy ?? Prisma.JsonNull },
      create: { taskTemplateId: template.id, stepIndex, name, assigneeAgentId, assigneeType, runner, approvalGate, outputKind, prompt, attachmentsFromPrevious: stepIndex > 1, spawnPolicy: spawnPolicy ?? Prisma.JsonNull },
    });
  }

  console.log(`Seeded ${project.name} with ${agents.length} agents and the nine-step feature template.`);
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
