import { Prisma, type PrismaClient } from "@agentos/db";

const RETRY_DELAYS_MS = [25, 75] as const;
const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isSerializationConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";

/** Runner availability is global backend state written by every daemon. Keep
 * its Serializable guarantee, but absorb the short write conflicts that level
 * reports can legitimately create. */
export const runRunnerAvailabilityTransaction = async <T>(
  db: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  sleep: (milliseconds: number) => Promise<void> = wait,
): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error: unknown) {
      const waitMs = RETRY_DELAYS_MS[attempt];
      if (!isSerializationConflict(error) || waitMs === undefined) throw error;
      await sleep(waitMs);
    }
  }
};
