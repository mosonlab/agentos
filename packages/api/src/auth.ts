import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { PrismaClient } from "@agentos/db";

import { activeRunStatuses } from "./run-fence.js";

export type Principal =
  | { kind: "public" }
  | { kind: "operator" }
  | { kind: "runner" }
  | { kind: "merge-executor" }
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

/**
 * Whether `MERGE_EXECUTOR_TOKEN` is usable as an independent principal. An
 * unset, empty, or aliased value yields no executor principal at all, so an
 * unconfigured deployment can authenticate no mechanical claim rather than
 * silently accepting the runner fleet as the executor.
 */
export const mergeExecutorTokenIsDistinct = (env = process.env): boolean => {
  const token = env.MERGE_EXECUTOR_TOKEN;
  if (!token) return false;
  return token !== env.RUNNER_TOKEN && token !== env.OPERATOR_TOKEN;
};

export const authenticate = async (
  db: PrismaClient,
  authorization: string | undefined,
  now = new Date(),
): Promise<Principal | null> => {
  if (!authorization?.startsWith("Bearer ")) return null;
  const supplied = authorization.slice("Bearer ".length);
  if (tokenEquals(supplied, process.env.OPERATOR_TOKEN)) return { kind: "operator" };
  // §D-P1 rule 3. The merge executor authenticates with its own credential, not
  // with the shared runner token: mechanical authority has to be a property of
  // the material the caller holds, never of a `runnerId` the caller states about
  // itself. The executor arm is checked first and fails closed when the
  // deployment has aliased the credential onto an existing principal — an
  // operator or runner token that also happens to be `MERGE_EXECUTOR_TOKEN`
  // grants no mechanical authority, it simply is not an executor.
  if (mergeExecutorTokenIsDistinct() && tokenEquals(supplied, process.env.MERGE_EXECUTOR_TOKEN)) {
    return { kind: "merge-executor" };
  }
  if (tokenEquals(supplied, process.env.RUNNER_TOKEN)) return { kind: "runner" };
  if (!supplied.startsWith("agos_session_")) return null;
  const run = await db.run.findFirst({
    where: {
      sessionTokenHash: hashToken(supplied),
      sessionTokenRevokedAt: null,
      sessionTokenExpiresAt: { gt: now },
      leaseExpiresAt: { gt: now },
      status: { in: activeRunStatuses },
    },
    select: { id: true, leaseGeneration: true },
  });
  return run ? { kind: "session", runId: run.id, leaseGeneration: run.leaseGeneration } : null;
};

export const principalMayAccess = (principal: Principal, path: string): boolean => {
  if (principal.kind === "operator") return !path.startsWith("/runner/") && !path.startsWith("/session/");
  if (principal.kind === "runner") return path.startsWith("/runner/");
  // The executor speaks the same runner protocol; which runs it may take, start
  // and complete is decided per route by `mechanicalPrincipalRefusal`, not here.
  if (principal.kind === "merge-executor") return path.startsWith("/runner/");
  if (principal.kind === "session") return path.startsWith(`/session/runs/${principal.runId}/`);
  return false;
};
