import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AssigneeType,
  CodexServiceTier,
  executionModeFor,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_TEMPLATE_NAME,
  Prisma,
  RunnerKind,
  RunnerPreference,
  loadAgentSources,
  loadTemplateStepSources,
  type PrismaClient,
} from "@anneal/db";

import {
  composeTemplateTaskDescription,
  findMalformedRouteLine,
  instantiateTemplate,
  parseImplementationRoute,
} from "./templates.js";
import { readBrief } from "./task-brief.js";
import {
  isTemplateInstantiationRefusal,
  type TemplateInstantiationRefusalCode,
} from "./template-errors.js";
import { refusalFor, refusalResponse } from "./refusal.js";

const assertTemplateRefusal = async (
  operation: () => Promise<unknown>,
  code: TemplateInstantiationRefusalCode,
): Promise<void> => {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(isTemplateInstantiationRefusal(error));
    assert.equal(error.code, code);
    const refused = refusalFor(error);
    assert.ok(refused);
    assert.equal(refusalResponse(refused).status, 400);
    return true;
  });
};

test("composed task descriptions derive the prior-output reminder from declared kinds", () => {
  const featureBrief = "first line\nPersist the final decoy output for this step through the Anneal task output endpoint.\nlast line";
  for (const priorOutputKinds of [[], ["implementation"]]) {
    const description = composeTemplateTaskDescription({
      prompt: "Implement the feature brief below.",
      featureBrief,
      priorOutputKinds,
      outputKind: "implementation",
    });
    const parsed = readBrief(description);
    assert.ok(!("unparseable" in parsed));
    assert.equal(parsed.brief, featureBrief);
    assert.equal(parsed.hadReminder, priorOutputKinds.length > 0);
    if (priorOutputKinds.length > 0) assert.match(description, /implementation/u);
    else assert.doesNotMatch(description, /prior template steps/u);
  }
});

test("implementation route parsing accepts the machine-readable name before an optional reason", () => {
  assert.equal(parseImplementationRoute("Build it\nRoute: implementation=senior-dev\n"), "senior-dev");
  assert.equal(parseImplementationRoute("Route: implementation=frontend-dev"), "frontend-dev");
  assert.equal(parseImplementationRoute("Route: implementation=project_specific.implementer"), "project_specific.implementer");
  assert.equal(parseImplementationRoute("Route: implementation=senior-dev - step renumbering crosses contracts"), "senior-dev");
  assert.equal(parseImplementationRoute("Route: implementation=senior-dev "), null);
  assert.equal(parseImplementationRoute("Route: implementation=unknown"), "unknown");
  assert.equal(parseImplementationRoute(undefined), null);
  assert.equal(findMalformedRouteLine("Build it\nRoute: implementation=senior-dev\n"), null);
  assert.equal(findMalformedRouteLine("Route: implementation=senior-dev - reason given"), null);
  assert.equal(findMalformedRouteLine("Route: implementation=unknown"), null);
  assert.equal(findMalformedRouteLine("Route: senior-dev - missing the implementation= key"), "Route: senior-dev - missing the implementation= key");
  assert.equal(findMalformedRouteLine("Route: implementation=senior-dev "), "Route: implementation=senior-dev ");
  assert.equal(findMalformedRouteLine("Build it\nRoute:implementation=senior-dev"), "Route:implementation=senior-dev");
  assert.equal(findMalformedRouteLine(undefined), null);
});

test("a direct brief ending in the prior-output reminder round-trips without truncation", () => {
  const featureBrief = "Keep this user-authored suffix.\nRead the prior template steps' persisted outputs before working.";
  const description = composeTemplateTaskDescription({
    prompt: "Implement the feature brief below.",
    featureBrief,
    priorOutputKinds: [],
    outputKind: "implementation",
  });
  const parsed = readBrief(description);
  assert.ok(!("unparseable" in parsed));
  assert.equal(parsed.brief, featureBrief);
});

test("mechanical cards retain only their canonical prompt while model cards retain generated context", () => {
  const common = {
    prompt: "Execute this step.",
    featureBrief: "Build the feature",
    priorOutputKinds: ["implementation"],
  };
  for (const outputKind of ["merge-authorization", "merge-result"]) {
    assert.equal(
      composeTemplateTaskDescription({ ...common, outputKind }),
      common.prompt,
      `${outputKind} is server-owned and must not receive model-only context`,
    );
  }
  for (const outputKind of ["regression-verification", "regression-verification-v2", "regression-verification-v3"]) {
    assert.deepEqual(readBrief(composeTemplateTaskDescription({ ...common, outputKind })), {
      prompt: common.prompt,
      brief: common.featureBrief,
      hadReminder: true,
    });
  }
  const regressionDescription = composeTemplateTaskDescription({
    ...common,
    outputKind: "regression-verification-v2",
  });
  assert.deepEqual(readBrief(regressionDescription), {
    prompt: common.prompt,
    brief: common.featureBrief,
    hadReminder: true,
  }, "a platform-authored regression output must not make its brief unreadable");
});

test("instantiating the canonical feature template copies every layer and writes no follow-up links", async () => {
  const canonicalTemplateSteps = await loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME);
  const canonicalRoles = (await loadAgentSources()).roles;
  const created: Array<Record<string, any>> = [];
  const runs: Array<Record<string, any>> = [];
  const agents = new Map<string, {
    id: string;
    name: string;
    model: string;
    runnerPreference: RunnerPreference;
    codexServiceTier: CodexServiceTier;
    foundationalPrompt: string;
    rolePrompt: string;
  }>(canonicalRoles.map((role, index) => [role.name, {
    id: `agent-${index + 1}`,
    name: role.name,
    model: role.model,
    runnerPreference: role.runnerPreference,
    codexServiceTier: CodexServiceTier.DEFAULT,
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  }]));
  const steps = canonicalTemplateSteps.map((contract) => {
    const agent = contract.agentName ? agents.get(String(contract.agentName))! : null;
    return {
      id: `step-${contract.stepIndex}`,
      stepIndex: contract.stepIndex,
      name: `Step ${contract.stepIndex}`,
      prompt: `Work on {{branchName}} in chain {{chainId}} step ${contract.stepIndex}`,
      outputKind: contract.outputKind,
      attachmentsFromPrevious: contract.attachmentsFromPrevious,
      priorOutputKinds: contract.priorOutputKinds,
      assigneeType: agent ? AssigneeType.AGENT : AssigneeType.HUMAN,
      assigneeAgentId: agent?.id ?? null,
      assigneeAgent: agent,
      approvalGate: contract.approvalGate,
      opensPullRequest: contract.opensPullRequest,
      layer: contract.layer,
      baseFromStepIndex: contract.baseFromStepIndex,
      runner: null,
      taskTemplate: { name: "compound-engineer-workflow" },
    };
  });
  const template = { id: "template-1", name: "compound-engineer-workflow", variables: ["branchName"], steps };
  const tx = {
    // The Agent-row mutex and each exact Repo-grant mutex are acquired before
    // the first task write. Returning both row shapes lets the shared lock
    // helpers exercise their normal paths.
    $queryRaw: async (query: TemplateStringsArray) => query.join(" ").includes('"TaskTemplate"')
      ? [{ id: template.id, projectId: "project-1", name: template.name }]
      : [...agents.values()].map((agent) => ({
        id: agent.id, name: agent.name, projectId: "project-1", archivedAt: null,
        agentId: agent.id, repoId: "repo-1",
      })),
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        [...agents.values()].find((agent) => agent.id === where.id) ?? null,
    },
    task: {
      create: async ({ data }: { data: Record<string, any> }) => {
        const task = {
          id: `task-${created.length + 1}`,
          ...data,
          assigneeAgent: data.assigneeAgentId
            ? [...agents.values()].find((agent) => agent.id === data.assigneeAgentId)
            : null,
          repo: { id: "repo-1", defaultBranch: "main" },
          templateStep: steps[created.length],
          runs: [],
        };
        created.push(task);
        return task;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const task = created.find((item) => item.id === where.id)!;
        Object.assign(task, data);
        return task;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => created.find((item) => item.id === where.id),
      findUnique: async ({ where }: { where: { id: string } }) => created.find((item) => item.id === where.id) ?? null,
      findFirst: async () => created.find((item) => item.targetBranch !== "main") ?? null,
    },
    run: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, any> }) => { const run = { id: "run-1", ...data }; runs.push(run); return run; },
      update: async ({ data }: { data: Record<string, any> }) => { Object.assign(runs[0]!, data); return runs[0]; },
    },
    taskActivity: { createMany: async () => ({ count: 12 }) },
    chainControl: { findMany: async () => [] },
    taskTemplateStep: {
      findUnique: async ({ where }: { where: { id: string } }) => steps.find((step) => step.id === where.id) ?? null,
    },
    agentRepoAccess: { count: async () => 1 },
  };
  const db = {
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { findFirst: async () => ({ agentId: "granted-agent" }) },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  const result = await instantiateTemplate(db, "project-1", "template-1", {
    repoId: "repo-1", variables: { branchName: "feature/twelve-steps" }, autoStart: true, description: "Build it",
  });
  assert.equal(result.tasks.length, 12);
  assert.equal(new Set(created.map((task) => task.chainId)).size, 1);
  assert.deepEqual(created.map((task) => task.chainLayer), canonicalTemplateSteps.map((step) => step.layer));
  assert.ok(created.every((task) => task.description.includes(`chain ${result.chainId}`)), "chainId is a built-in template variable");
  assert.ok(created.every((task) => typeof task.chainLayer === "number"));
  assert.equal(created[10]!.assigneeType, AssigneeType.AGENT);
  assert.equal(created[10]!.approvalGate, false);
  assert.equal(created[10]!.templateStep.outputKind, "merge-authorization");
  assert.equal(created[11]!.assigneeAgent?.name, INTEGRATOR_AGENT_NAME);
  assert.equal(created[11]!.assigneeAgent?.model, INTEGRATOR_SENTINEL_MODEL);
  assert.equal(created[11]!.assigneeAgent?.runnerPreference, RunnerPreference.INHERIT);
  assert.equal(created[11]!.opensPullRequest, false);
  assert.equal(executionModeFor(created[11]!.templateStep), "mechanical");
  assert.deepEqual(created.map((task) => task.outputKind ?? task.templateStep.outputKind), canonicalTemplateSteps.map((step) => step.outputKind));
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.runner, RunnerKind.CLAUDE);
  assert.equal(runs[0]!.branch, "feature/twelve-steps");
  assert.equal(runs.some((run) => run.taskId === created[11]!.id), false, "step 12 waits for server-side readiness and never queues at instantiation");
  assert.doesNotMatch(
    created[6]!.description,
    /Read the prior template steps' persisted outputs before working/u,
    "blind-review step 7 materializes without an upstream-read instruction",
  );
  assert.match(
    created[9]!.description,
    /Read the prior template steps' persisted outputs before working/u,
    "regression-verification step 10 consumes declared review and fix outputs",
  );
  assert.doesNotMatch(
    created[10]!.description,
    /Read the prior template steps' persisted outputs before working/u,
    "mechanical merge authorization has no declared prior output",
  );
  assert.doesNotMatch(
    created[11]!.description,
    /Read the prior template steps' persisted outputs before working/u,
    "mechanical merge execution has no declared prior output",
  );

  const inert = await instantiateTemplate(db, "project-1", "template-1", {
    repoId: "repo-1", variables: { branchName: "feature/inert-chain" }, description: "Build it later",
  });
  assert.equal(inert.tasks.length, 12);
  assert.equal(runs.length, 1, "omitting autoStart defaults to an inert chain with no queued run");
});

test("the lower-level materializer rejects blank variables and invalid branches from the locked graph", async () => {
  const db = {
    taskTemplate: { findFirst: async () => ({
      id: "template-1",
      name: "Template",
      variables: ["branchName"],
      steps: [{
        id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
        outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
        assigneeAgentId: "agent-1", assigneeAgent: { id: "agent-1", name: "Agent", archivedAt: null },
        approvalGate: false, opensPullRequest: true, runner: null,
      }],
    }) },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
      $queryRaw: async (query: TemplateStringsArray) => query.join(" ").includes('"TaskTemplate"')
        ? [{ id: "template-1", projectId: "project-1", name: "Template" }]
        : [],
      taskTemplate: { findFirst: async () => ({
        id: "template-1",
        name: "Template",
        variables: ["branchName"],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
          assigneeAgentId: "agent-1", assigneeAgent: { id: "agent-1", name: "Agent", archivedAt: null },
          approvalGate: false, opensPullRequest: true, runner: null,
        }],
      }) },
      repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    }),
  } as unknown as PrismaClient;
  for (const [branchName, code] of [
    ["", "template_variables_missing"],
    ["   ", "template_variables_missing"],
    ["bad..branch", "template_branch_invalid"],
    ["refs/heads/main", "template_branch_invalid"],
    ["feature/.hidden", "template_branch_invalid"],
    ["feature/main.lock", "template_branch_invalid"],
    ["bad\nbranch", "template_branch_invalid"],
  ] as const) {
    await assertTemplateRefusal(
      () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: { branchName }, autoStart: false }),
      code,
    );
  }
});

test("template base reference failures expose stable 400 refusal codes", async () => {
  const step = (stepIndex: number, baseFromStepIndex: number | null) => ({
    id: `step-${stepIndex}`,
    stepIndex,
    baseFromStepIndex,
    name: `Step ${stepIndex}`,
    prompt: "work",
    outputKind: "result",
    attachmentsFromPrevious: false,
    priorOutputKinds: [],
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: "agent-1",
    assigneeAgent: { id: "agent-1", name: "Agent", archivedAt: null },
    approvalGate: false,
    opensPullRequest: true,
    runner: null,
  });
  for (const [steps, code] of [
    [[step(1, 99)], "template_base_reference_missing"],
    [[step(1, 1)], "template_base_reference_not_earlier"],
  ] as const) {
    const db = {
      taskTemplate: { findFirst: async () => ({ id: "template-1", name: "Template", variables: [], steps }) },
      repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
      $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
        $queryRaw: async (query: TemplateStringsArray) => query.join(" ").includes('"TaskTemplate"')
          ? [{ id: "template-1", projectId: "project-1", name: "Template" }]
          : [],
        taskTemplate: { findFirst: async () => ({ id: "template-1", name: "Template", variables: [], steps }) },
        repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
      }),
    } as unknown as PrismaClient;
    await assertTemplateRefusal(
      () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {} }),
      code,
    );
  }
});

test("an agent archived after the step check still loses to the locked re-read", async () => {
  // The pre-transaction validation sees a live agent; the archive commits; the
  // locked re-read is what decides. Without it the whole chain — and its first
  // run — would be written for an agent no runner ever claims for.
  const agent = {
    id: "agent-1", name: "Racing Agent", archivedAt: null, model: "codex",
    runnerPreference: RunnerPreference.CODEX, foundationalPrompt: "foundation", rolePrompt: "role",
  };
  let taskCreates = 0;
  const db = {
    taskTemplate: {
      findFirst: async () => ({
        id: "template-1",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, runner: null,
        }],
      }),
    },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { findFirst: async () => ({ agentId: agent.id }) },
    $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
      $queryRaw: async (query: TemplateStringsArray) => query.join(" ").includes('"TaskTemplate"')
        ? [{ id: "template-1", projectId: "project-1", name: "Template" }]
        : [{ id: agent.id, name: agent.name, projectId: "project-1", archivedAt: new Date() }],
      taskTemplate: { findFirst: async () => ({
        id: "template-1",
        name: "Template",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, opensPullRequest: true, runner: null,
        }],
      }) },
      repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
      task: { create: async () => { taskCreates += 1; return { id: "task-1" }; } },
      run: { create: async () => { throw new Error("must not create run"); } },
      taskActivity: { createMany: async () => ({ count: 0 }) },
    }),
  } as unknown as PrismaClient;
  await assertTemplateRefusal(
    () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {}, autoStart: false }),
    "template_step_agent_archived",
  );
  assert.equal(taskCreates, 0, "no chain row is written once the lock says archived");
});

test("a serializable conflict raised by the raw Agent lock is retried, not surfaced", async () => {
  // The lock is a raw statement, so Postgres reports the conflict as P2010 with
  // the SQLSTATE in meta. Treating that as fatal turned an archive race into a
  // 500 instead of the named archive rejection the caller can act on.
  const agent = {
    id: "agent-1", name: "Racing Agent", archivedAt: null, model: "codex",
    runnerPreference: RunnerPreference.CODEX, foundationalPrompt: "foundation", rolePrompt: "role",
  };
  let transactionAttempts = 0;
  let agentLockConflicts = 0;
  const db = {
    taskTemplate: {
      findFirst: async () => ({
        id: "template-1",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, runner: null,
        }],
      }),
    },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { findFirst: async () => ({ agentId: agent.id }) },
    $transaction: async (operation: (client: unknown) => Promise<unknown>) => {
      transactionAttempts += 1;
      return operation({
      $queryRaw: async (query: TemplateStringsArray) => {
        const sql = query.join(" ");
        // First attempt: the archive holds the row and commits under us.
        if (!sql.includes('"TaskTemplate"') && agentLockConflicts === 0) {
          agentLockConflicts += 1;
          throw new Prisma.PrismaClientKnownRequestError("Raw query failed", {
            code: "P2010",
            clientVersion: "test",
            meta: { code: "40001", message: "could not serialize access due to concurrent update" },
          });
        }
        return sql.includes('"TaskTemplate"')
          ? [{ id: "template-1", projectId: "project-1", name: "Template" }]
          : [{ id: agent.id, name: agent.name, projectId: "project-1", archivedAt: new Date() }];
      },
      taskTemplate: { findFirst: async () => ({
        id: "template-1",
        name: "Template",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, opensPullRequest: true, runner: null,
        }],
      }) },
      repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
      task: { create: async () => { throw new Error("must not create task"); } },
      run: { create: async () => { throw new Error("must not create run"); } },
      taskActivity: { createMany: async () => ({ count: 0 }) },
      });
    },
  } as unknown as PrismaClient;
  await assertTemplateRefusal(
    () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {}, autoStart: false }),
    "template_step_agent_archived",
  );
  assert.equal(agentLockConflicts, 1, "the conflict is injected on the Agent-row lock");
  assert.equal(transactionAttempts, 2, "the Agent-lock conflict retries the whole serializable transaction once");
});

test("template instantiation rejects an archived step agent and names the step", async () => {
  const agent = {
    id: "agent-1", name: "Archived Agent", archivedAt: new Date(), model: "codex",
    runnerPreference: RunnerPreference.CODEX, foundationalPrompt: "foundation", rolePrompt: "role",
  };
  const db = {
    taskTemplate: {
      findFirst: async () => ({
        id: "template-1",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, runner: null,
        }],
      }),
    },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
      $queryRaw: async (query: TemplateStringsArray) => query.join(" ").includes('"TaskTemplate"')
        ? [{ id: "template-1", projectId: "project-1", name: "Template" }]
        : [{ id: agent.id, name: agent.name, projectId: "project-1", archivedAt: agent.archivedAt }],
      taskTemplate: { findFirst: async () => ({
        id: "template-1",
        name: "Template",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, priorOutputKinds: [], assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, opensPullRequest: true, runner: null,
        }],
      }) },
      repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
      task: { create: async () => { throw new Error("must not create task"); } },
      taskActivity: { createMany: async () => ({ count: 0 }) },
    }),
  } as unknown as PrismaClient;
  await assertTemplateRefusal(
    () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {}, autoStart: false }),
    "template_step_agent_archived",
  );
});

test("step overrides copy only the effective assignee and lock canonical plus override agents", async () => {
  const canonical = (id: string, name: string) => ({
    id, name, projectId: "project-1", archivedAt: null,
    model: "codex", foundationalPrompt: "foundation", rolePrompt: "role",
  });
  const agents = [canonical("agent-1", "Canonical One"), canonical("agent-2", "Canonical Two")];
  const replacement = canonical("agent-replacement", "Replacement");
  const steps = [1, 2].map((stepIndex) => ({
    id: `step-${stepIndex}`, stepIndex, name: `Step ${stepIndex}`, prompt: `work ${stepIndex}`,
    outputKind: "result", attachmentsFromPrevious: stepIndex === 2,
    priorOutputKinds: stepIndex === 2 ? ["result"] : [], assigneeType: AssigneeType.AGENT,
    assigneeAgentId: `agent-${stepIndex}`, assigneeAgent: agents[stepIndex - 1], approvalGate: stepIndex === 2,
    opensPullRequest: stepIndex === 1, layer: stepIndex, baseFromStepIndex: null, runner: null,
  }));
  const template = { id: "template-1", name: "Template", variables: [], steps };
  const created: Array<Record<string, any>> = [];
  const lockQueries: string[] = [];
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => {
      lockQueries.push(query.join(" "));
      if (query.join(" ").includes('"TaskTemplate"')) {
        return [{ id: template.id, projectId: "project-1", name: template.name }];
      }
      return [
        ...[...agents, replacement].map((agent) => ({
          id: agent.id,
          name: agent.name,
          projectId: agent.projectId,
          archivedAt: agent.archivedAt,
        })),
        ...[...agents, replacement].map((agent) => ({ agentId: agent.id, repoId: "repo-1" })),
      ];
    },
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { count: async () => 1 },
    task: {
      create: async ({ data }: { data: Record<string, any> }) => {
        const task = { id: `task-${created.length + 1}`, ...data };
        created.push(task);
        return task;
      },
    },
    taskActivity: { createMany: async () => ({ count: created.length }) },
  };
  const db = {
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agent: { findMany: async () => [replacement] },
    agentRepoAccess: { findFirst: async () => ({ agentId: replacement.id }) },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;

  const result = await instantiateTemplate(db, "project-1", "template-1", {
    repoId: "repo-1", variables: {}, stepOverrides: { "2": { assigneeAgentId: replacement.id } },
  });
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(created.map((task) => task.assigneeAgentId), ["agent-1", replacement.id]);
  assert.equal(created[1]!.assigneeType, AssigneeType.AGENT);
  assert.equal(created[1]!.approvalGate, true);
  assert.equal(created[1]!.opensPullRequest, false);
  assert.equal(lockQueries.length, 4, "one template lock, one Agent lock, plus one grant lock per distinct effective assignee");
  assert.match(lockQueries[0]!, /TaskTemplate/u);
  assert.match(lockQueries[1]!, /ORDER BY "id" FOR UPDATE/u);
});

test("step override structural refusals happen before template reads and carry stable codes", async () => {
  const db = {
    taskTemplate: { findFirst: async () => { throw new Error("database must not be read"); } },
    repo: { findFirst: async () => { throw new Error("database must not be read"); } },
  } as unknown as PrismaClient;
  for (const [stepOverrides, code] of [
    [{ "0": { assigneeAgentId: "agent" } }, "step_override_invalid_key"],
    [{ "09": { assigneeAgentId: "agent" } }, "step_override_invalid_key"],
    [{ "1.5": { assigneeAgentId: "agent" } }, "step_override_invalid_key"],
    [Object.fromEntries(Array.from({ length: 65 }, (_, index) => [String(index + 1), { assigneeAgentId: "agent" }])), "step_override_too_many"],
  ] as const) {
    await assertTemplateRefusal(
      () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {}, stepOverrides }),
      code,
    );
  }
});

test("an unbound direct chain omits revalidation while Route overrides the renumbered implementation", async () => {
  let templateName = "direct-engineer-workflow";
  let lockedRouteAgentName = "senior-dev";
  const revalidator = {
    id: "agent-revalidator", name: "spec-revalidator", projectId: "project-1", archivedAt: null,
    model: "openai-codex/gpt-5.6-luna:xhigh", foundationalPrompt: "foundation", rolePrompt: "role",
  };
  const canonical = {
    id: "agent-luna", name: "senior-dev-luna", projectId: "project-1", archivedAt: null,
    model: "gpt-5.6-luna:max", foundationalPrompt: "foundation", rolePrompt: "role",
  };
  const routed = {
    id: "agent-senior", name: "senior-dev", projectId: "project-1", archivedAt: null,
    model: "gpt-5.6-sol:high", foundationalPrompt: "foundation", rolePrompt: "role",
  };
  const steps = [
    {
      id: "step-revalidation", stepIndex: 1, name: "Revalidate", prompt: "revalidate {{chainId}}",
      outputKind: "revalidation", attachmentsFromPrevious: false, priorOutputKinds: [],
      assigneeType: AssigneeType.AGENT, assigneeAgentId: revalidator.id, assigneeAgent: revalidator,
      approvalGate: false, opensPullRequest: false, layer: 1, baseFromStepIndex: null, runner: null,
    },
    {
      id: "step-implementation", stepIndex: 2, name: "Implementation", prompt: "implement {{chainId}}",
      outputKind: "implementation", attachmentsFromPrevious: false, priorOutputKinds: [],
      assigneeType: AssigneeType.AGENT, assigneeAgentId: canonical.id, assigneeAgent: canonical,
      approvalGate: false, opensPullRequest: true, layer: 2, baseFromStepIndex: null, runner: null,
    },
    {
      id: "step-review", stepIndex: 3, name: "Review", prompt: "review {{chainId}}",
      outputKind: "sol-findings", attachmentsFromPrevious: true, priorOutputKinds: ["implementation"],
      assigneeType: AssigneeType.AGENT, assigneeAgentId: canonical.id, assigneeAgent: canonical,
      approvalGate: false, opensPullRequest: false, layer: 3, baseFromStepIndex: 2, runner: null,
    },
  ];
  const template = { id: "template-1", name: templateName, variables: [], steps };
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => query.join(" ").includes('"TaskTemplate"')
      ? [{ id: template.id, projectId: "project-1", name: templateName }]
      : [
        canonical,
        revalidator,
        { ...routed, name: lockedRouteAgentName },
        { agentId: canonical.id, repoId: "repo-1" },
        { agentId: revalidator.id, repoId: "repo-1" },
        { agentId: routed.id, repoId: "repo-1" },
      ],
    taskTemplate: { findFirst: async () => ({ ...template, name: templateName }) },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agent: { findFirst: async () => routed },
    agentRepoAccess: { count: async () => 1 },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const task = { id: `task-${created.length + 1}`, ...data };
        created.push(task);
        return task;
      },
    },
    taskActivity: { createMany: async () => ({ count: created.length }) },
  };
  const db = {
    taskTemplate: {
      findFirst: async () => ({ ...template, name: templateName }),
    },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agent: {
      findFirst: async () => routed,
      findMany: async () => [routed],
    },
    agentRepoAccess: { findFirst: async () => ({ agentId: routed.id }) },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;

  const result = await instantiateTemplate(db, "project-1", "template-1", {
    repoId: "repo-1",
    variables: {},
    description: "Build it\nRoute: implementation=senior-dev\n",
  });

  assert.equal(result.tasks.length, 2);
  assert.deepEqual(created.map((task) => task.assigneeAgentId), [routed.id, canonical.id]);
  assert.deepEqual(created.map((task) => task.chainIndex), [1, 2]);
  assert.deepEqual(created.map((task) => task.chainLayer), [1, 2]);
  assert.deepEqual(created.map((task) => task.targetBranch), ["main", result.branchName]);

  await assertTemplateRefusal(
    () => instantiateTemplate(db, "project-1", "template-1", {
      repoId: "repo-1",
      variables: {},
      description: "Build it\nRoute: implementation=senior-dev\n",
      stepOverrides: { "2": { assigneeAgentId: routed.id } },
    }),
    "implementation_route_conflicts_with_step_override",
  );

  lockedRouteAgentName = "renamed-senior-dev";
  await assertTemplateRefusal(
    () => instantiateTemplate(db, "project-1", "template-1", {
      repoId: "repo-1",
      variables: {},
      description: "Build it\nRoute: implementation=senior-dev\n",
    }),
    "implementation_route_agent_renamed",
  );

  lockedRouteAgentName = routed.name;
  await assertTemplateRefusal(
    () => instantiateTemplate(db, "project-1", "template-1", {
      repoId: "repo-1",
      variables: {},
      description: "Build it\nRoute: senior-dev - missing the implementation= key\n",
    }),
    "implementation_route_malformed",
  );

  for (const nonDirectName of ["custom-workflow", "compound-engineer-workflow"]) {
    templateName = nonDirectName;
    const originalOutputKind = steps[1]!.outputKind;
    if (nonDirectName === "compound-engineer-workflow") steps[1]!.outputKind = "documentation";
    for (const route of ["senior-dev", "unknown-agent"]) {
      const nonDirect = await instantiateTemplate(db, "project-1", "template-1", {
        repoId: "repo-1",
        variables: {},
        description: `Route: implementation=${route}`,
      });
      assert.equal(nonDirect.tasks.length, 3, `${nonDirectName} must ignore ${route}`);
    }
    const malformedTolerated = await instantiateTemplate(db, "project-1", "template-1", {
      repoId: "repo-1",
      variables: {},
      description: "Route: senior-dev - Route-looking prose is not parsed here",
    });
    assert.equal(malformedTolerated.tasks.length, 3, `${nonDirectName} must ignore malformed Route prose`);
    steps[1]!.outputKind = originalOutputKind;
  }
});

test("canonical unbound direct instantiation retains the seven-task prompt snapshot", async () => {
  const [source, canonicalRoles] = await Promise.all([
    loadTemplateStepSources("direct-engineer-workflow"),
    loadAgentSources().then(({ roles }) => roles),
  ]);
  const agents = new Map(canonicalRoles.map((role, index) => [role.name, {
    id: `snapshot-agent-${index}`,
    name: role.name,
    projectId: "project-1",
    archivedAt: null,
    model: role.model,
    runnerPreference: role.runnerPreference,
    codexServiceTier: CodexServiceTier.DEFAULT,
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  }]));
  const steps = source.map((contract) => {
    const agent = contract.agentName
      ? agents.get(contract.agentName)!
      : null;
    return {
      id: `snapshot-step-${contract.stepIndex}`,
      ...contract,
      prompt: contract.prompt,
      assigneeAgentId: agent?.id ?? null,
      assigneeAgent: agent,
      assigneeType: agent ? AssigneeType.AGENT : AssigneeType.HUMAN,
      runner: null,
    };
  });
  const created: Array<Record<string, unknown>> = [];
  const lockedRows = [
    ...agents.values(),
    ...[...agents.values()].map((agent) => ({ agentId: agent.id, repoId: "repo-1" })),
  ];
  const template = { id: "template-direct", name: "direct-engineer-workflow", variables: ["branchName"], steps };
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => query.join(" ").includes('"TaskTemplate"')
      ? [{ id: template.id, projectId: "project-1", name: template.name }]
      : lockedRows,
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { count: async () => 1 },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `snapshot-task-${created.length + 1}`, ...data };
        created.push(row);
        return row;
      },
    },
    taskActivity: { createMany: async () => ({ count: created.length }) },
  };
  const db = {
    taskTemplate: { findFirst: async () => template },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agent: { findMany: async () => [], findFirst: async () => null },
    agentRepoAccess: { findFirst: async () => ({ id: "grant" }) },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;

  const result = await instantiateTemplate(db, "project-1", "template-direct", {
    repoId: "repo-1",
    variables: { branchName: "snapshot-branch" },
    description: "Snapshot brief.",
  });
  assert.equal(result.tasks.length, 7);
  assert.deepEqual(created.map((row) => ({
    name: row.name,
    descriptionSha256: createHash("sha256").update(String(row.description)).digest("hex"),
  })), [
    { name: "direct-engineer-workflow: Implementation", descriptionSha256: "45327aeb86fc7e98a76ef4052278cee29ceb38a601aeb65225024b87708225d0" },
    { name: "direct-engineer-workflow: Code review (Sol)", descriptionSha256: "cea58637cbbf2616a41db1864a7d22fa9c20472b61e673a2d8b1312fb1691d2a" },
    { name: "direct-engineer-workflow: Code review (Opus blind)", descriptionSha256: "af02f099a6e2b6b10f3ea2b31b8bcfd06a057cd91b134c16a3df552690fc979b" },
    { name: "direct-engineer-workflow: Apply review fixes", descriptionSha256: "ba850c7de0ee4d19abe6e6f32d22ffa8e1731abe52cbb61d0ea00996c037e5ad" },
    { name: "direct-engineer-workflow: Regression verification", descriptionSha256: "d59059cc2cdbfd03f6b45abfe4d656974a931f0f50a7f1624571e7e3bffa8e1a" },
    { name: "direct-engineer-workflow: Merge authorization", descriptionSha256: "6cc850c691d3334a0ba8e4b26b24acdc3c7ab70c4b8cbac1fccb65ee708a7da7" },
    { name: "direct-engineer-workflow: Merge execution", descriptionSha256: "6f3ee10eef0967fec9bfdb09a73ab8b9f5e07aa3e4548e48d1174e2a90602a53" },
  ]);
});
