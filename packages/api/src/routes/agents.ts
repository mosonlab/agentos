import {
  ACTIVE_RUN_STATUSES,
  agentArchiveBlocker,
  catalogRunnerForModel,
  CodexServiceTier,
  INTEGRATOR_AGENT_NAME,
  loadAgentSources,
  lockAgentRepoGrantForRevocation,
  lockAgentRow,
  Prisma,
  RepoPermission,
  RunnerKind,
  runnerFor,
  RunnerPreference,
  SkillKind,
  TaskStatus,
} from "@anneal/db";
import type {
  Agent as AgentContract,
  AgentRepoAccess as AgentRepoAccessContract,
  DependencyProvisioning,
  FilesystemGrant as FilesystemGrantContract,
  MCPConnection as MCPConnectionContract,
  Repo as RepoContract,
  Skill as SkillContract,
} from "@anneal/db/wire-contract";
import type { Context } from "hono";
import { z } from "zod";

import { jsonValue } from "../execution.js";
import { filesRootGrantKey } from "../files/config.js";
import { isCanonicalRelPath, normalizeRelPath } from "../files/paths.js";
import { isValidBranchName, parseRepoRemote } from "../onboarding.js";
import { RepositoryPreflightError } from "../onboarding-preflight.js";
import { noteArchivedQueuedRuns } from "../reconcile.js";
import { readCommitted } from "../transaction.js";
import { withoutUndefined } from "../without-undefined.js";
import {
  id,
  readJson,
  refusal,
  refusalJson,
  secretPublicSelect,
  validated,
} from "./support.js";
import type { RouteApp, RouteDeps } from "./support.js";

/**
 * The eight canonical tool keys. Mirrored by apps/web/src/lib/tools.ts (labels and
 * per-runner enforcement) and packages/runner/src/adapters.ts (CLI flag names).
 * The three lists cross workspaces and cannot import each other; each names the
 * other two so a change here is followed there.
 */
const TOOL_KEYS = ["BASH", "READ", "WRITE", "EDIT", "GLOB", "GREP", "WEB_FETCH", "WEB_SEARCH"] as const;
const agentFields = {
  environmentId: id,
  name: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(120),
  codexServiceTier: z.nativeEnum(CodexServiceTier),
  foundationalPrompt: z.string().min(1),
  rolePrompt: z.string().min(1),
  runnerPreference: z.nativeEnum(RunnerPreference),
  inboxAccess: z.boolean(),
  // Denied set, not allowed set: omitting it keeps the column's empty default.
  disabledTools: z.array(z.enum(TOOL_KEYS)).max(TOOL_KEYS.length),
};
const agentInput = z.object({
  ...agentFields,
  foundationalPrompt: agentFields.foundationalPrompt.optional(),
  codexServiceTier: agentFields.codexServiceTier.default(CodexServiceTier.DEFAULT),
  runnerPreference: agentFields.runnerPreference.default(RunnerPreference.INHERIT),
  inboxAccess: agentFields.inboxAccess.default(false),
  // `.default([])` rather than `.optional()`: under exactOptionalPropertyTypes an
  // optional key would spread `undefined` into `agent.create`. The empty array is
  // byte-identical to the column default, so omission still means "no restriction".
  disabledTools: agentFields.disabledTools.default([]),
});
const agentPatch = z.object(agentFields).partial().refine((value) => Object.keys(value).length > 0);

const codexServiceTierRefusal = (agent: {
  model: string;
  runnerPreference: RunnerPreference;
  codexServiceTier: CodexServiceTier;
}): string | null => {
  if (agent.codexServiceTier === CodexServiceTier.DEFAULT) return null;
  const model = agent.model.slice(0, agent.model.lastIndexOf(":") > 0 ? agent.model.lastIndexOf(":") : agent.model.length);
  const runner = runnerFor(agent.runnerPreference, agent.model);
  if (runner === RunnerKind.CODEX && model.startsWith("gpt-")) return null;
  if (runner === RunnerKind.PI && model.startsWith("openai-codex/")) return null;
  return "Fast service tier requires a Codex gpt-* model or a PI openai-codex/* model";
};

const runnerModelRefusal = (agent: { model: string; runnerPreference: RunnerPreference }): string | null => {
  const expected = catalogRunnerForModel(agent.model);
  if (!expected || agent.runnerPreference === RunnerPreference.AUTO || agent.runnerPreference === RunnerPreference.INHERIT
    || expected === agent.runnerPreference) return null;
  return `Model ${agent.model} requires ${expected}, but this Agent stores ${agent.runnerPreference}`;
};

const executionerRuntimeRefusal = (agent: {
  name: string;
  model: string;
  runnerPreference: RunnerPreference;
}): string | null => {
  if (agent.name !== "implementation-plan-executioner") return null;
  if (runnerFor(agent.runnerPreference, agent.model) === RunnerKind.CODEX
    && catalogRunnerForModel(agent.model) === RunnerPreference.CODEX) return null;
  return "implementation-plan-executioner requires a Codex gpt-* model";
};

const runtimeConfigRefusal = (agent: {
  name: string;
  model: string;
  runnerPreference: RunnerPreference;
  codexServiceTier: CodexServiceTier;
}): string | null => (
  runnerModelRefusal(agent)
  ?? executionerRuntimeRefusal(agent)
  ?? codexServiceTierRefusal(agent)
);

const isDependencyProvisioning = (value: unknown): value is DependencyProvisioning => (
  value === "NONE" || value === "NPM_CI"
);
const dependencyProvisioningInput = z.unknown().optional();
const dependencyProvisioningInvalid = {
  error: "Repository dependency provisioning is invalid",
  code: "repository-dependency-provisioning-invalid",
} as const;

const repositoryPreflightRefusal = (context: Context, error: unknown): Response | undefined => {
  if (!(error instanceof RepositoryPreflightError)) return undefined;
  if (error.reason === "package-lock-missing") {
    return context.json({
      error: "Repository preflight failed",
      code: "repository-package-lock-missing",
      remedy: "Commit package-lock.json at the repository root on the default branch, or choose dependencyProvisioning NONE.",
    }, 422);
  }
  if (error.reason === "dependency-provisioning-contradicts-lockfile") {
    return context.json({
      error: "Repository dependency provisioning contradicts lockfile",
      code: "repository-dependency-provisioning-contradicts-lockfile",
      remedy: "Choose dependencyProvisioning NPM_CI for repositories with a root package-lock.json.",
    }, 400);
  }
  return context.json({
    error: "Repository preflight failed",
    code: "repository-preflight-failed",
    reason: error.reason,
  }, 422);
};

const repoInput = z.object({
  name: z.string().trim().min(1).max(120),
  remoteUrl: z.string().trim().min(1),
  mountPath: z.string().trim().min(1).default("repo"),
  defaultBranch: z.string().trim().min(1).default("main"),
  credentialSecretId: id.nullable().default(null),
  dependencyProvisioning: dependencyProvisioningInput,
});
// Keep remoteUrl raw wherever repository policy runs. A leading newline or
// trailing tab is itself invalid input; trimming before parseRepoRemote would
// silently turn it into a different, accepted value.
const repoCreateInput = repoInput.extend({
  remoteUrl: z.string(),
  grantAgents: z.boolean().default(false),
});
const repoAccessInput = z.object({
  permissions: z.nativeEnum(RepoPermission).default(RepoPermission.GIT_WRITE),
  mountPath: z.string().trim().min(1).default("repo"),
});
const repoPatch = repoInput.partial().extend({
  remoteUrl: z.string().refine((value) => value.trim().length > 0).optional(),
}).refine((value) => Object.keys(value).length > 0);
const secretGrantInput = z.object({ secretId: id, envVar: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) });
const skillBindingInput = z.object({ skillId: id });
const mcpBindingInput = z.object({ mcpConnectionId: id });
const skillInput = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  kind: z.nativeEnum(SkillKind),
  body: z.string().nullable().default(null),
  filePath: z.string().trim().min(1).nullable().default(null),
}).superRefine((value, context) => {
  if (value.kind === SkillKind.PROMPT && value.body === null) context.addIssue({ code: "custom", message: "Prompt skills require body" });
  if (value.kind === SkillKind.FILE && value.filePath === null) context.addIssue({ code: "custom", message: "File skills require filePath" });
});
const mcpConnectionInput = z.object({
  name: z.string().trim().min(1).max(120),
  transport: z.string().trim().min(1).max(80),
  config: z.record(z.string(), z.unknown()).default({}),
  allowedOperations: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
  credentialSecretId: id.nullable().default(null),
});
const filesystemGrantFields = z.object({
  // "" is the sentinel for "the whole Files Root" (schema.prisma), so validation has to run
  // on the pre-trim value: a trailing `.trim()` before `.refine()` turns " " into ""
  // and hands a typo the entire root. Trimming still happens, but only for a real path.
  folderPath: z.string().max(4096).refine(
    (value) => (value.trim() === "" ? value === "" : isCanonicalRelPath(value.trim())),
    'folderPath must be "" (the whole Files Root) or a normalized Files-Root-relative POSIX path',
  ).transform((value) => value.trim()),
  canRead: z.boolean().default(false),
  canWrite: z.boolean().default(false),
  canDelete: z.boolean().default(false),
});
const filesystemGrantInput = filesystemGrantFields.refine(
  (value) => value.canRead || value.canWrite || value.canDelete,
  "At least one filesystem permission is required",
);
const filesystemGrantPatch = filesystemGrantFields.partial().refine((value) => Object.keys(value).length > 0);
const collaboratorInput = z.object({ allowedAgentId: id });

type AgentResponse = AgentContract<Date>;
type SkillResponse = SkillContract<Date>;
type MCPConnectionResponse = MCPConnectionContract<Date>;
type RepoResponse = RepoContract<Date>;

export const registerAgentsRoutes = (app: RouteApp, deps: RouteDeps): void => {
  const { db } = deps;

  // §D-P4. The sentinel Agent row exists so step 12 can carry a non-null
  // `Run.agentId`; it is not something an operator may assign. It is returned
  // rather than hidden so an operator can still see that it exists and read its
  // role prompt, but `assignable: false` is what the pickers filter on — and
  // `POST /projects/:projectId/tasks` refuses it regardless of any client.
  app.get("/projects/:projectId/agents", async (context) => validated(context, (await db.agent.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    orderBy: { createdAt: "asc" },
  })).map((agent) => {
    const mechanical = agent.name === INTEGRATOR_AGENT_NAME;
    return { ...agent, mechanical, assignable: !mechanical };
  }) satisfies AgentResponse[]));
  app.post("/projects/:projectId/agents", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, agentInput);
    const runtimeRefusal = runtimeConfigRefusal(body);
    if (runtimeRefusal) return context.json({ error: runtimeRefusal }, 400);
    const environment = await db.environment.findFirst({ where: { id: body.environmentId, projectId } });
    if (!environment) return context.json({ error: "Environment does not belong to this project" }, 400);
    const foundationalPrompt = body.foundationalPrompt ?? (await db.agent.findFirst({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      select: { foundationalPrompt: true },
    }))?.foundationalPrompt;
    if (foundationalPrompt === undefined) {
      return context.json({ error: "This project has no foundation yet. Run npm run db:seed." }, 400);
    }
    return context.json((await db.agent.create({
      data: { ...body, foundationalPrompt, projectId },
    })) satisfies AgentResponse, 201);
  });
  app.get("/agents/:agentId", async (context) => {
    const agent = await db.agent.findUnique({
      where: { id: id.parse(context.req.param("agentId")) },
      include: {
        environment: true,
        skills: { include: { skill: true } },
        mcpConnections: { include: { mcpConnection: true } },
        repoAccess: { include: { repo: true } },
        secretGrants: { include: { secret: { select: secretPublicSelect } } },
        filesystemGrants: true,
        collaborators: { include: { allowedAgent: true } },
      },
    });
    return agent ? context.json(agent satisfies AgentResponse) : context.json({ error: "Agent not found" }, 404);
  });
  app.patch("/agents/:agentId", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const body = await readJson(context.req.raw, agentPatch);
    const result = await db.$transaction(async (tx) => {
      const before = await lockAgentRow(tx, agentId);
      if (!before) return refusal("not-found", "Agent not found");
      const patch = withoutUndefined(body);
      const merged = { ...before, ...patch };
      if (before.name === "implementation-plan-executioner" && merged.name !== before.name) {
        return refusal("invalid-request", "implementation-plan-executioner is a canonical Agent name and cannot be changed");
      }
      const runtimeRefusal = runtimeConfigRefusal(merged);
      if (runtimeRefusal) return refusal("invalid-request", runtimeRefusal);
      if (body.environmentId) {
        const environment = await tx.environment.findFirst({ where: { id: body.environmentId, projectId: before.projectId } });
        if (!environment) return refusal("invalid-request", "Environment does not belong to this project");
      }
      return { agent: await tx.agent.update({
        where: { id: agentId },
        data: {
          ...patch,
          ...((body.model !== undefined && body.model !== before.model)
            || (body.runnerPreference !== undefined && body.runnerPreference !== before.runnerPreference)
            ? { runtimeConfigCustomized: true }
            : {}),
        } as Prisma.AgentUncheckedUpdateInput,
      }) };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.agent satisfies AgentResponse);
  });
  app.post("/agents/:agentId/reset-runtime-config", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    // Load the complete role contract before opening the write transaction. A
    // missing or malformed source is a release error and must not turn into a
    // best-effort reset that guesses at the canonical values.
    const sources = await loadAgentSources();
    const rolesByName = new Map(sources.roles.map((role) => [role.name, role]));
    const result = await db.$transaction(async (tx) => {
      const before = await lockAgentRow(tx, agentId);
      if (!before) return refusal("not-found", "Agent not found");
      if (before.archivedAt) return refusal("conflict", "Cannot reset runtime configuration for an archived Agent");
      const role = rolesByName.get(before.name);
      if (!role) return refusal("invalid-request", `Agent ${before.name} has no canonical role source`);
      const runtimeRefusal = runtimeConfigRefusal({
        name: before.name,
        model: role.model,
        runnerPreference: role.runnerPreference,
        codexServiceTier: before.codexServiceTier,
      });
      if (runtimeRefusal) return refusal("invalid-request", runtimeRefusal);
      return { agent: await tx.agent.update({
        where: { id: agentId },
        data: {
          model: role.model,
          runnerPreference: role.runnerPreference,
          runtimeConfigCustomized: false,
          runtimeConfigDriftNoticeFingerprint: null,
        },
      }) };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.agent satisfies AgentResponse);
  });
  app.delete("/agents/:agentId", async (context) => {
    try {
      await db.agent.delete({ where: { id: id.parse(context.req.param("agentId")) } });
      return context.body(null, 204);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
        return context.json({ error: "Agent has task history; archive it instead" }, 409);
      }
      throw error;
    }
  });
  // Archive is one side of the Agent-row exclusion protocol (see lockAgentRow).
  // It takes the same mutex every assignment and run writer takes, and inside it
  // it fails closed: an agent with a live task or run reference stays unarchived
  // rather than stranding work nothing will ever claim. Re-archiving an already
  // archived agent stays idempotent and keeps the original timestamp.
  app.post("/agents/:agentId/archive", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const now = new Date();
    const result = await readCommitted(db, async (tx) => {
      const locked = await lockAgentRow(tx, agentId);
      if (!locked) return refusal("not-found", "Agent not found");
      const agent = await tx.agent.findUniqueOrThrow({ where: { id: agentId } });
      if (agent.archivedAt) return { agent };
      const blocker = await agentArchiveBlocker(tx, agentId);
      if (blocker) return refusal("conflict", blocker);
      return { agent: await tx.agent.update({ where: { id: agentId }, data: { archivedAt: now } }) };
    });
    if ("message" in result) return refusalJson(context, result);
    // Unchanged sweep: rows archived before this protocol existed — or queued by
    // a writer that committed first — still get their explanatory activity.
    await noteArchivedQueuedRuns(db, { agentId });
    return context.json(result.agent satisfies AgentResponse);
  });
  app.post("/agents/:agentId/unarchive", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const agent = await db.agent.findUnique({ where: { id: agentId } });
    if (!agent) return context.json({ error: "Agent not found" }, 404);
    if (!agent.archivedAt) return context.json(agent satisfies AgentResponse);
    return context.json((await db.agent.update({
      where: { id: agentId },
      data: { archivedAt: null },
    })) satisfies AgentResponse);
  });

  app.get("/agents/:agentId/secret-grants", async (context) => context.json(await db.agentSecretGrant.findMany({
    where: { agentId: id.parse(context.req.param("agentId")) },
    include: { secret: { select: secretPublicSelect } },
    orderBy: { envVar: "asc" },
  })));
  app.post("/agents/:agentId/secret-grants", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const body = await readJson(context.req.raw, secretGrantInput);
    if (["OPERATOR_TOKEN", "RUNNER_TOKEN", "AGENTOS_API_TOKEN", "AGENTOS_SESSION_TOKEN", "AGENTOS_FENCING_TOKEN"].includes(body.envVar)) {
      return context.json({ error: `Secret grant may not override reserved principal variable ${body.envVar}` }, 400);
    }
    const [agent, secret] = await Promise.all([
      db.agent.findUnique({ where: { id: agentId }, select: { id: true } }),
      db.secret.findFirst({ where: { id: body.secretId, disabledAt: null }, select: { id: true } }),
    ]);
    if (!agent || !secret) return context.json({ error: "Agent or available Secret not found" }, 404);
    return context.json(await db.agentSecretGrant.upsert({
      where: { agentId_envVar: { agentId, envVar: body.envVar } },
      create: { agentId, ...body },
      update: { secretId: body.secretId },
    }), 201);
  });
  app.delete("/agents/:agentId/secret-grants/:secretId/:envVar", async (context) => {
    await db.agentSecretGrant.delete({ where: { agentId_secretId_envVar: {
      agentId: id.parse(context.req.param("agentId")),
      secretId: id.parse(context.req.param("secretId")),
      envVar: z.string().min(1).parse(context.req.param("envVar")),
    } } });
    return context.body(null, 204);
  });

  app.get("/agents/:agentId/filesystem-grants", async (context) => context.json((await db.filesystemGrant.findMany({
    where: { agentId: id.parse(context.req.param("agentId")) }, orderBy: { folderPath: "asc" },
  })) satisfies FilesystemGrantContract[]));
  /**
   * Two spellings of one physical folder must not become two grants. On a case- and
   * normalization-insensitive volume `protected` and `Protected` are the same directory,
   * so a read-only grant on one plus a writable grant on the other is read-write on that
   * directory -- and the console renders the two rows identically, so nobody sees it.
   */
  const aliasingGrant = async (agentId: string, folderPath: string, exclude?: string): Promise<string | null> => {
    const key = await filesRootGrantKey(normalizeRelPath(folderPath));
    if (key === null) return null;
    const existing = await db.filesystemGrant.findMany({ where: { agentId } });
    for (const grant of existing) {
      if (grant.folderPath === folderPath || grant.id === exclude) continue;
      let other: string | null;
      try {
        other = await filesRootGrantKey(normalizeRelPath(grant.folderPath));
      } catch {
        continue;
      }
      if (other !== null && other === key) return grant.folderPath;
    }
    return null;
  };
  const aliasConflict = (context: Context, folderPath: string, existing: string): Response => context.json({
    error: `folderPath "${folderPath}" resolves to the same folder as the existing grant "${existing}"; edit that grant instead`,
  }, 409);

  app.post("/agents/:agentId/filesystem-grants", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const body = await readJson(context.req.raw, filesystemGrantInput);
    const aliased = await aliasingGrant(agentId, body.folderPath);
    if (aliased !== null) return aliasConflict(context, body.folderPath, aliased);
    return context.json((await db.filesystemGrant.upsert({
      where: { agentId_folderPath: { agentId, folderPath: body.folderPath } },
      create: { agentId, ...body },
      update: body,
    })) satisfies FilesystemGrantContract, 201);
  });
  app.patch("/agents/:agentId/filesystem-grants/:grantId", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const grantId = id.parse(context.req.param("grantId"));
    const existing = await db.filesystemGrant.findFirst({ where: { id: grantId, agentId } });
    if (!existing) return context.json({ error: "Filesystem grant not found" }, 404);
    const patch = await readJson(context.req.raw, filesystemGrantPatch);
    if (patch.folderPath !== undefined) {
      const aliased = await aliasingGrant(agentId, patch.folderPath, grantId);
      if (aliased !== null) return aliasConflict(context, patch.folderPath, aliased);
    }
    return context.json((await db.filesystemGrant.update({
      where: { id: grantId },
      data: withoutUndefined(patch) as Prisma.FilesystemGrantUncheckedUpdateInput,
    })) satisfies FilesystemGrantContract);
  });
  app.delete("/agents/:agentId/filesystem-grants/:grantId", async (context) => {
    const deleted = await db.filesystemGrant.deleteMany({ where: {
      id: id.parse(context.req.param("grantId")), agentId: id.parse(context.req.param("agentId")),
    } });
    return deleted.count === 1 ? context.body(null, 204) : context.json({ error: "Filesystem grant not found" }, 404);
  });

  app.post("/agents/:agentId/collaborators", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const { allowedAgentId } = await readJson(context.req.raw, collaboratorInput);
    if (agentId === allowedAgentId) return context.json({ error: "An agent cannot collaborate with itself" }, 400);
    const agents = await db.agent.findMany({ where: { id: { in: [agentId, allowedAgentId] } }, select: { id: true, projectId: true } });
    if (agents.length !== 2) return context.json({ error: "Agent or collaborator not found" }, 404);
    if (agents[0]!.projectId !== agents[1]!.projectId) return context.json({ error: "Collaborators belong to different projects" }, 400);
    return context.json(await db.agentCollaboration.upsert({
      where: { agentId_allowedAgentId: { agentId, allowedAgentId } },
      create: { agentId, allowedAgentId, projectId: agents[0]!.projectId }, update: {},
    }), 201);
  });
  app.delete("/agents/:agentId/collaborators/:allowedAgentId", async (context) => {
    const deleted = await db.agentCollaboration.deleteMany({ where: {
      agentId: id.parse(context.req.param("agentId")), allowedAgentId: id.parse(context.req.param("allowedAgentId")),
    } });
    return deleted.count === 1 ? context.body(null, 204) : context.json({ error: "Collaboration binding not found" }, 404);
  });

  app.get("/projects/:projectId/skills", async (context) => context.json((await db.skill.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    include: { agents: true },
    orderBy: { createdAt: "asc" },
  })) satisfies SkillResponse[]));
  app.post("/projects/:projectId/skills", async (context) => {
    const body = await readJson(context.req.raw, skillInput);
    return context.json((await db.skill.create({
      data: { projectId: id.parse(context.req.param("projectId")), ...body },
    })) satisfies SkillResponse, 201);
  });
  app.post("/agents/:agentId/skills", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const { skillId } = await readJson(context.req.raw, skillBindingInput);
    const [agent, skill] = await Promise.all([
      db.agent.findUnique({ where: { id: agentId }, select: { projectId: true } }),
      db.skill.findUnique({ where: { id: skillId }, select: { projectId: true } }),
    ]);
    if (!agent || !skill) return context.json({ error: "Agent or Skill not found" }, 404);
    if (agent.projectId !== skill.projectId) return context.json({ error: "Agent and Skill belong to different projects" }, 400);
    return context.json(await db.agentSkill.upsert({
      where: { agentId_skillId: { agentId, skillId } },
      create: { agentId, skillId, projectId: agent.projectId }, update: {},
    }), 201);
  });
  app.delete("/agents/:agentId/skills/:skillId", async (context) => {
    const deleted = await db.agentSkill.deleteMany({ where: {
      agentId: id.parse(context.req.param("agentId")), skillId: id.parse(context.req.param("skillId")),
    } });
    return deleted.count === 1 ? context.body(null, 204) : context.json({ error: "Skill binding not found" }, 404);
  });

  app.get("/projects/:projectId/mcp-connections", async (context) => context.json((await db.mCPConnection.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    include: { agents: true },
    orderBy: { createdAt: "asc" },
  })) satisfies MCPConnectionResponse[]));
  app.post("/projects/:projectId/mcp-connections", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, mcpConnectionInput);
    if (body.credentialSecretId) {
      const secret = await db.secret.findFirst({ where: { id: body.credentialSecretId, disabledAt: null } });
      if (!secret) return context.json({ error: "MCP credential secret is unavailable" }, 400);
    }
    return context.json((await db.mCPConnection.create({
      data: { ...body, config: jsonValue(body.config), projectId },
    })) satisfies MCPConnectionResponse, 201);
  });
  app.post("/agents/:agentId/mcp-connections", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const { mcpConnectionId } = await readJson(context.req.raw, mcpBindingInput);
    const [agent, connection] = await Promise.all([
      db.agent.findUnique({ where: { id: agentId }, select: { projectId: true } }),
      db.mCPConnection.findUnique({ where: { id: mcpConnectionId }, select: { projectId: true } }),
    ]);
    if (!agent || !connection) return context.json({ error: "Agent or MCP connection not found" }, 404);
    if (agent.projectId !== connection.projectId) return context.json({ error: "Agent and MCP connection belong to different projects" }, 400);
    return context.json(await db.agentMCPConnection.upsert({
      where: { agentId_mcpConnectionId: { agentId, mcpConnectionId } },
      create: { agentId, mcpConnectionId, projectId: agent.projectId }, update: {},
    }), 201);
  });
  app.delete("/agents/:agentId/mcp-connections/:connectionId", async (context) => {
    const deleted = await db.agentMCPConnection.deleteMany({ where: {
      agentId: id.parse(context.req.param("agentId")), mcpConnectionId: id.parse(context.req.param("connectionId")),
    } });
    return deleted.count === 1 ? context.body(null, 204) : context.json({ error: "MCP binding not found" }, 404);
  });

  app.get("/projects/:projectId/repos", async (context) => validated(context, (await db.repo.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    orderBy: { createdAt: "asc" },
  })) satisfies RepoResponse[]));
  app.post("/projects/:projectId/repos", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, repoCreateInput);
    const dependencyProvisioning = body.dependencyProvisioning;
    if (!isDependencyProvisioning(dependencyProvisioning)) return context.json(dependencyProvisioningInvalid, 400);
    const remote = parseRepoRemote(body.remoteUrl);
    if (!remote.ok) {
      return context.json({
        error: "Repository remote is invalid",
        code: "repository-remote-invalid",
        reason: remote.reason,
      }, 400);
    }
    if (!isValidBranchName(body.defaultBranch)) {
      return context.json({
        error: "Repository default branch is invalid",
        code: "repository-default-branch-invalid",
      }, 400);
    }
    if (body.credentialSecretId) {
      const secret = await db.secret.findFirst({ where: { id: body.credentialSecretId, disabledAt: null } });
      if (!secret) return context.json({ error: "Repo credential secret is unavailable" }, 400);
    }
    try {
      await deps.repositoryPreflight({
        remoteUrl: remote.remoteUrl,
        defaultBranch: body.defaultBranch,
        dependencyProvisioning,
      });
    } catch (error: unknown) {
      const refusal = repositoryPreflightRefusal(context, error);
      if (refusal) return refusal;
      throw error;
    }
    const { grantAgents, ...repoFields } = body;
    const result = await readCommitted(db, async (tx) => {
      const repo = await tx.repo.create({
        data: { ...repoFields, dependencyProvisioning, projectId },
      });
      if (!grantAgents) return repo;
      const agents = await tx.agent.findMany({
        where: { projectId, archivedAt: null, name: { not: INTEGRATOR_AGENT_NAME } },
        orderBy: { id: "asc" },
      });
      const grants = [];
      for (const agent of agents) {
        grants.push(await tx.agentRepoAccess.create({
          data: {
            agentId: agent.id,
            repoId: repo.id,
            projectId,
            permissions: RepoPermission.GIT_WRITE,
            mountPath: repo.mountPath,
          },
        }));
      }
      return { repo, grants };
    });
    return context.json(result satisfies RepoResponse | { repo: RepoResponse; grants: AgentRepoAccessContract[] }, 201);
  });
  app.patch("/repos/:repoId", async (context) => {
    const submitted = await readJson(context.req.raw, repoPatch);
    const body = submitted.remoteUrl === undefined
      ? submitted
      : { ...submitted, remoteUrl: submitted.remoteUrl.trim() };
    if (body.dependencyProvisioning !== undefined && !isDependencyProvisioning(body.dependencyProvisioning)) {
      return context.json(dependencyProvisioningInvalid, 400);
    }
    const repoId = id.parse(context.req.param("repoId"));
    if (body.credentialSecretId) {
      const secret = await db.secret.findFirst({ where: { id: body.credentialSecretId, disabledAt: null } });
      if (!secret) return context.json({ error: "Repo credential secret is unavailable" }, 400);
    }
    if (body.dependencyProvisioning !== undefined) {
      const stored = await db.repo.findUnique({
        where: { id: repoId },
        select: { remoteUrl: true, defaultBranch: true },
      });
      if (!stored) return refusalJson(context, refusal("not-found", "Resource not found"));
      const remote = parseRepoRemote(submitted.remoteUrl ?? stored.remoteUrl);
      if (!remote.ok) {
        return context.json({
          error: "Repository remote is invalid",
          code: "repository-remote-invalid",
          reason: remote.reason,
        }, 400);
      }
      const defaultBranch = body.defaultBranch ?? stored.defaultBranch;
      if (!isValidBranchName(defaultBranch)) {
        return context.json({
          error: "Repository default branch is invalid",
          code: "repository-default-branch-invalid",
        }, 400);
      }
      try {
        await deps.repositoryPreflight({
          remoteUrl: remote.remoteUrl,
          defaultBranch,
          dependencyProvisioning: body.dependencyProvisioning,
        });
      } catch (error: unknown) {
        const refusal = repositoryPreflightRefusal(context, error);
        if (refusal) return refusal;
        throw error;
      }
    }
    return context.json((await db.repo.update({
      where: { id: repoId }, data: withoutUndefined(body),
    })) satisfies RepoResponse);
  });
  app.delete("/repos/:repoId", async (context) => {
    await db.repo.delete({ where: { id: id.parse(context.req.param("repoId")) } });
    return context.body(null, 204);
  });
  app.post("/agents/:agentId/repos/:repoId/access", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const repoId = id.parse(context.req.param("repoId"));
    const body = await readJson(context.req.raw, repoAccessInput);
    const [agent, repo] = await Promise.all([
      db.agent.findUnique({ where: { id: agentId }, select: { projectId: true } }),
      db.repo.findUnique({ where: { id: repoId }, select: { projectId: true } }),
    ]);
    if (!agent || !repo) return context.json({ error: "Agent or Repo not found" }, 404);
    if (agent.projectId !== repo.projectId) return context.json({ error: "Agent and Repo belong to different projects" }, 400);
    return context.json((await db.agentRepoAccess.upsert({
      where: { agentId_repoId: { agentId, repoId } },
      create: { agentId, repoId, projectId: agent.projectId, ...body },
      update: body,
    })) satisfies AgentRepoAccessContract, 201);
  });
  app.delete("/agents/:agentId/repos/:repoId/access", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const repoId = id.parse(context.req.param("repoId"));
    const grant = await db.agentRepoAccess.findUnique({
      where: { agentId_repoId: { agentId, repoId } }, select: { projectId: true },
    });
    if (!grant) return context.json({ error: "Repo access not found" }, 404);
    const result = await db.$transaction(async (tx) => {
      if (!await lockAgentRepoGrantForRevocation(tx, { projectId: grant.projectId, agentId, repoId })) {
        return refusal("not-found", "Repo access not found");
      }
      const active = await tx.run.count({ where: { agentId, repoId, status: { in: ACTIVE_RUN_STATUSES } } });
      if (active > 0) return refusal("conflict", "Cannot revoke repo access while the agent has an active run on this Repo");
      const dependentSteps = await tx.task.count({ where: {
        projectId: grant.projectId,
        repoId,
        assigneeAgentId: agentId,
        chainId: { not: null },
        archivedAt: null,
        status: { in: [TaskStatus.BACKLOG, TaskStatus.TODO, TaskStatus.DOING, TaskStatus.REVIEW] },
      } });
      if (dependentSteps > 0) {
        return refusal("conflict", "Cannot revoke repo access while a nonterminal chain step depends on this grant");
      }
      await tx.agentRepoAccess.delete({ where: { agentId_repoId: { agentId, repoId } } });
      return { ok: true as const };
    });
    return "message" in result ? refusalJson(context, result) : context.body(null, 204);
  });
};
