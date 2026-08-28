import { createHash, timingSafeEqual } from "node:crypto";

import { Prisma, type PrismaClient } from "@anneal/db";

import { decryptSecret } from "./secrets.js";

type WebhookTemplate = Prisma.TaskTemplateGetPayload<{ include: { webhookSecret: true } }>;

const scalar = (value: unknown): value is string | number | boolean => (
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
);

/**
 * Whether a configured default actually resolves a variable.
 *
 * An empty string does not. The Triggers UI badges a variable `required` when it
 * has neither a payload path nor a default, and that badge is a promise: every
 * fire that does not carry the variable will 400. Accepting `""` as a value
 * would break the promise — the badge would be red on a trigger that fires
 * fine — and an empty prompt variable is almost never what the operator meant.
 * The rule lives here so the webhook path and `POST /task-templates/:id/fire`
 * cannot drift apart.
 */
export const usableDefault = (value: unknown): value is string | number | boolean => (
  scalar(value) && String(value).trim() !== ""
);

const atPath = (payload: Record<string, unknown>, path: string): unknown => {
  let value: unknown = payload;
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
};

export const resolvePayloadVariables = (
  template: Pick<WebhookTemplate, "variables" | "webhookPayloadMapping">,
  payload: Record<string, unknown>,
): { variables: Record<string, string> } | { unresolved: string[] } => {
  const mapping = template.webhookPayloadMapping && typeof template.webhookPayloadMapping === "object" && !Array.isArray(template.webhookPayloadMapping)
    ? template.webhookPayloadMapping as { map?: Record<string, unknown>; defaults?: Record<string, unknown> }
    : {};
  const variables = Object.create(null) as Record<string, string>;
  const unresolved: string[] = [];
  for (const name of template.variables) {
    const path = typeof mapping.map?.[name] === "string" ? mapping.map[name] : undefined;
    const resolved = path ? atPath(payload, path) : undefined;
    const fallback = mapping.defaults?.[name];
    const value = usableDefault(resolved) ? resolved : usableDefault(fallback) ? fallback : undefined;
    if (value === undefined) unresolved.push(name);
    else variables[name] = String(value);
  }
  return unresolved.length > 0 ? { unresolved } : { variables };
};

export const authenticateWebhook = async (
  db: PrismaClient,
  templateId: string,
  suppliedSecret: string | undefined,
): Promise<WebhookTemplate | null> => {
  const template = await db.taskTemplate.findUnique({ where: { id: templateId }, include: { webhookSecret: true } });
  // A paused trigger fails here rather than in the route, so a pause is
  // indistinguishable from a wrong secret on the wire: one place produces the
  // 401, and no second response shape can drift into existence.
  if (
    !template?.webhookSecretId || !template.webhookRepoId || !template.webhookSecret
    || template.webhookSecret.disabledAt || template.webhookPausedAt || suppliedSecret === undefined
  ) return null;
  try {
    const expected = decryptSecret(template.webhookSecret.encryptedValue, template.webhookSecret.ciphertextVersion);
    const suppliedHash = createHash("sha256").update(suppliedSecret).digest();
    const expectedHash = createHash("sha256").update(expected).digest();
    return timingSafeEqual(suppliedHash, expectedHash) ? template : null;
  } catch {
    return null;
  }
};
