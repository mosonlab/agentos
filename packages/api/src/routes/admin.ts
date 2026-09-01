import {
  NetworkingMode,
  Prisma,
  SecretPurpose,
} from "@anneal/db";
import type {
  Environment as EnvironmentContract,
  Project as ProjectContract,
  Secret as SecretContract,
} from "@anneal/db/wire-contract";
import { z } from "zod";

import { COSTS_DEFAULT_DAYS, COSTS_RANGE_DAYS, isValidTimeZone, readProjectCosts } from "../costs.js";
import { encryptSecret } from "../secrets.js";
import { withoutUndefined } from "../without-undefined.js";
import {
  id,
  readJson,
  secretPublicSelect,
  validated,
  type RouteApp,
  type RouteDeps,
} from "./support.js";

const projectFields = {
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  yamlDocument: z.string(),
};
const projectInput = z.object({ ...projectFields, yamlDocument: projectFields.yamlDocument.default("") });
const projectPatch = z.object(projectFields).partial().refine((value) => Object.keys(value).length > 0);

const environmentFields = {
  name: z.string().trim().min(1).max(120),
  networking: z.nativeEnum(NetworkingMode),
  allowedHosts: z.array(z.string().trim().min(1).max(253)).max(500),
};
const environmentInput = z.object({
  name: environmentFields.name,
  networking: environmentFields.networking.default(NetworkingMode.LIMITED),
  allowedHosts: environmentFields.allowedHosts.default([]),
});
const environmentPatch = z.object(environmentFields).partial().refine((value) => Object.keys(value).length > 0);

const secretFields = {
  name: z.string().trim().min(1).max(120),
  purpose: z.nativeEnum(SecretPurpose),
  description: z.string().trim().max(1000).nullable(),
};
const secretInput = z.object({ ...secretFields, description: secretFields.description.default(null), value: z.string().min(1).max(100_000) });
const secretPatch = z.object(secretFields).partial().extend({ value: z.string().min(1).max(100_000).optional() })
  .refine((value) => Object.keys(value).length > 0);

type ProjectResponse = ProjectContract<Date, Prisma.Decimal>;
type SecretResponse = SecretContract<Date>;

export const registerAdminRoutes = (app: RouteApp, { db }: RouteDeps): void => {
  app.get("/projects", async (context) => validated(context,
    (await db.project.findMany({ orderBy: { createdAt: "asc" } })) satisfies ProjectResponse[]));
  app.post("/projects", async (context) => context.json(
    (await db.project.create({ data: await readJson(context.req.raw, projectInput) })) satisfies ProjectResponse, 201));
  app.get("/projects/:projectId", async (context) => {
    const project = await db.project.findUnique({ where: { id: id.parse(context.req.param("projectId")) } });
    return project ? context.json(project satisfies ProjectResponse) : context.json({ error: "Project not found" }, 404);
  });
  app.patch("/projects/:projectId", async (context) => context.json((await db.project.update({
    where: { id: id.parse(context.req.param("projectId")) },
    data: withoutUndefined(await readJson(context.req.raw, projectPatch)) as Prisma.ProjectUpdateInput,
  })) satisfies ProjectResponse));
  app.delete("/projects/:projectId", async (context) => {
    await db.project.delete({ where: { id: id.parse(context.req.param("projectId")) } });
    return context.body(null, 204);
  });

  app.get("/projects/:projectId/costs", async (context) => {
    const timeZone = context.req.query("tz");
    if (timeZone === undefined || !isValidTimeZone(timeZone)) {
      return context.json({ error: "tz must be a recognized IANA timezone" }, 400);
    }
    const raw = context.req.query("days");
    const days = raw === undefined
      ? COSTS_DEFAULT_DAYS
      : COSTS_RANGE_DAYS.find((candidate) => raw === String(candidate));
    // Refused rather than clamped: a window the caller did not ask for would be
    // read as the one they did, and the totals would be quietly wrong.
    if (days === undefined) {
      return context.json({ error: `days must be one of ${COSTS_RANGE_DAYS.join(", ")}` }, 400);
    }
    return context.json(await readProjectCosts(db, id.parse(context.req.param("projectId")), days, timeZone));
  });

  app.get("/projects/:projectId/environments", async (context) => context.json((await db.environment.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    orderBy: { createdAt: "asc" },
  })) satisfies EnvironmentContract[]));
  app.post("/projects/:projectId/environments", async (context) => context.json((await db.environment.create({
    data: { projectId: id.parse(context.req.param("projectId")), ...await readJson(context.req.raw, environmentInput) },
  })) satisfies EnvironmentContract, 201));
  app.get("/environments/:environmentId", async (context) => {
    const environment = await db.environment.findUnique({
      where: { id: id.parse(context.req.param("environmentId")) },
      include: { secrets: { include: { secret: { select: secretPublicSelect } } } },
    });
    return environment ? context.json(environment satisfies EnvironmentContract) : context.json({ error: "Environment not found" }, 404);
  });
  app.patch("/environments/:environmentId", async (context) => context.json((await db.environment.update({
    where: { id: id.parse(context.req.param("environmentId")) },
    data: withoutUndefined(await readJson(context.req.raw, environmentPatch)),
  })) satisfies EnvironmentContract));
  app.delete("/environments/:environmentId", async (context) => {
    await db.environment.delete({ where: { id: id.parse(context.req.param("environmentId")) } });
    return context.body(null, 204);
  });

  app.get("/secrets", async (context) => context.json((await db.secret.findMany({
    select: {
      ...secretPublicSelect,
      agentGrants: { include: { agent: { select: { id: true, name: true, title: true, projectId: true } } } },
    },
    orderBy: { createdAt: "asc" },
  })) satisfies SecretResponse[]));
  app.post("/secrets", async (context) => {
    const body = await readJson(context.req.raw, secretInput);
    const secret = await db.secret.create({
      data: {
        name: body.name,
        purpose: body.purpose,
        description: body.description,
        encryptedValue: encryptSecret(body.value),
      },
      select: secretPublicSelect,
    });
    return context.json(secret satisfies SecretResponse, 201);
  });
  app.get("/secrets/:secretId", async (context) => {
    const secret = await db.secret.findUnique({
      where: { id: id.parse(context.req.param("secretId")) },
      select: {
        ...secretPublicSelect,
        agentGrants: { include: { agent: { select: { id: true, name: true, title: true, projectId: true } } } },
      },
    });
    return secret ? context.json(secret satisfies SecretResponse) : context.json({ error: "Secret not found" }, 404);
  });
  app.patch("/secrets/:secretId", async (context) => {
    const body = await readJson(context.req.raw, secretPatch);
    const { value, ...fields } = body;
    return context.json((await db.secret.update({
      where: { id: id.parse(context.req.param("secretId")) },
      data: {
        ...withoutUndefined(fields),
        ...(value === undefined ? {} : { encryptedValue: encryptSecret(value), rotatedAt: new Date() }),
      },
      select: secretPublicSelect,
    })) satisfies SecretResponse);
  });
  app.delete("/secrets/:secretId", async (context) => {
    await db.secret.delete({ where: { id: id.parse(context.req.param("secretId")) } });
    return context.body(null, 204);
  });
};
