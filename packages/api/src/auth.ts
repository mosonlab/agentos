import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { PrismaClient } from "@agentos/db";

export type Principal =
  | { kind: "public" }
  | { kind: "operator" }
  | { kind: "runner" }
  | { kind: "session"; runId: string; leaseGeneration: number };

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export const issueSessionToken = (): { token: string; hash: string } => {
  const token = `agos_session_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token) };
};

const tokenEquals = (supplied: string, configured: string | undefined): boolean => {
  if (!configured) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(configured);
  return left.length === right.length && timingSafeEqual(left, right);
};

export const authenticate = async (
  db: PrismaClient,
  authorization: string | undefined,
  now = new Date(),
): Promise<Principal | null> => {
  if (!authorization?.startsWith("Bearer ")) return null;
  const supplied = authorization.slice("Bearer ".length);
  if (tokenEquals(supplied, process.env.OPERATOR_TOKEN)) return { kind: "operator" };
  if (tokenEquals(supplied, process.env.RUNNER_TOKEN)) return { kind: "runner" };
  if (!supplied.startsWith("agos_session_")) return null;
  const run = await db.run.findFirst({
    where: {
      sessionTokenHash: hashToken(supplied),
      sessionTokenRevokedAt: null,
      sessionTokenExpiresAt: { gt: now },
      leaseExpiresAt: { gt: now },
        status: { in: ["CLAIMED", "PROVISIONING", "RUNNING", "WAITING_INBOX"] },
    },
    select: { id: true, leaseGeneration: true },
  });
  return run ? { kind: "session", runId: run.id, leaseGeneration: run.leaseGeneration } : null;
};

export const principalMayAccess = (principal: Principal, path: string): boolean => {
  if (principal.kind === "operator") return !path.startsWith("/runner/") && !path.startsWith("/session/");
  if (principal.kind === "runner") return path.startsWith("/runner/");
  if (principal.kind === "session") return path.startsWith(`/session/runs/${principal.runId}/`);
  return false;
};
