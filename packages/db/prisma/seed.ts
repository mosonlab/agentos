import { PrismaClient, RunnerPreference } from "@prisma/client";

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

  console.log(`Seeded ${project.name} with ${agents.length} agents.`);
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
