import { Prisma } from "@anneal/db";

/** Locks a whole candidate set in one deterministic statement and re-checks
 * the shared DONE/archive predicate after any concurrent writer releases it. */
export const lockDoneTasks = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  taskIds: string[],
  doneBefore?: Date,
): Promise<string[]> => {
  if (taskIds.length === 0) return [];
  const completionPredicate = doneBefore === undefined
    ? Prisma.empty
    : Prisma.sql`AND "doneAt" <= ${doneBefore}`;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task"
    WHERE "id" = ANY(${taskIds})
      AND "archivedAt" IS NULL
      AND "projectId" = ${projectId}
      AND "status" = 'done'::"TaskStatus"
      ${completionPredicate}
    ORDER BY "id" FOR UPDATE
  `;
  return rows.map((row) => row.id);
};

/** Splits candidates from rows whose active Run still makes archival unsafe. */
export const partitionArchivable = (
  candidateIds: string[],
  busyIds: string[],
): { archive: string[]; skipped: number } => {
  const busy = new Set(busyIds);
  const archive = candidateIds.filter((taskId) => !busy.has(taskId));
  return { archive, skipped: candidateIds.length - archive.length };
};
