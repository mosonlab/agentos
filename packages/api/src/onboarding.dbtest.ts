import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  NetworkingMode,
  type PrismaClient,
  RepoPermission,
  RunnerPreference,
  SecretPurpose,
  loadStarterAgentSource,
  runVerifyStarterOnboardingCli,
  verifyStarterOnboarding,
} from "@anneal/db";

import {
  createStarterInstallation,
  EXISTING_INSTALLATION,
  type OnboardingInput,
  onboardingStatus,
  STARTER_ENVIRONMENT_NAME,
} from "./onboarding.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

/**
 * OSS-B0 Step 4 against a real PostgreSQL: evidence rows E9 and E10.
 *
 * The claim under test is not "the route returns 201". It is that a fresh
 * database ends up holding *exactly* one Project, one honest `OPEN`
 * Environment, one CODEX starter, one credential-free Repo and one `GIT_WRITE`
 * grant — and that every way this can go wrong (a second installer, a
 * pre-existing installation, a lost response, a failure halfway through) leaves
 * that set either untouched or complete, never half-written.
 *
 * The counts are asserted through `verifyStarterOnboarding`, the same verifier a
 * maintainer runs on a clean host, so the test and the release evidence cannot
 * disagree about what "exactly one installation" means.
 */
let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-onboarding-token";

const asOperator = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    return await operation();
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => asOperator(async () => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
});

const input = (overrides: Partial<OnboardingInput> = {}): Record<string, unknown> => ({
  project: { name: "Fresh Install", slug: "fresh-install" },
  repo: { name: "app", remoteUrl: "https://github.com/owner/name.git", defaultBranch: "main", mountPath: "repo" },
  acknowledgedHostExecution: true,
  ...overrides,
});

const parsedInput = (overrides: Partial<OnboardingInput> = {}): OnboardingInput => ({
  project: { name: "Fresh Install", slug: "fresh-install" },
  repo: { name: "app", remoteUrl: "https://github.com/owner/name.git", defaultBranch: "main", mountPath: "repo" },
  acknowledgedHostExecution: true,
  ...overrides,
});

const nothingWasWritten = async (): Promise<void> => {
  const report = await verifyStarterOnboarding(db);
  assert.deepEqual(
    Object.entries(report.counts).filter(([, count]) => count !== 0),
    [],
    "a refused installation must leave the database empty",
  );
};

test("GET /onboarding on an empty database is incomplete and names the CODEX starter", async () => {
  const response = await call("GET", "/onboarding");
  const starter = await loadStarterAgentSource();
  assert.equal(response.status, 200);
  assert.equal(response.body.complete, false);
  assert.equal(response.body.project, null);
  assert.equal(response.body.starter.runnerPreference, RunnerPreference.CODEX);
  assert.equal(response.body.starter.model, starter.model);
  // The disclosure is machine-readable so the wizard cannot soften it into a
  // containment claim this build does not honour.
  assert.deepEqual(response.body.disclosure, {
    environmentNetworking: "OPEN",
    filesystemGrantCreated: false,
    repoPermission: "GIT_WRITE",
    codexSandbox: "none",
    runsWithHostUserAuthority: true,
    supportedScope: "loopback-only",
    embeddedRemoteCredentialsRejected: true,
  });
  // No prompt, remote or internal id in a first-load payload.
  assert.equal(JSON.stringify(response.body).includes("rolePrompt"), false);
});

test("POST /onboarding creates exactly one installation and nothing else", async () => {
  const created = await call("POST", "/onboarding", input());
  assert.equal(created.status, 201);
  assert.equal(created.body.complete, true);

  const report = await verifyStarterOnboarding(db);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.counts, {
    project: 1,
    environment: 1,
    agent: 1,
    repo: 1,
    agentRepoAccess: 1,
    secret: 0,
    environmentSecret: 0,
    agentSecretGrant: 0,
    filesystemGrant: 0,
    mcpConnection: 0,
    agentMcpConnection: 0,
    skill: 0,
    agentSkill: 0,
    agentCollaboration: 0,
    taskTemplate: 0,
  });

  const starter = await loadStarterAgentSource();
  const environment = await db.environment.findFirstOrThrow();
  const agent = await db.agent.findFirstOrThrow();
  const repo = await db.repo.findFirstOrThrow();
  const access = await db.agentRepoAccess.findFirstOrThrow();
  assert.equal(environment.name, STARTER_ENVIRONMENT_NAME);
  assert.equal(environment.networking, NetworkingMode.OPEN);
  assert.deepEqual(environment.allowedHosts, []);
  assert.equal(agent.runnerPreference, RunnerPreference.CODEX);
  assert.equal(agent.model, starter.model);
  assert.equal(agent.foundationalPrompt, starter.foundationalPrompt);
  assert.equal(agent.rolePrompt, starter.rolePrompt);
  assert.deepEqual(agent.disabledTools, []);
  assert.equal(repo.credentialSecretId, null);
  assert.equal(repo.remoteUrl, "https://github.com/owner/name.git");
  assert.equal(access.permissions, RepoPermission.GIT_WRITE);
  // The literal from plan Step 4, written out rather than compared to the Repo:
  // two rows agreeing on the wrong mount is still not the fixed install shape.
  assert.equal(access.mountPath, "repo");
  assert.equal(repo.mountPath, "repo");
  // Public identities only: the response is what a browser and release evidence
  // both see.
  assert.deepEqual(Object.keys(created.body.repo).sort(), ["defaultBranch", "id", "mountPath", "name"]);
  assert.equal(JSON.stringify(created.body).includes("github.com"), false);
});

test("a second POST is a stable 409 that rewrites nothing, and GET reports the same installation", async () => {
  const created = await call("POST", "/onboarding", input());
  assert.equal(created.status, 201);
  const before = await db.project.findFirstOrThrow();

  const second = await call("POST", "/onboarding", input({ project: { name: "Someone Else", slug: "someone-else" } }));
  assert.equal(second.status, 409);
  assert.equal(second.body.code, EXISTING_INSTALLATION);

  const after = await db.project.findFirstOrThrow();
  assert.deepEqual({ ...after, updatedAt: null }, { ...before, updatedAt: null });
  assert.equal(await db.project.count(), 1);
  assert.deepEqual((await verifyStarterOnboarding(db)).violations, []);

  // The lost-response case: the row committed, the caller never saw the 201, and
  // asking again observes completion instead of duplicating the installation.
  const status = await call("GET", "/onboarding");
  assert.equal(status.body.complete, true);
  assert.equal(status.body.project.id, created.body.project.id);
});

test("an installation that already exists by any other route is never re-seeded", async () => {
  await db.project.create({ data: { name: "Existing", slug: "existing" } });
  const response = await call("POST", "/onboarding", input());
  assert.equal(response.status, 409);
  assert.equal(response.body.code, EXISTING_INSTALLATION);
  assert.equal(await db.environment.count(), 0);
  assert.equal(await db.agent.count(), 0);
  assert.equal(await db.repo.count(), 0);
});

test("two concurrent installers produce exactly one installation and one stable 409", async () => {
  const [first, second] = await Promise.all([
    call("POST", "/onboarding", input({ project: { name: "Racer One", slug: "racer-one" } })),
    call("POST", "/onboarding", input({ project: { name: "Racer Two", slug: "racer-two" } })),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  const loser = first.status === 409 ? first : second;
  assert.equal(loser.body.code, EXISTING_INSTALLATION);
  assert.deepEqual((await verifyStarterOnboarding(db)).violations, []);
});

/** A client whose last create inside the transaction throws. Nothing in
 *  production code knows about it: the failure is injected at the Prisma
 *  boundary, so what is proven is that the transaction — not a cleanup path —
 *  is what removes the partial installation. */
const failingAtTheLastCreate = (real: PrismaClient): PrismaClient => {
  const bind = (target: object, property: string | symbol): unknown => {
    const value = (target as Record<string | symbol, unknown>)[property];
    return typeof value === "function" ? value.bind(target) : value;
  };
  return new Proxy(real, {
    get(target, property) {
      if (property !== "$transaction") return bind(target, property);
      return (run: (tx: unknown) => unknown, options: unknown) => real.$transaction((tx) => run(new Proxy(tx, {
        get(txTarget, txProperty) {
          if (txProperty !== "agentRepoAccess") return bind(txTarget, txProperty);
          return { create: () => { throw new Error("injected failure after the Repo was created"); } };
        },
      })) as never, options as never);
    },
  }) as PrismaClient;
};

test("a failure after the Repo is created rolls the whole installation back", async () => {
  await assert.rejects(
    () => createStarterInstallation(failingAtTheLastCreate(db), parsedInput()),
    /injected failure/u,
  );
  await nothingWasWritten();
});

test("a refused remote, mount or branch writes nothing at all", async () => {
  for (const body of [
    input({ repo: { name: "app", remoteUrl: "https://ghp_token@github.com/owner/name.git", defaultBranch: "main", mountPath: "repo" } }),
    // A token wearing an SSH login's clothes, in both remote spellings.
    input({ repo: { name: "app", remoteUrl: "ghp_exampletoken@github.com:owner/name.git", defaultBranch: "main", mountPath: "repo" } }),
    input({ repo: { name: "app", remoteUrl: "ssh://ghp_exampletoken@github.com/owner/name.git", defaultBranch: "main", mountPath: "repo" } }),
    // Leading control character: refused, not trimmed into acceptance.
    input({ repo: { name: "app", remoteUrl: "\nhttps://github.com/owner/name.git", defaultBranch: "main", mountPath: "repo" } }),
    input({ repo: { name: "app", remoteUrl: "https://github.com/owner/name.git", defaultBranch: "main", mountPath: "/etc" } }),
    // Well formed, still not the fixed first-run shape.
    input({ repo: { name: "app", remoteUrl: "https://github.com/owner/name.git", defaultBranch: "main", mountPath: "src/repo" } }),
    input({ repo: { name: "app", remoteUrl: "https://github.com/owner/name.git", defaultBranch: "main..next", mountPath: "repo" } }),
    input({ acknowledgedHostExecution: false }),
  ]) {
    const response = await call("POST", "/onboarding", body);
    assert.equal(response.status, 400);
    await nothingWasWritten();
  }
});

test("a repo grant cannot reach an agent in another project", async () => {
  await call("POST", "/onboarding", input());
  const repo = await db.repo.findFirstOrThrow();
  const other = await db.project.create({ data: { name: "Other", slug: "other" } });
  const otherEnvironment = await db.environment.create({ data: { projectId: other.id, name: "local", allowedHosts: [] } });
  const otherAgent = await db.agent.create({ data: {
    projectId: other.id, environmentId: otherEnvironment.id, name: "agent", title: "Agent", model: "claude",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  // The composite foreign keys carry the project on both sides, so a
  // cross-project grant is not a rule the API enforces — it is unrepresentable.
  await assert.rejects(() => db.agentRepoAccess.create({
    data: { agentId: otherAgent.id, repoId: repo.id, projectId: other.id, mountPath: "repo", permissions: RepoPermission.GIT_WRITE },
  }));
});

test("the verifier passes on a clean installation and stops on anything extra", async () => {
  await call("POST", "/onboarding", input());
  const lines: string[] = [];
  const stops: string[] = [];
  assert.equal(await runVerifyStarterOnboardingCli({ db, log: (line) => lines.push(line), error: (line) => stops.push(line) }), 0);
  assert.deepEqual(stops, []);
  assert.ok(lines.includes("starter-onboarding PASS"));
  assert.ok(lines.includes("starter-onboarding count agentRepoAccess 1"));
  assert.ok(lines.includes("starter-onboarding access GIT_WRITE mountPath=repo"));
  // Counts and statuses only: no id, prompt or remote may reach release evidence.
  assert.equal(lines.some((line) => line.includes("github.com")), false);

  await db.filesystemGrant.create({ data: {
    agentId: (await db.agent.findFirstOrThrow()).id, folderPath: "", canRead: true,
  } });
  const afterLines: string[] = [];
  const afterStops: string[] = [];
  assert.equal(
    await runVerifyStarterOnboardingCli({ db, log: (line) => afterLines.push(line), error: (line) => afterStops.push(line) }),
    1,
  );
  assert.deepEqual(afterStops, ["STOP starter-onboarding filesystemGrant-count-1-expected-0"]);
});

test("the verifier stops when the starter is not the release-owned CODEX source", async () => {
  await call("POST", "/onboarding", input());
  await db.agent.update({
    where: { id: (await db.agent.findFirstOrThrow()).id },
    data: { runnerPreference: RunnerPreference.CLAUDE, model: "claude-opus-5:high" },
  });
  const report = await verifyStarterOnboarding(db);
  assert.deepEqual(report.violations.sort(), [
    "starter-model-differs-from-agents-contract",
    "starter-runner-CLAUDE-expected-CODEX",
  ]);
});

test("the verifier stops on a LIMITED environment, a credential-bearing repo, a moved mount and a read-only grant", async () => {
  await call("POST", "/onboarding", input());
  await db.environment.update({
    where: { id: (await db.environment.findFirstOrThrow()).id },
    data: { networking: NetworkingMode.LIMITED, allowedHosts: ["example.test"] },
  });
  const secret = await db.secret.create({
    data: { name: "repo-credential", encryptedValue: "ciphertext", purpose: SecretPurpose.REPO },
  });
  const repo = await db.repo.findFirstOrThrow();
  await db.repo.update({ where: { id: repo.id }, data: { credentialSecretId: secret.id, mountPath: "src/repo" } });
  const access = await db.agentRepoAccess.findFirstOrThrow();
  await db.agentRepoAccess.update({
    where: { agentId_repoId: { agentId: access.agentId, repoId: access.repoId } },
    data: { permissions: RepoPermission.GIT_READ, mountPath: "src/repo" },
  });
  const report = await verifyStarterOnboarding(db);
  assert.deepEqual(report.violations.sort(), [
    "access-mount-path-src/repo-expected-repo",
    "access-permissions-GIT_READ-expected-GIT_WRITE",
    "environment-allowed-hosts-not-empty",
    "environment-networking-LIMITED-expected-OPEN",
    "repo-credential-secret-present",
    "secret-count-1-expected-0",
  ]);
  assert.equal(report.repo?.credential, "present");
});

test("completion is reported from the Project row even when the starter source cannot be read", async () => {
  const unreadable = (): Promise<never> => Promise.reject(new Error("agents/ is not readable in this deployment"));
  // Before any installation the wizard simply has no starter preview to show.
  const empty = await onboardingStatus(db, unreadable);
  assert.deepEqual({ complete: empty.complete, starter: empty.starter }, { complete: false, starter: null });

  const created = await call("POST", "/onboarding", input());
  assert.equal(created.status, 201);
  // After it, an unreadable source must not turn a committed installation into
  // a failure: the lost-response recovery reads durable rows and nothing else.
  const status = await onboardingStatus(db, unreadable);
  assert.equal(status.complete, true);
  assert.equal(status.project?.id, created.body.project.id);
  assert.equal(status.starter, null);
});
