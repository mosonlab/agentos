import { Prisma } from "@agentos/db";

/** serialization_failure and deadlock_detected: both mean "retry the whole transaction". */
const SERIALIZATION_SQLSTATE = new Set(["40001", "40P01"]);

/**
 * True when a Serializable transaction lost its conflict and the only correct
 * response is to run the whole transaction again.
 *
 * Prisma reports its own query builder's loss as P2034, but a raw statement --
 * the `FOR UPDATE` row mutexes every chain writer takes -- comes back as P2010
 * with the SQLSTATE buried in `meta`. A caller that only matches P2034 lets the
 * raw-statement half escape as a 500.
 */
export const isSerializationConflict = (error: unknown): boolean => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  const sqlstate = (error.meta as { code?: unknown } | undefined)?.code;
  return error.code === "P2010" && typeof sqlstate === "string" && SERIALIZATION_SQLSTATE.has(sqlstate);
};

/** Jittered backoff so a serialization queue drains instead of re-colliding in lockstep. */
export const serializationRetryDelay = async (attempt: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, attempt * 10 + Math.floor(Math.random() * 25)));
};
