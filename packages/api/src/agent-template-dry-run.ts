import { PrismaClient, RepoPermission } from "@agentos/db";

import { instantiateTemplate } from "./templates.js";

const databaseUrl = process.env.DATABASE_URL;
if (process.env.AGENT_TEMPLATE_DRY_RUN !== "1" || !databaseUrl) {
  throw new Error("Set AGENT_TEMPLATE_DRY_RUN=1 and an isolated DATABASE_URL to run this check");
}
const schema = new URL(databaseUrl).searchParams.get("schema");
if (!schema || !/^agentos_w1_contract_[0-9]{8}_[0-9]{2}$/u.test(schema)) {
  throw new Error(`Refusing to dry-run outside an isolated contract schema: ${schema ?? "missing"}`);
}

const db = new PrismaClient();

const main = async (): Promise<void> => {
  const project = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const template = await db.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "compound-engineer-workflow" } },
  });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "contract-dry-run",
    remoteUrl: "https://example.invalid/agentos-contract.git",
    mountPath: "/tmp/agentos-contract-dry-run",
    defaultBranch: "master",
  } });
  const agents = await db.agent.findMany({ where: { projectId: project.id, archivedAt: null } });
  await db.agentRepoAccess.createMany({ data: agents.map((agent) => ({
    agentId: agent.id,
    repoId: repo.id,
    projectId: project.id,
    mountPath: "/workspace/contract-dry-run",
    permissions: RepoPermission.GIT_WRITE,
  })) });
  const result = await instantiateTemplate(db, project.id, template.id, {
    repoId: repo.id,
    variables: { branchName: "codex/w1-contract-dry-run" },
    name: "W1 contract dry-run",
  });
  const first = await db.task.findFirstOrThrow({
    where: { chainId: result.chainId, chainIndex: 1 },
    include: { runs: true, assigneeAgent: true },
  });
  const run = first.runs[0];
  const integrator = await db.task.findFirstOrThrow({
    where: { chainId: result.chainId, chainIndex: 10 },
    include: { assigneeAgent: true, runs: true },
  });
  if (result.tasks.length !== 10 || !run || run.runner !== "CLAUDE"
    || run.model !== "claude-fable-5:medium" || first.assigneeAgent?.name !== "spec") {
    throw new Error(`Unexpected dry-run result: ${JSON.stringify({
      taskCount: result.tasks.length,
      agent: first.assigneeAgent?.name,
      runner: run?.runner,
      model: run?.model,
    })}`);
  }
  if (integrator.assigneeAgent?.name !== "merge-integrator" || integrator.opensPullRequest || integrator.runs.length !== 0) {
    throw new Error("Canonical step 10 must be an unqueued, no-PR mechanical merge-integrator task");
  }
  process.stdout.write(`Dry-run instantiated ${result.tasks.length} steps; first Run=${run.runner}/${run.model}.\n`);
};

try {
  await main();
} finally {
  await db.$disconnect();
}
