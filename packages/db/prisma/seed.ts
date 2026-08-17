import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { AssigneeType, Prisma, PrismaClient, RunnerKind, RunnerPreference, SkillKind } from "@prisma/client";

import { assertCanonicalAgentSources, CANONICAL_TEMPLATE_STEPS } from "./agent-contract.js";

const prisma = new PrismaClient();

const agentsRoot = fileURLToPath(new URL("../../../agents/", import.meta.url));

type FrontmatterDocument = { attributes: Record<string, string>; body: string };
type RoleSource = {
  name: string;
  title: string;
  model: string;
  runnerPreference: RunnerPreference;
  inboxAccess: boolean;
  skills: string[];
  collaborators: string[];
  rolePrompt: string;
};

const parseDocument = (source: string, filePath: string): FrontmatterDocument => {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new Error(`${filePath} must start with frontmatter`);
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new Error(`${filePath} has unterminated frontmatter`);
  const attributes: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`${filePath} has invalid frontmatter line: ${line}`);
    attributes[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { attributes, body: normalized.slice(end + 5).trim() };
};

const required = (document: FrontmatterDocument, key: string, filePath: string): string => {
  const value = document.attributes[key];
  if (!value) throw new Error(`${filePath} is missing ${key}`);
  return value;
};

const parseList = (value: string | undefined, filePath: string, key: string): string[] => {
  if (value === undefined) throw new Error(`${filePath} is missing ${key}`);
  if (!value.startsWith("[") || !value.endsWith("]")) throw new Error(`${filePath} ${key} must be an inline list`);
  const content = value.slice(1, -1).trim();
  return content === "" ? [] : content.split(",").map((item) => item.trim()).filter(Boolean);
};

const runnerPreference = (value: string, filePath: string): RunnerPreference => {
  const runner = value.toUpperCase();
  if (!(runner in RunnerPreference)) throw new Error(`${filePath} has unsupported runner ${value}`);
  return RunnerPreference[runner as keyof typeof RunnerPreference];
};

const loadAgentSources = async () => {
  const foundationalFile = `${agentsRoot}foundational.md`;
  const foundationalPrompt = parseDocument(await readFile(foundationalFile, "utf8"), foundationalFile).body;
  const roleDirectory = `${agentsRoot}roles`;
  const roleFiles = (await readdir(roleDirectory)).filter((name) => name.endsWith(".md")).sort();
  const roles: RoleSource[] = [];
  for (const filename of roleFiles) {
    const filePath = `${roleDirectory}/${filename}`;
    const document = parseDocument(await readFile(filePath, "utf8"), filePath);
    const inboxAccess = required(document, "inboxAccess", filePath);
    if (inboxAccess !== "true" && inboxAccess !== "false") throw new Error(`${filePath} inboxAccess must be true or false`);
    roles.push({
      name: required(document, "name", filePath),
      title: required(document, "title", filePath),
      model: required(document, "model", filePath),
      runnerPreference: runnerPreference(required(document, "runner", filePath), filePath),
      inboxAccess: inboxAccess === "true",
      skills: parseList(document.attributes.skills, filePath, "skills"),
      collaborators: parseList(document.attributes.collaborators, filePath, "collaborators"),
      rolePrompt: document.body,
    });
  }
  assertCanonicalAgentSources(roles);

  const skillDirectory = `${agentsRoot}skills`;
  const skillFiles = (await readdir(skillDirectory)).filter((name) => name.endsWith(".md")).sort();
  const skills = [];
  for (const filename of skillFiles) {
    const filePath = `${skillDirectory}/${filename}`;
    const document = parseDocument(await readFile(filePath, "utf8"), filePath);
    const kind = required(document, "kind", filePath).toUpperCase();
    if (!(kind in SkillKind)) throw new Error(`${filePath} has unsupported skill kind ${kind}`);
    skills.push({
      name: required(document, "name", filePath),
      slug: required(document, "slug", filePath),
      kind: SkillKind[kind as keyof typeof SkillKind],
      body: document.body,
    });
  }
  if (skills.length !== 2) throw new Error(`agents/ contract requires 2 skills; found ${skills.length}`);
  return { foundationalPrompt, roles, skills };
};

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
  const canonicalStep = (stepIndex: number) => {
    const step = CANONICAL_TEMPLATE_STEPS.find((candidate) => candidate.stepIndex === stepIndex);
    if (!step) throw new Error(`Missing canonical template step ${stepIndex}`);
    return step;
  };
  const steps = [
    [1, "Write a spec", canonicalStep(1).agentName, AssigneeType.AGENT, null, true, canonicalStep(1).outputKind, "Write a detailed feature specification for {{branchName}} and persist it for human approval.", null],
    [2, "Plan", canonicalStep(2).agentName, AssigneeType.AGENT, null, false, canonicalStep(2).outputKind, "Turn the approved spec into a concrete ordered implementation plan.", null],
    [3, "Plan review", canonicalStep(3).agentName, AssigneeType.AGENT, null, false, canonicalStep(3).outputKind, "Review the plan through feasibility, scope, coherence, and a distinct high-risk feasibility pass; consolidate must-fix and should-fix findings.", null],
    [4, "Revise plan", canonicalStep(4).agentName, AssigneeType.AGENT, null, false, canonicalStep(4).outputKind, "Revise the plan using every must-fix plan-review finding.", null],
    [5, "Implementation", canonicalStep(5).agentName, AssigneeType.AGENT, null, false, canonicalStep(5).outputKind, "Implement the approved plan on {{branchName}} and run end-to-end tests.", null],
    [6, "Code review", canonicalStep(6).agentName, AssigneeType.AGENT, null, false, canonicalStep(6).outputKind, "Review the implementation through feasibility, scope, coherence, and a distinct high-risk feasibility pass; consolidate must-fix and should-fix findings.", null],
    [7, "Apply review fixes", canonicalStep(7).agentName, AssigneeType.AGENT, null, false, canonicalStep(7).outputKind, "Apply all must-fix review findings and rerun end-to-end tests.", null],
    [8, "Librarian", canonicalStep(8).agentName, AssigneeType.AGENT, null, false, canonicalStep(8).outputKind, "Update internal documentation to match the delivered code.", null],
    [9, "Human PR review", canonicalStep(9).agentName, AssigneeType.HUMAN, null, true, canonicalStep(9).outputKind, "Review and merge the pull request for {{branchName}}.", null],
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

  console.log(`Seeded ${project.name} from agents/ with ${sources.roles.length} agents, ${sources.skills.length} skills, and the nine-step feature template.`);
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
