import "../test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexServiceTier,
  Prisma,
  RunnerPreference,
  loadAgentSources,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "../test-app.js";
import { RepositoryPreflightError } from "../onboarding-preflight.js";
import { lockedAgent, untouchableDatabase, withTokens } from "./test-support.js";

test("filesystem grant CRUD accepts root/canonical paths and rejects non-canonical paths", async () => {
  await withTokens(async () => {
    const saved: string[] = [];
    const database = {
      filesystemGrant: {
        upsert: async ({ create }: { create: { folderPath: string } }) => { saved.push(create.folderPath); return create; },
        findFirst: async () => ({ id: "grant-1", agentId: "agent-1" }),
        findMany: async () => saved.map((folderPath, index) => ({ id: `grant-${index}`, folderPath })),
        update: async ({ data }: { data: { folderPath?: string } }) => { if (data.folderPath !== undefined) saved.push(data.folderPath); return data; },
      },
    } as unknown as PrismaClient;
    const app = createApp(database);
    const request = (folderPath: string) => app.request("/agents/agent-1/filesystem-grants", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath, canRead: true }),
    });
    assert.equal((await request("")).status, 201);
    for (const path of ["/abs", "a/../b", "a/"]) assert.equal((await request(path)).status, 400, path);
    assert.equal((await request("  _global  ")).status, 201);
    // Whitespace-only must not trim down to the whole-Files-Root sentinel.
    for (const blank of [" ", "   ", "\t\n "]) assert.equal((await request(blank)).status, 400, JSON.stringify(blank));
    const patchResponse = await app.request("/agents/agent-1/filesystem-grants/grant-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath: "patched", canWrite: true }),
    });
    assert.equal(patchResponse.status, 200);
    assert.deepEqual(saved, ["", "_global", "patched"]);
  });
});

test("agent archive and unarchive are idempotent and preserve the original archive timestamp", async () => {
  await withTokens(async () => {
    let archivedAt: Date | null = null;
    const updates: Array<Date | null> = [];
    const noticeIds = new Set<string>();
    const agentRow = () => ({ id: "agent-1", name: "Agent", archivedAt });
    const agentClient = {
      findUnique: async () => agentRow(),
      findUniqueOrThrow: async () => agentRow(),
      update: async ({ data }: { data: { archivedAt: Date | null } }) => {
        archivedAt = data.archivedAt;
        updates.push(archivedAt);
        return agentRow();
      },
    };
    const database = {
      agent: agentClient,
      // Archive now runs under the Agent-row mutex and fails closed on live
      // references, so the transaction client answers the lock and both
      // reference reads. Nothing is queued or in flight here.
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
        $queryRaw: async () => [{ id: "agent-1", archivedAt }],
        agent: agentClient,
        // The completion route reads the run's step binding before the
      // transaction, to bind a mechanical completion to the merge-executor
      // principal (§D-P1 rule 3). An ordinary run has no template step.
      run: { findFirst: async () => null, findUnique: async () => ({ runnerId: "runner-1", task: { templateStep: null } }) },
        task: { findFirst: async () => null },
      }),
      run: {
        findMany: async () => archivedAt ? [{
          id: "run-queued", taskId: "task-1", runNumber: 1,
          agent: { name: "Agent", archivedAt },
        }] : [],
      },
      taskActivity: {
        createMany: async ({ data }: { data: Array<{ id: string }> }) => {
          let count = 0;
          for (const row of data) {
            if (noticeIds.has(row.id)) continue;
            noticeIds.add(row.id);
            count += 1;
          }
          return { count };
        },
      },
    } as unknown as PrismaClient;
    const app = createApp(database);
    const request = (path: string) => app.request(path, {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token" },
    });

    const archived = await request("/agents/agent-1/archive");
    assert.equal(archived.status, 200);
    assert.ok(updates[0] instanceof Date);
    const originalTimestamp = archivedAt;
    assert.equal((await request("/agents/agent-1/archive")).status, 200);
    assert.equal(archivedAt, originalTimestamp);
    assert.equal(updates.length, 1);
    assert.equal(noticeIds.size, 1);
    assert.match([...noticeIds][0]!, /^archived-skip:run-queued:/);

    const unarchived = await request("/agents/agent-1/unarchive");
    assert.equal(unarchived.status, 200);
    assert.equal(archivedAt, null);
    assert.equal((await request("/agents/agent-1/unarchive")).status, 200);
    assert.deepEqual(updates, [originalTimestamp, null]);
  });
});

test("archiving an agent fails closed on a live run or any live task", async () => {
  await withTokens(async () => {
    // Both references are the same defect one step apart: a run queued for an
    // archived agent is filtered out of every claim, so it never runs and its
    // task never completes. Refusing the archive keeps the operator's options.
    // A task reference does not need a run to be live — TODO and REVIEW rows
    // are exactly the ones no run exists for yet, and archiving under them is
    // what strands the step that would have created it.
    const cases = [
      {
        run: { runNumber: 2, status: "QUEUED", task: { name: "Ship it" } },
        task: null,
        expected: "Cannot archive an agent with a QUEUED run on Ship it; finish or cancel run 2 first",
      },
      {
        run: null,
        task: { name: "Ship it", status: "DOING" },
        expected: "Cannot archive an agent assigned to DOING task Ship it; finish, park, archive, or reassign that task first",
      },
      {
        run: null,
        task: { name: "Tomorrow's sweep", status: "TODO" },
        expected: "Cannot archive an agent assigned to TODO task Tomorrow's sweep; finish, park, archive, or reassign that task first",
      },
      {
        run: null,
        task: { name: "Awaiting the gate", status: "REVIEW" },
        expected: "Cannot archive an agent assigned to REVIEW task Awaiting the gate; finish, park, archive, or reassign that task first",
      },
    ];
    for (const { run, task, expected } of cases) {
      let updates = 0;
      const database = {
        agent: {
          findUniqueOrThrow: async () => ({ id: "agent-1", name: "Agent", archivedAt: null }),
          update: async () => { updates += 1; return {}; },
        },
        $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
          $queryRaw: async () => [{ id: "agent-1", archivedAt: null }],
          agent: {
            findUnique: async () => ({ id: "agent-1", name: "Agent", archivedAt: null }),
            findUniqueOrThrow: async () => ({ id: "agent-1", name: "Agent", archivedAt: null }),
            update: async () => { updates += 1; return {}; },
          },
          run: { findFirst: async () => run },
          task: { findFirst: async () => task },
        }),
      } as unknown as PrismaClient;
      const response = await createApp(database).request("/agents/agent-1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token" },
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: expected });
      assert.equal(updates, 0, "a refused archive writes nothing");
    }
  });
});

test("archive and unarchive return 404 for a missing agent", async () => {
  await withTokens(async () => {
    const database = {
      agent: { findUnique: async () => null },
      // No row to lock is the archive route's 404.
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
        $queryRaw: async () => [],
      }),
    } as unknown as PrismaClient;
    const app = createApp(database);
    for (const action of ["archive", "unarchive"]) {
      const response = await app.request(`/agents/missing/${action}`, {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token" },
      });
      assert.equal(response.status, 404);
    }
  });
});

test("deleting an agent with task history maps Prisma P2003 to a guided 409", async () => {
  await withTokens(async () => {
    const database = {
      agent: {
        delete: async () => {
          throw new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
            code: "P2003",
            clientVersion: "6.19.0",
          });
        },
      },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/agents/agent-1", {
      method: "DELETE",
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Agent has task history; archive it instead" });
  });
});

test("deleting a history-free agent still returns 204", async () => {
  await withTokens(async () => {
    let deleted = false;
    const database = {
      agent: { delete: async () => { deleted = true; return {}; } },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/agents/agent-1", {
      method: "DELETE",
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(response.status, 204);
    assert.equal(deleted, true);
  });
});

test("Agent API refuses Fast for a non-Codex model", async () => {
  await withTokens(async () => {
    const response = await createApp({} as PrismaClient).request("/projects/project-1/agents", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        environmentId: "environment-1",
        name: "claude-fast",
        title: "Claude Fast",
        model: "claude-opus-5:medium",
        rolePrompt: "work",
        runnerPreference: "CLAUDE",
        codexServiceTier: "FAST",
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Fast service tier requires a Codex gpt-* model or a PI openai-codex/* model",
    });
  });
});

test("Agent API refuses an executioner rename", async () => {
  await withTokens(async () => {
    let updated = false;
    const executioner = lockedAgent({
      id: "agent-executioner",
      projectId: "project-1",
      environmentId: "environment-1",
      name: "implementation-plan-executioner",
      title: "Implementation Plan Executioner",
      model: "gpt-5.6-sol:high",
      runnerPreference: RunnerPreference.CODEX,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    });
    const tx = {
      $queryRaw: async () => [{ id: executioner!.id }],
      agent: {
        findUnique: async () => executioner,
        update: async () => { updated = true; return executioner; },
      },
    };
    const database = {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request(`/agents/${executioner!.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed-executioner" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "implementation-plan-executioner is a canonical Agent name and cannot be changed",
    });
    assert.equal(updated, false);
  });
});

test("Agent API refuses a non-Codex executioner runtime", async () => {
  await withTokens(async () => {
    let updated = false;
    const executioner = lockedAgent({
      id: "agent-executioner",
      projectId: "project-1",
      environmentId: "environment-1",
      name: "implementation-plan-executioner",
      title: "Implementation Plan Executioner",
      model: "gpt-5.6-sol:high",
      runnerPreference: RunnerPreference.CODEX,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    });
    const tx = {
      $queryRaw: async () => [{ id: executioner!.id }],
      agent: {
        findUnique: async () => executioner,
        update: async () => { updated = true; return executioner; },
      },
    };
    const database = {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request(`/agents/${executioner!.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5:medium", runnerPreference: RunnerPreference.CLAUDE }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "implementation-plan-executioner requires a Codex gpt-* model",
    });
    assert.equal(updated, false);
  });
});

test("Agent API does not mark unchanged runtime fields as an operator override", async () => {
  await withTokens(async () => {
    let updateData: Record<string, unknown> | null = null;
    const executioner = lockedAgent({
      id: "agent-executioner",
      projectId: "project-1",
      environmentId: "environment-1",
      name: "implementation-plan-executioner",
      title: "Implementation Plan Executioner",
      model: "gpt-5.6-sol:high",
      runnerPreference: RunnerPreference.CODEX,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
      runtimeConfigCustomized: false,
    });
    const tx = {
      $queryRaw: async () => [{ id: executioner!.id }],
      agent: {
        findUnique: async () => executioner,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updateData = data;
          return { ...executioner, ...data };
        },
      },
    };
    const database = {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request(`/agents/${executioner!.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Renamed title",
        model: executioner!.model,
        runnerPreference: executioner!.runnerPreference,
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(updateData, {
      title: "Renamed title",
      model: "gpt-5.6-sol:high",
      runnerPreference: RunnerPreference.CODEX,
    });
  });
});

test("reset-runtime-config restores canonical runtime values and refuses invalid reset targets", async () => {
  await withTokens(async () => {
    const roles = (await loadAgentSources()).roles;
    const canonicalRole = roles.find(({ name }) => name === "default");
    const nonCodexRole = roles.find(({ runnerPreference }) => runnerPreference === RunnerPreference.CLAUDE);
    assert.ok(canonicalRole);
    assert.ok(nonCodexRole);
    const updates: Array<Record<string, unknown>> = [];
    const canonical = lockedAgent({
      id: "agent-default",
      name: "default",
      model: "custom-model",
      runnerPreference: RunnerPreference.CLAUDE,
      runtimeConfigCustomized: true,
      runtimeConfigDriftNoticeFingerprint: "stale-fingerprint",
    });
    const tx = {
      $queryRaw: async (_strings: unknown, agentId: string) => agentId === "missing" ? [] : [{ id: agentId }],
      agent: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          if (where.id === "agent-custom") return lockedAgent({
            id: "agent-custom",
            name: "operator-agent",
            model: "custom-model",
            runnerPreference: RunnerPreference.CLAUDE,
          });
          if (where.id === "agent-archived") return lockedAgent({
            id: "agent-archived",
            name: "default",
            archivedAt: new Date(),
            model: canonical!.model,
            runnerPreference: canonical!.runnerPreference,
          });
          if (where.id === "agent-fast-tier") return lockedAgent({
            id: "agent-fast-tier",
            name: nonCodexRole.name,
            model: "gpt-5.6-sol:high",
            runnerPreference: RunnerPreference.CODEX,
            codexServiceTier: CodexServiceTier.FAST,
            runtimeConfigCustomized: true,
          });
          if (where.id === canonical!.id) return canonical;
          return null;
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return { ...canonical, ...data };
        },
      },
    };
    const database = {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const app = createApp(database);
    const request = (agentId: string) => app.request(`/agents/${agentId}/reset-runtime-config`, {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token" },
    });

    assert.equal((await request("missing")).status, 404);
    assert.equal((await request("agent-custom")).status, 400);
    assert.equal((await request("agent-archived")).status, 409);
    const tierRefusal = await request("agent-fast-tier");
    assert.equal(tierRefusal.status, 400);
    assert.deepEqual(await tierRefusal.json(), {
      error: "Fast service tier requires a Codex gpt-* model or a PI openai-codex/* model",
    });
    const reset = await request(canonical!.id);
    assert.equal(reset.status, 200);
    assert.deepEqual(updates, [{
      model: canonicalRole.model,
      runnerPreference: canonicalRole.runnerPreference,
      runtimeConfigCustomized: false,
      runtimeConfigDriftNoticeFingerprint: null,
    }]);
  });
});

test("POST repo validates the raw remote and branch before preflight or database access", async () => {
  await withTokens(async () => {
    let preflightCalls = 0;
    const app = createApp(untouchableDatabase(), {
      repositoryPreflight: async () => { preflightCalls += 1; },
    });
    const request = (body: Record<string, unknown>) => app.request("/projects/project-1/repos", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const base = { name: "app", defaultBranch: "main" };
    for (const [remoteUrl, reason] of [
      [" https://github.com/owner/repo.git", "whitespace"],
      ["https://github.com/owner/repo.git\n", "control-characters"],
      ["https://token@github.com/owner/repo.git", "embedded-credentials"],
      ["deploy@git.example.com:owner/repo.git", "unsupported-ssh-account"],
    ] as const) {
      const response = await request({ ...base, remoteUrl });
      assert.equal(response.status, 400);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), {
        error: "Repository remote is invalid",
        code: "repository-remote-invalid",
        reason,
      });
      assert.equal(text.includes(JSON.stringify(remoteUrl).slice(1, -1)), false);
    }
    const invalidBranch = await request({ ...base, remoteUrl: "https://github.com/owner/repo.git", defaultBranch: "bad branch" });
    assert.equal(invalidBranch.status, 400);
    assert.deepEqual(await invalidBranch.json(), {
      error: "Repository default branch is invalid",
      code: "repository-default-branch-invalid",
    });
    assert.equal(preflightCalls, 0);
  });
});

test("POST repo preflights the exact remote and defaulted branch before its transaction", async () => {
  await withTokens(async () => {
    const preflightInputs: Array<{ remoteUrl: string; defaultBranch: string }> = [];
    let transactions = 0;
    const database = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) => {
        transactions += 1;
        return operation({
          repo: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "repo-1", ...data }) },
        });
      },
    } as unknown as PrismaClient;
    const app = createApp(database, {
      repositoryPreflight: async (input) => { preflightInputs.push(input); },
    });
    const request = (remoteUrl: string, defaultBranch?: string) => app.request("/projects/project-1/repos", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: `app-${preflightInputs.length}`, remoteUrl, ...(defaultBranch === undefined ? {} : { defaultBranch }) }),
    });
    for (const [remoteUrl, defaultBranch] of [
      ["https://github.com/owner/repo.git", "main"],
      ["git@github.com:owner/repo.git", "release/v1"],
      ["file:///path/to/repo.git", "main"],
    ] as const) {
      const response = await request(remoteUrl, defaultBranch);
      assert.equal(response.status, 201);
      const repo = await response.json() as Record<string, unknown>;
      assert.equal(repo.remoteUrl, remoteUrl);
      assert.equal(repo.defaultBranch, defaultBranch);
      assert.equal("grantAgents" in repo, false);
    }
    const defaulted = await request("https://github.com/owner/other.git");
    assert.equal(defaulted.status, 201);
    assert.deepEqual(preflightInputs, [
      { remoteUrl: "https://github.com/owner/repo.git", defaultBranch: "main" },
      { remoteUrl: "git@github.com:owner/repo.git", defaultBranch: "release/v1" },
      { remoteUrl: "file:///path/to/repo.git", defaultBranch: "main" },
      { remoteUrl: "https://github.com/owner/other.git", defaultBranch: "main" },
    ]);
    assert.equal(transactions, 4);
  });
});

test("POST repo refuses an unavailable credential Secret before preflight", async () => {
  await withTokens(async () => {
    let preflightCalls = 0;
    const database = {
      secret: { findFirst: async () => null },
    } as unknown as PrismaClient;
    const app = createApp(database, {
      repositoryPreflight: async () => { preflightCalls += 1; },
    });
    const response = await app.request("/projects/project-1/repos", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "app",
        remoteUrl: "https://github.com/owner/repo.git",
        credentialSecretId: "secret-1",
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Repo credential secret is unavailable" });
    assert.equal(preflightCalls, 0);
  });
});

test("POST repo maps every preflight failure to the exact refusal and writes nothing", async () => {
  await withTokens(async () => {
    let transactions = 0;
    const database = {
      $transaction: async () => { transactions += 1; throw new Error("transaction should not open"); },
    } as unknown as PrismaClient;
    for (const reason of [
      "git-unavailable",
      "git-identity-missing",
      "remote-unreachable",
      "default-branch-missing",
      "push-not-authorized",
      "command-timeout",
    ] as const) {
      const app = createApp(database, {
        repositoryPreflight: async () => { throw new RepositoryPreflightError(reason); },
      });
      const response = await app.request("/projects/project-1/repos", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: `app-${reason}`, remoteUrl: "https://github.com/owner/repo.git", defaultBranch: "main" }),
      });
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), {
        error: "Repository preflight failed",
        code: "repository-preflight-failed",
        reason,
      });
    }
    assert.equal(transactions, 0);
  });
});

test("POST repo optionally grants every active non-integrator Agent atomically", async () => {
  await withTokens(async () => {
    const agents = [
      { id: "agent-1", name: "senior-dev", archivedAt: null },
      { id: "agent-2", name: "review-coordinator-sol", archivedAt: null },
      { id: "agent-3", name: "archived", archivedAt: new Date() },
      { id: "agent-4", name: "merge-integrator", archivedAt: null },
    ];
    const createdGrants: Array<Record<string, unknown>> = [];
    let transactionCalls = 0;
    let agentQueries = 0;
    const database = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) => {
        transactionCalls += 1;
        return operation({
          repo: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "repo-1", ...data }) },
          agent: { findMany: async ({ where }: { where: Record<string, unknown> }) => {
            agentQueries += 1;
            assert.deepEqual(where, { projectId: "project-1", archivedAt: null, name: { not: "merge-integrator" } });
            return agents.filter((agent) => agent.archivedAt === null && agent.name !== "merge-integrator");
          } },
          agentRepoAccess: { create: async ({ data }: { data: Record<string, unknown> }) => {
            createdGrants.push(data);
            return data;
          } },
        });
      },
    } as unknown as PrismaClient;
    const app = createApp(database, { repositoryPreflight: async () => {} });
    const response = await app.request("/projects/project-1/repos", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "app",
        remoteUrl: "https://github.com/owner/repo.git",
        mountPath: "custom-repo",
        grantAgents: true,
      }),
    });
    assert.equal(response.status, 201);
    const payload = await response.json() as { repo: Record<string, unknown>; grants: Array<Record<string, unknown>> };
    assert.equal(payload.repo.mountPath, "custom-repo");
    assert.deepEqual(payload.grants, createdGrants);
    assert.deepEqual(payload.grants.map(({ agentId, permissions, mountPath }) => ({ agentId, permissions, mountPath })), [
      { agentId: "agent-1", permissions: "GIT_WRITE", mountPath: "custom-repo" },
      { agentId: "agent-2", permissions: "GIT_WRITE", mountPath: "custom-repo" },
    ]);
    assert.equal(transactionCalls, 1);
    assert.equal(agentQueries, 1);
  });
});

test("POST repo without grantAgents retains a bare Repo response and creates no grants", async () => {
  await withTokens(async () => {
    let agentQueries = 0;
    const database = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
        repo: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "repo-1", ...data }) },
        agent: { findMany: async () => { agentQueries += 1; return []; } },
        agentRepoAccess: { create: async () => { throw new Error("grant should not be written"); } },
      }),
    } as unknown as PrismaClient;
    const app = createApp(database, { repositoryPreflight: async () => {} });
    for (const grantAgents of [undefined, false]) {
      const response = await app.request("/projects/project-1/repos", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: `app-${String(grantAgents)}`, remoteUrl: "https://github.com/owner/repo.git", ...(grantAgents === undefined ? {} : { grantAgents }) }),
      });
      assert.equal(response.status, 201);
      const repo = await response.json() as Record<string, unknown>;
      assert.equal(repo.id, "repo-1");
      assert.equal("repo" in repo, false);
      assert.equal("grants" in repo, false);
    }
    assert.equal(agentQueries, 0);
  });
});

test("POST repo preserves the duplicate-name refusal and PATCH keeps its trim behavior", async () => {
  await withTokens(async () => {
    let preflightCalls = 0;
    const database = {
      $transaction: async () => {
        throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6.19.0" });
      },
      repo: {
        update: async ({ data }: { data: Record<string, unknown> }) => ({ id: "repo-1", ...data }),
      },
    } as unknown as PrismaClient;
    const app = createApp(database, { repositoryPreflight: async () => { preflightCalls += 1; } });
    const duplicate = await app.request("/projects/project-1/repos", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "app", remoteUrl: "https://github.com/owner/repo.git" }),
    });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: "Unique constraint violated" });

    const patched = await app.request("/repos/repo-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ remoteUrl: "  https://github.com/owner/repo.git  " }),
    });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json() as { remoteUrl: string }).remoteUrl, "https://github.com/owner/repo.git");
    assert.equal(preflightCalls, 1, "PATCH must not invoke the POST preflight operation");
  });
});
