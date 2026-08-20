import { AssigneeType, Prisma, PrismaClient } from "@prisma/client";

import { CANONICAL_TEMPLATE_STEPS } from "../src/agent-contract.js";
import { loadAgentSources } from "../src/agent-sources.js";
import {
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_TEMPLATE_NAME,
  legacyNineStepTemplateName,
  legacyTenStepTemplateName,
} from "../src/merge-integrator.js";

// The loader this seed used to carry moved to `packages/db/src/agent-sources.ts`
// so that OSS-B0's first-run onboarding can read the same `agents/` contract
// without running this seed, which creates the internal multi-role
// installation. Nothing this file seeds changed with the move.
const prisma = new PrismaClient();

const HISTORICAL_NINE_STEP_CONTRACT = [
  [1, "spec", AssigneeType.AGENT, "spec", true],
  [2, "plan", AssigneeType.AGENT, "plan", false],
  [3, "review-coordinator", AssigneeType.AGENT, "plan-review", false],
  [4, "plan-reviser", AssigneeType.AGENT, "revised-plan", true],
  [5, "implementation-plan-executioner", AssigneeType.AGENT, "implementation", false],
  [6, "review-coordinator", AssigneeType.AGENT, "code-review", false],
  [7, "senior-dev", AssigneeType.AGENT, "fixed-implementation", false],
  [8, "librarian", AssigneeType.AGENT, "documentation", false],
  [9, null, AssigneeType.HUMAN, "approval", true],
] as const;

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
  const seededAgentIds = sources.roles.map((role) => {
    const agent = agentByName.get(role.name);
    if (!agent) throw new Error(`Missing seeded agent ${role.name}`);
    return agent.id;
  });
  // The agents/ contract no longer seeds skills; this clears links a prior
  // seed created, so a re-seeded installation matches the contract.
  await prisma.agentSkill.deleteMany({ where: { agentId: { in: seededAgentIds } } });
  await prisma.agentCollaboration.deleteMany({ where: { agentId: { in: seededAgentIds } } });
  for (const role of sources.roles) {
    const agent = agentByName.get(role.name)!;
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
  const template = await prisma.$transaction(async (tx) => {
    const existing = await tx.taskTemplate.findUnique({
      where: { projectId_name: { projectId: project.id, name: INTEGRATOR_TEMPLATE_NAME } },
      include: { steps: { include: { assigneeAgent: { select: { name: true } } }, orderBy: { stepIndex: "asc" } } },
    });
    const historicalIntegrator = existing?.steps.find((step) => step.stepIndex === 10);
    const isHistoricalNineStepTemplate = existing?.steps.length === HISTORICAL_NINE_STEP_CONTRACT.length
      && HISTORICAL_NINE_STEP_CONTRACT.every(([stepIndex, agentName, assigneeType, outputKind, approvalGate], index) => {
        const step = existing.steps[index];
        return step?.stepIndex === stepIndex
          && (step.assigneeAgent?.name ?? null) === agentName
          && step.assigneeType === assigneeType
          && step.outputKind === outputKind
          && step.approvalGate === approvalGate;
      });
    const isHistoricalTenStepTemplate = existing?.steps.length === 10
      && existing.steps.every((step, index) => step.stepIndex === index + 1)
      && historicalIntegrator?.outputKind === INTEGRATOR_OUTPUT_KIND
      && historicalIntegrator.assigneeAgent?.name === INTEGRATOR_AGENT_NAME;

    // A historical 9- or 10-row template cannot be rewritten in place: its
    // in-flight tasks keep foreign keys to rows 6-10, whose meanings changed in
    // the 12-row routing contract. Preserve the entire template under a
    // seed-minted legacy identity; then the canonical upsert below creates a
    // new template for new Runs. Runtime mechanical recognition remains
    // limited to the marked 10-row shape, because the 9-row shape had no
    // integrator.
    const legacyName = existing && isHistoricalNineStepTemplate
      ? legacyNineStepTemplateName(existing.id)
      : existing && isHistoricalTenStepTemplate
        ? legacyTenStepTemplateName(existing.id)
        : null;
    if (existing && legacyName) {
      await tx.taskTemplate.update({
        where: { id: existing.id },
        data: { name: legacyName },
      });
    }

    return tx.taskTemplate.upsert({
      where: { projectId_name: { projectId: project.id, name: INTEGRATOR_TEMPLATE_NAME } },
      update: {
        description: "Twelve-step Full Assurance workflow with dual independent code review, regression verification, human approval, and mechanical merge execution.",
        variables: ["branchName"],
      },
      create: {
        projectId: project.id,
        name: INTEGRATOR_TEMPLATE_NAME,
        description: "Twelve-step Full Assurance workflow with dual independent code review, regression verification, human approval, and mechanical merge execution.",
        variables: ["branchName"],
      },
    });
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
    [2, "Plan", canonicalStep(2).agentName, AssigneeType.AGENT, null, canonicalStep(2).approvalGate, canonicalStep(2).outputKind, "Turn the approved spec into a tracer-bullet slice set engineered for parallel execution: many slices with empty blocked_by, a shallow critical path. Write the chain artifacts under `.chain/{{branchName}}/` on {{branchName}} — the approved spec copied to `spec.md`, one file per slice at `slices/<NN>-<slug>.md`, and this planning session's id in `sessions.md` under the label `plan_authoring`. Each slice file carries YAML frontmatter — `id` (unique, matching its file's `<NN>-<slug>`), `title`, `blocked_by` (a list of existing slice ids, never its own), `files_hint` (a list of repo-relative paths), `risk` (boolean, true exactly when the slice touches persisted data or an irreversible external action) — and body sections Delivers and Acceptance. Each slice cuts one demonstrable path through every layer it needs and fits a single fresh context window. blocked_by carries only true prerequisites and stays acyclic; slice boundaries keep files_hint overlap between independent slices rare. Stage a wide refactor as expand-migrate-contract slices rather than one tracer bullet. Every acceptance criterion is red at the frozen base and names the verification that turns it green. The plan is complete when every spec requirement maps to exactly one slice's Delivers and every file above is committed to {{branchName}}.", null, canonicalStep(2).opensPullRequest],
    [3, "Plan review", canonicalStep(3).agentName, AssigneeType.AGENT, null, canonicalStep(3).approvalGate, canonicalStep(3).outputKind, "Review every vertical slice against the approved specification and frozen base: standalone demonstration, layer coverage and context size, true blocked_by prerequisites, merge or split decisions, expand-migrate-contract staging for wide refactors, and acceptance criteria that fail at base and turn green under the named verification.", null, canonicalStep(3).opensPullRequest],
    [4, "Revise plan", canonicalStep(4).agentName, AssigneeType.AGENT, null, canonicalStep(4).approvalGate, canonicalStep(4).outputKind, "Attempt to resume the planning session with the session id labelled `plan_authoring` in `.chain/{{branchName}}/sessions.md`; if exact resume is unavailable, follow your role's new-session fallback. Revise the slice set against the plan-review findings by editing the slice files in place under `.chain/{{branchName}}/slices/`, preserving the planning invariants — tracer-bullet cut, acyclic true blocked_by, wide frontier and shallow critical path, rare files_hint overlap between independent slices, risk true exactly for persisted data or an irreversible external action, every acceptance criterion red at the frozen base. On a successful resume the `plan_authoring` id stands; in a new session add this session's id under `plan_revision`. Commit to {{branchName}}. The revised slice set is the implementation authority: complete when every must-fix finding has a resolving slice edit, every should-fix a recorded decision, and every spec requirement still maps to exactly one slice.", null, canonicalStep(4).opensPullRequest],
    [5, "Implementation", canonicalStep(5).agentName, AssigneeType.AGENT, null, canonicalStep(5).approvalGate, canonicalStep(5).outputKind, "Implement the approved slice set on {{branchName}} by frontier waves. Read every slice under `.chain/{{branchName}}/slices/`; the frontier — every slice whose blocked_by is fully merged — forms the next wave. Run all slices of a wave in parallel, each as one background subprocess in its own git worktree at the subordinate tier fixed in your role configuration, escalating any slice whose frontmatter flags risk as that configuration directs. At the wave barrier, merge finished worktrees back serially in ascending slice id, resolve conflicts in that order, and rerun the affected tests before opening the next wave. After the final wave, run the end-to-end suite and record the implementation range — the base commit you started from and the final head — in your task output; leave publication of the branch to the runner. Complete when every slice's acceptance criteria are green at the recorded head.", null, canonicalStep(5).opensPullRequest],
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
      update: { name, assigneeAgentId, assigneeType, runner, approvalGate, outputKind, prompt, opensPullRequest, attachmentsFromPrevious: canonicalStep(stepIndex).attachmentsFromPrevious, spawnPolicy: spawnPolicy ?? Prisma.JsonNull },
      create: { taskTemplateId: template.id, stepIndex, name, assigneeAgentId, assigneeType, runner, approvalGate, outputKind, prompt, opensPullRequest, attachmentsFromPrevious: canonicalStep(stepIndex).attachmentsFromPrevious, spawnPolicy: spawnPolicy ?? Prisma.JsonNull },
    });
  }

  console.log(`Seeded ${project.name} from agents/ with ${sources.roles.length} agents and the twelve-step feature template.`);
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
