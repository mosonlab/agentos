import { createHash } from "node:crypto";

import {
  Prisma,
  RunnerKind,
  SecretPurpose,
  TaskSource,
  TriggerFireSource,
  type PrismaClient,
} from "@anneal/db";
import type {
  Trigger as TriggerContract,
  TriggerDetail as TriggerDetailContract,
  TriggerFire as TriggerFireContract,
} from "@anneal/db/board-contract";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";

import {
  authenticate,
  authenticateRevalidationCancellationReplay,
  principalMayAccess,
} from "./auth.js";
import { chainKey, chainProgressByChain } from "./chain.js";
import { authenticateWebhook, resolvePayloadVariables, usableDefault } from "./hooks.js";
import { LOOPBACK_BROWSER_ORIGINS, originMayReachHandlers } from "./local-origin.js";
import { releaseMergeLease } from "./merge-lease.js";
import { createArchivedRunNoticeScheduler } from "./reconcile.js";
import { refusalFor } from "./refusal.js";
import { revalidationCancelRequestId } from "./revalidation.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAgentsRoutes } from "./routes/agents.js";
import { registerGoalsRoutes } from "./routes/goals.js";
import { registerInboxRoutes } from "./routes/inbox.js";
import { registerRunnerRoutes } from "./routes/runner.js";
import { registerSessionRoutes } from "./routes/session.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerTasksRoutes } from "./routes/tasks.js";
import { createRunnerRegistry } from "./runners.js";
import {
  createAppendFencedActivityHandler,
  id,
  readJson,
  refusal,
  refusalJson,
  type AppEnvironment,
  type LiveAppOptions,
  type RouteDeps,
} from "./routes/support.js";
import { instantiateTemplate, isUsableTemplateVariable } from "./templates.js";
import { SerializableTransactionExhaustedError } from "./transaction.js";
import { withoutUndefined } from "./without-undefined.js";
import { isValidBranchName } from "./branch-name.js";

export type { LiveAppOptions } from "./routes/support.js";

const isPublic = (path: string, method: string): boolean =>
  path === "/" || path === "/health" || path === "/version" || method === "OPTIONS"
  || method === "POST" && /^\/hooks\/templates\/[^/]+$/.test(path);

const stepOverrideInput = z.object({ assigneeAgentId: id }).strict();
const stepOverridesInput = z.record(z.string(), stepOverrideInput);
const instantiateTemplateInput = z.object({
  repoId: id,
  variables: z.record(z.string(), z.string().refine(isUsableTemplateVariable, "Template variables must not be blank")),
  autoStart: z.boolean().default(false),
  afterTaskId: id.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(50_000).optional(),
  stepOverrides: stepOverridesInput.optional(),
}).superRefine((value, context) => {
  const branchName = value.variables.branchName;
  if (branchName !== undefined && !isValidBranchName(branchName)) {
    context.addIssue({ code: "custom", path: ["variables", "branchName"], message: "Template branchName is not a valid Git branch name" });
  }
});
// `Fire now` merges over the template's own defaults, so an all-defaulted
// trigger fires from an empty body.
const manualFireInput = z.object({
  variables: z.record(z.string(), z.string()).optional(),
}).default({});
const webhookPayloadMapping = z.object({
  map: z.record(z.string(), z.string().trim().min(1)).optional(),
  defaults: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
const webhookConfigPatch = z.object({
  webhookSecretId: id.nullable().optional(),
  webhookRepoId: id.nullable().optional(),
  webhookPayloadMapping: webhookPayloadMapping.nullable().optional(),
  // 0 and null both mean "no replay window"; the write side normalises 0 to
  // null so the read side has exactly one representation of disabled.
  webhookReplayWindowSec: z.number().int().min(0).max(86_400).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0);

type TriggerResponse = TriggerContract<Date>;
type TriggerDetailResponse = TriggerDetailContract<Date>;
type TriggerFireResponse = TriggerFireContract<Date>;

export const createApp = (db: PrismaClient, options: LiveAppOptions): Hono<AppEnvironment> => {
  const app = new Hono<AppEnvironment>();
  const releaseChainLease = options.releaseMergeLease ?? releaseMergeLease;
  const noteArchivedQueuedRunsOnClaim = createArchivedRunNoticeScheduler(db);
  const runners = createRunnerRegistry();
  // Authentication circuits are global backend state, so only one daemon must
  // perform a recovery check. This short in-process lease prevents every idle
  // daemon from invoking the same provider login command on each heartbeat.
  // `lastPreflightAt` remains the durable retry clock, so an API restart may
  // reassign an overdue check without changing what that timestamp means.
  const preflightRecoveryLeases = new Map<RunnerKind, number>();
  const preflightRecoveryIntervalMs = 5 * 60_000;
  const appendFencedActivity = createAppendFencedActivityHandler(db);

  // The supported browser path is same-origin through the Vite proxy, so this
  // allowlist is a boundary rather than a transport: it decides which *other*
  // origin may read a control-plane response out of a browser. It was `*`, which
  // is the one value that makes that boundary vacuous. Public `/` and `/health`
  // and every authenticated route are unaffected — CORS decides what a browser
  // may read, and the principal check below still decides what is served.
  app.use("*", cors({
    origin: [...LOOPBACK_BROWSER_ORIGINS],
    allowHeaders: ["Authorization", "Content-Type", "X-Fencing-Token", "X-Anneal-Webhook-Secret", "X-Anneal-Delivery-Id"],
  }));
  // The second, independent half of that boundary (review S-2). CORS decides
  // what a browser may *read*; it lets the request run and commit its side
  // effect regardless. So a foreign `Origin` is refused here, before auth and
  // before any handler, rather than leaving the dev server's proxy guard as the
  // only barrier — which is the arrangement S-1 broke. The predicate is in
  // `local-origin.ts`, with the reason it matches by shape rather than against
  // the two-entry allowlist above.
  //
  // Preflights never reach this: `cors` answers OPTIONS above and returns.
  app.use("*", async (context, next) => {
    if (!originMayReachHandlers(context.req.header("Origin"))) return context.json({ error: "Forbidden origin" }, 403);
    await next();
  });
  app.use("*", async (context, next) => {
    if (isPublic(context.req.path, context.req.method)) {
      context.set("principal", { kind: "public" });
      await next();
      return;
    }
    const authorization = context.req.header("Authorization");
    let principal = await authenticate(db, authorization);
    const cancellationReplay = context.req.method === "POST"
      ? /^\/session\/runs\/([^/]+)\/revalidation\/cancel$/u.exec(context.req.path)
      : null;
    if (!principal && cancellationReplay?.[1]) {
      principal = await authenticateRevalidationCancellationReplay(db, authorization, {
        runId: cancellationReplay[1],
        requestId: revalidationCancelRequestId(cancellationReplay[1]),
      });
    }
    if (!principal) return context.json({ error: "Unauthorized" }, 401);
    if (!principalMayAccess(principal, context.req.path)) return context.json({ error: "Forbidden for principal" }, 403);
    context.set("principal", principal);
    await next();
  });

  const routeDeps: RouteDeps = {
    db,
    options,
    releaseChainLease,
    runners,
    appendFencedActivity,
  };
  const registerSystemTail = registerSystemRoutes(app, routeDeps);

  app.use("/hooks/templates/:templateId", bodyLimit({
    maxSize: 1024 * 1024,
    onError: (context) => context.json({ error: "Payload too large" }, 413),
  }));
  app.post("/hooks/templates/:templateId", async (context) => {
    const template = await authenticateWebhook(
      db,
      id.parse(context.req.param("templateId")),
      context.req.header("X-Anneal-Webhook-Secret"),
    );
    if (!template) return context.json({ error: "Unauthorized" }, 401);
    // The body is read exactly once, as text: the replay key hashes the raw
    // bytes, and a Request body cannot be consumed twice.
    const raw = await context.req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return context.json({ error: "Invalid JSON payload" }, 400);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return context.json({ error: "Webhook payload must be an object" }, 400);
    }
    const window = template.webhookReplayWindowSec ?? 0;
    const dedupeKey = window > 0
      ? context.req.header("X-Anneal-Delivery-Id") ?? createHash("sha256").update(raw).digest("hex")
      : null;
    if (dedupeKey) {
      const seen = await db.triggerFire.findFirst({
        where: { templateId: template.id, dedupeKey, createdAt: { gt: new Date(Date.now() - window * 1000) } },
        orderBy: { createdAt: "desc" },
        select: { chainId: true },
      });
      // A redelivery is not an error: the sender did what it was told to do.
      if (seen) return context.json({ duplicate: true, chainId: seen.chainId }, 200);
    }
    const resolved = resolvePayloadVariables(template, payload as Record<string, unknown>);
    if ("unresolved" in resolved) return context.json({ error: "Unresolved template variables", unresolved: resolved.unresolved }, 400);
    const result = await instantiateTemplate(db, template.projectId, template.id, {
      repoId: template.webhookRepoId!, variables: resolved.variables, autoStart: true,
    }, {
      actorType: "webhook",
      activityMetadata: { webhookTemplateId: template.id, firedAt: new Date().toISOString() },
      source: TaskSource.WEBHOOK,
      fire: { source: TriggerFireSource.WEBHOOK, dedupeKey },
    });
    return context.json({ chainId: result.chainId, taskIds: result.tasks.map((task) => task.id) }, 201);
  });


  registerSystemTail();
  registerAdminRoutes(app, routeDeps);
  registerAgentsRoutes(app, routeDeps);
  registerGoalsRoutes(app, routeDeps);

  app.get("/projects/:projectId/task-templates", async (context) => context.json(await db.taskTemplate.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
    orderBy: { createdAt: "asc" },
  })));
  app.get("/task-templates/:templateId", async (context) => {
    const template = await db.taskTemplate.findUnique({
      where: { id: id.parse(context.req.param("templateId")) },
      include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
    });
    return template ? context.json(template) : context.json({ error: "Template not found" }, 404);
  });
  app.patch("/task-templates/:templateId", async (context) => {
    const templateId = id.parse(context.req.param("templateId"));
    const body = await readJson(context.req.raw, webhookConfigPatch);
    const template = await db.taskTemplate.findUnique({ where: { id: templateId } });
    if (!template) return context.json({ error: "Template not found" }, 404);
    const secretId = body.webhookSecretId === undefined ? template.webhookSecretId : body.webhookSecretId;
    const repoId = body.webhookRepoId === undefined ? template.webhookRepoId : body.webhookRepoId;
    if (secretId) {
      const secret = await db.secret.findFirst({ where: { id: secretId, purpose: SecretPurpose.WEBHOOK } });
      if (!secret) return context.json({ error: "Webhook secret must exist and have WEBHOOK purpose" }, 400);
      if (!repoId) return context.json({ error: "Webhook secret requires an in-project Repo" }, 400);
    }
    if (repoId) {
      const repo = await db.repo.findFirst({ where: { id: repoId, projectId: template.projectId } });
      if (!repo) return context.json({ error: "Webhook Repo does not belong to this project" }, 400);
    }
    return context.json(await db.taskTemplate.update({
      where: { id: templateId },
      data: {
        ...withoutUndefined(body),
        ...(body.webhookPayloadMapping !== undefined
          ? { webhookPayloadMapping: body.webhookPayloadMapping === null ? Prisma.JsonNull : body.webhookPayloadMapping }
          : {}),
        ...(body.webhookReplayWindowSec !== undefined
          ? { webhookReplayWindowSec: body.webhookReplayWindowSec ? body.webhookReplayWindowSec : null }
          : {}),
      },
    }));
  });
  app.post("/projects/:projectId/task-templates/:templateId/instantiate", async (context) => {
    return context.json(await instantiateTemplate(
      db,
      id.parse(context.req.param("projectId")),
      id.parse(context.req.param("templateId")),
      await readJson(context.req.raw, instantiateTemplateInput),
    ), 201);
  });

  // --- triggers: webhook-configured templates, their ledger, and manual fire --
  //
  // Every select below is explicit. `include: { webhookSecret: true }` would put
  // the ciphertext on the wire, so the secret relation is only ever read through
  // a field list that names `disabledAt` and `name` and nothing else.
  const triggerSelect = {
    id: true,
    name: true,
    description: true,
    projectId: true,
    webhookRepoId: true,
    webhookPausedAt: true,
    webhookReplayWindowSec: true,
    variables: true,
    webhookPayloadMapping: true,
    webhookRepo: { select: { id: true, name: true } },
    webhookSecret: { select: { name: true, disabledAt: true } },
    _count: { select: { steps: true } },
  } as const;

  /** One grouped query for every listed trigger — never one per row (E5). */
  const fireStats = async (templateIds: string[]): Promise<Map<string, { fireCount: number; lastFiredAt: Date | null }>> => {
    if (templateIds.length === 0) return new Map();
    const grouped = await db.triggerFire.groupBy({
      by: ["templateId"],
      where: { templateId: { in: templateIds } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    return new Map(grouped.map((row) => [row.templateId, {
      fireCount: row._count._all,
      lastFiredAt: row._max.createdAt ?? null,
    }]));
  };

  const cannotFireReason = (trigger: { webhookRepoId: string | null; _count: { steps: number } }): string | null => {
    if (!trigger.webhookRepoId) return "This trigger has no repository configured";
    if (trigger._count.steps === 0) return "This trigger's template has no steps";
    return null;
  };

  const payloadMapping = (raw: unknown): { map: Record<string, string>; defaults: Record<string, unknown> } => {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as { map?: unknown; defaults?: unknown } : {};
    return {
      map: value.map && typeof value.map === "object" && !Array.isArray(value.map) ? value.map as Record<string, string> : {},
      defaults: value.defaults && typeof value.defaults === "object" && !Array.isArray(value.defaults) ? value.defaults as Record<string, unknown> : {},
    };
  };

  app.get("/projects/:projectId/triggers", async (context) => {
    const triggers = await db.taskTemplate.findMany({
      // A trigger is defined by its secret, not its repo: a template with a
      // secret and no repo is un-fireable, and hiding it is exactly the wrong
      // answer — the operator needs to see the one that cannot fire.
      where: { projectId: id.parse(context.req.param("projectId")), webhookSecretId: { not: null } },
      select: triggerSelect,
      orderBy: { createdAt: "asc" },
    });
    const stats = await fireStats(triggers.map((trigger) => trigger.id));
    return context.json(triggers.map((trigger) => ({
      id: trigger.id,
      name: trigger.name,
      description: trigger.description,
      repo: trigger.webhookRepo,
      stepCount: trigger._count.steps,
      paused: trigger.webhookPausedAt !== null,
      secretDisabled: trigger.webhookSecret?.disabledAt != null,
      lastFiredAt: stats.get(trigger.id)?.lastFiredAt ?? null,
      fireCount: stats.get(trigger.id)?.fireCount ?? 0,
    })) satisfies TriggerResponse[]);
  });

  app.get("/triggers/:templateId", async (context) => {
    const templateId = id.parse(context.req.param("templateId"));
    const trigger = await db.taskTemplate.findFirst({ where: { id: templateId, webhookSecretId: { not: null } }, select: triggerSelect });
    if (!trigger) return context.json({ error: "Trigger not found" }, 404);
    const stats = (await fireStats([trigger.id])).get(trigger.id);
    const mapping = payloadMapping(trigger.webhookPayloadMapping);
    const reason = cannotFireReason(trigger);
    return context.json({
      id: trigger.id,
      name: trigger.name,
      description: trigger.description,
      projectId: trigger.projectId,
      endpointPath: `/hooks/templates/${trigger.id}`,
      secretName: trigger.webhookSecret?.name ?? null,
      secretDisabled: trigger.webhookSecret?.disabledAt != null,
      repo: trigger.webhookRepo,
      variables: trigger.variables,
      mapping: mapping.map,
      defaults: mapping.defaults,
      replayWindowSec: trigger.webhookReplayWindowSec,
      paused: trigger.webhookPausedAt !== null,
      stepCount: trigger._count.steps,
      fireCount: stats?.fireCount ?? 0,
      lastFiredAt: stats?.lastFiredAt ?? null,
      canFire: reason === null,
      cannotFireReason: reason,
    } satisfies TriggerDetailResponse);
  });

  app.get("/triggers/:templateId/fires", async (context) => {
    const templateId = id.parse(context.req.param("templateId"));
    const take = Math.min(Math.max(Number(context.req.query("take") ?? 20) || 20, 1), 100);
    const template = await db.taskTemplate.findUnique({ where: { id: templateId }, select: { projectId: true } });
    if (!template) return context.json({ error: "Template not found" }, 404);
    const fires = await db.triggerFire.findMany({
      where: { templateId },
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, createdAt: true, source: true, chainId: true },
    });
    const chainIds = [...new Set(fires.map((fire) => fire.chainId).filter((chainId): chainId is string => chainId !== null))];
    // One query for every referenced chain, then the shared assembler — a fire
    // whose chain has since been deleted keeps its row and reports nothing.
    // Scoped to the trigger's own project because `chainId` is unique per
    // project only by convention: without this predicate a colliding chainId in
    // another project supplies this trigger's `firstTask` and progress.
    const rows = chainIds.length === 0 ? [] : await db.task.findMany({
      where: { chainId: { in: chainIds }, projectId: template.projectId },
      select: { id: true, projectId: true, chainId: true, chainIndex: true, chainLayer: true, name: true, status: true, archivedAt: true, templateStep: { select: { name: true } } },
    });
    const progress = chainProgressByChain(rows);
    // Keyed by `chainKey`, not `chainId`, for the same reason — the query above
    // makes the two equivalent today, and this keeps them equivalent if it changes.
    const firstByChain = new Map<string, { id: string; name: string }>();
    for (const row of [...rows].sort((left, right) => (left.chainIndex ?? 0) - (right.chainIndex ?? 0))) {
      if (!row.chainId) continue;
      const key = chainKey({ projectId: row.projectId, chainId: row.chainId });
      if (!firstByChain.has(key)) firstByChain.set(key, { id: row.id, name: row.name });
    }
    const keyOf = (chainId: string) => chainKey({ projectId: template.projectId, chainId });
    return context.json(fires.map((fire) => ({
      id: fire.id,
      createdAt: fire.createdAt,
      source: fire.source,
      chainId: fire.chainId,
      firstTask: fire.chainId ? firstByChain.get(keyOf(fire.chainId)) ?? null : null,
      progress: fire.chainId ? progress.get(keyOf(fire.chainId)) ?? null : null,
    })) satisfies TriggerFireResponse[]);
  });

  const setTriggerPaused = async (context: Context, paused: boolean) => {
    const templateId = id.parse(context.req.param("templateId"));
    const trigger = await db.taskTemplate.findFirst({ where: { id: templateId, webhookSecretId: { not: null } }, select: { id: true } });
    if (!trigger) return context.json({ error: "Trigger not found" }, 404);
    await db.taskTemplate.update({ where: { id: templateId }, data: { webhookPausedAt: paused ? new Date() : null } });
    return context.json({ paused });
  };
  app.post("/triggers/:templateId/pause", async (context) => setTriggerPaused(context, true));
  app.post("/triggers/:templateId/enable", async (context) => setTriggerPaused(context, false));

  app.post("/task-templates/:templateId/fire", async (context) => {
    const templateId = id.parse(context.req.param("templateId"));
    // `Fire now` on a fully-defaulted trigger sends no body at all, and
    // `request.json()` throws on an empty one — hence the hand-rolled parse
    // instead of `readJson`. It still has to answer a malformed body the way
    // every other route does: a client error is a 400, not a 500.
    const raw = await context.req.text();
    let parsed: unknown;
    try {
      parsed = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      return context.json({ error: "Invalid JSON payload" }, 400);
    }
    const body = manualFireInput.parse(parsed);
    const trigger = await db.taskTemplate.findUnique({ where: { id: templateId }, select: triggerSelect });
    if (!trigger) return context.json({ error: "Template not found" }, 404);
    // The repository is the template's own webhook repo — the same one the hook
    // passes — and it is nullable, so this check comes before variables. It is
    // also `canFire: false` in the detail route, so the button is already
    // disabled with the reason shown; this 400 is for direct API callers.
    const reason = cannotFireReason(trigger);
    if (reason && !trigger.webhookRepoId) return context.json({ error: reason }, 400);
    const mapping = payloadMapping(trigger.webhookPayloadMapping);
    const variables: Record<string, string> = {};
    const unresolved: string[] = [];
    for (const name of trigger.variables) {
      const supplied = body.variables?.[name];
      const fallback = mapping.defaults[name];
      // Same `usableDefault` the webhook path uses, so an empty-string default
      // does not resolve here while the UI badges the variable `required`.
      const value = isUsableTemplateVariable(supplied) ? supplied
        : usableDefault(fallback) ? String(fallback)
        : undefined;
      if (value === undefined) unresolved.push(name); else variables[name] = value;
    }
    // The names go in the prose, not only in `unresolved`: the web client's
    // parseError keeps the `error` string and discards every sibling field, so
    // prose is the only form the operator ever sees.
    if (unresolved.length > 0) {
      return context.json({ error: `Unresolved template variables: ${unresolved.join(", ")}`, unresolved }, 400);
    }
    const result = await instantiateTemplate(db, trigger.projectId, trigger.id, {
      repoId: trigger.webhookRepoId!, variables, autoStart: true,
    }, {
      actorType: "operator",
      activityMetadata: { manualFireTemplateId: trigger.id, firedAt: new Date().toISOString() },
      source: TaskSource.MANUAL,
      fire: { source: TriggerFireSource.MANUAL },
    });
    return context.json({ chainId: result.chainId, taskIds: result.tasks.map((task) => task.id), fireId: result.fireId }, 201);
  });


  registerTasksRoutes(app, routeDeps);
  registerInboxRoutes(app, routeDeps);
  const registerRunnerTail = registerRunnerRoutes(app, routeDeps, {
    noteArchivedQueuedRunsOnClaim,
    preflightRecoveryLeases,
    preflightRecoveryIntervalMs,
  });
  const registerSessionTail = registerSessionRoutes(app, routeDeps);
  registerRunnerTail();
  registerSessionTail();

  app.onError((error, context) => {
    if (error instanceof z.ZodError) return context.json({ error: "Validation failed", issues: error.issues }, 400);
    if (error instanceof SerializableTransactionExhaustedError) {
      return context.json({ error: "Transaction is busy; retry later" }, 503);
    }
    const rejected = refusalFor(error);
    if (rejected) return refusalJson(context, rejected);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") return refusalJson(context, refusal("not-found", "Resource not found"));
      if (error.code === "P2002") return refusalJson(context, refusal("conflict", "Unique constraint violated"));
    }
    console.error(error);
    return context.json({ error: "Internal server error" }, 500);
  });
  app.notFound((context) => refusalJson(context, refusal("not-found", "Not found")));
  return app;
};
