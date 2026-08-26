import { Prisma, type PrismaClient } from "@agentos/db";

const DEFAULT_SERIALIZABLE_ATTEMPTS = 6;
const SERIALIZATION_SQLSTATE = new Set(["40001", "40P01"]);

type TransactionOperation<T> = (tx: Prisma.TransactionClient) => Promise<T>;

export type SerializableTransactionOptions = {
  /** Total transaction attempts, including the first attempt. */
  attempts?: number;
  /** A domain conflict that requires the same whole-transaction retry. */
  alsoRetry?: (error: unknown) => boolean;
  /** Replace the exhaustion error while retaining this module's retry policy. */
  onExhausted?: (error: unknown) => Error;
};

export class SerializableTransactionExhaustedError extends Error {
  constructor(readonly conflict: unknown) {
    super("Serializable transaction retry budget exhausted", { cause: conflict });
    this.name = "SerializableTransactionExhaustedError";
  }
}

/**
 * A transaction-aborting conflict that requires the whole transaction to run
 * again. Exposed only for code operating savepoints inside a Serializable
 * transaction; ordinary callers use `serializable`.
 */
export const isSerializationConflict = (error: unknown): boolean => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  const sqlstate = (error.meta as { code?: unknown } | undefined)?.code;
  return error.code === "P2010" && typeof sqlstate === "string" && SERIALIZATION_SQLSTATE.has(sqlstate);
};

const serializationRetryDelay = async (attempt: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, attempt * 10 + Math.floor(Math.random() * 25)));
};

export const serializable = async <T>(
  db: PrismaClient,
  operation: TransactionOperation<T>,
  options: SerializableTransactionOptions = {},
): Promise<T> => {
  const attempts = options.attempts ?? DEFAULT_SERIALIZABLE_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("Serializable transaction attempts must be a positive integer");
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error: unknown) {
      const retryable = isSerializationConflict(error) || (options.alsoRetry?.(error) ?? false);
      if (!retryable) throw error;
      if (attempt === attempts) {
        throw options.onExhausted?.(error) ?? new SerializableTransactionExhaustedError(error);
      }
      await serializationRetryDelay(attempt);
    }
  }
};

export const readCommitted = async <T>(
  db: PrismaClient,
  operation: TransactionOperation<T>,
): Promise<T> => db.$transaction(operation, {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
});
