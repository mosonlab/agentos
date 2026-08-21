import { Prisma, type PrismaClient } from "@prisma/client";

/** PostgreSQL advisory-lock namespace for the production deploy barrier. */
export const DEPLOY_BARRIER_CLASS = 0x41_47_44_50; // "AGDP"
export const DEPLOY_BARRIER_KEY = 1;

type ClaimTransaction = Pick<PrismaClient, "$queryRaw">;

/**
 * Joins the claim transaction to the deploy barrier. A deploy holds the
 * exclusive session form; a claim takes the shared transaction form before it
 * reads candidates. PostgreSQL therefore serializes an in-flight claim ahead
 * of the deploy, while every later claim fails closed without waiting.
 */
export const deployBarrierAllowsClaim = async (tx: ClaimTransaction): Promise<boolean> => {
  const rows = await tx.$queryRaw<Array<{ granted: boolean }>>(Prisma.sql`
    SELECT pg_try_advisory_xact_lock_shared(
      ${DEPLOY_BARRIER_CLASS}::int4,
      ${DEPLOY_BARRIER_KEY}::int4
    ) AS granted
  `);
  return rows.length === 1 && rows[0]?.granted === true;
};
