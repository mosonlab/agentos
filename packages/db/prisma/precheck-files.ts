import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * A table that does not exist holds no rows to destroy.
 *
 * The files migration drops `TaskAttachment` and `FileObject`, so on any target
 * that has already applied it these names are gone. Querying them there raises
 * `42P01`, which would turn "there is nothing left to lose" into a refusal —
 * and `db:migrate:release --existing` runs this precheck on exactly such
 * targets. Absence is therefore counted as zero, and only a present table with
 * rows in it stops the release.
 */
const countIfPresent = async (table: string): Promise<number | null> => {
  const [presence] = await prisma.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass('"${table}"') IS NOT NULL AS "present"`,
  );
  if (presence?.present !== true) return null;
  const [row] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT COUNT(*) AS count FROM "${table}"`);
  return Number(row?.count ?? 0n);
};

try {
  const [fileObjects, taskAttachments, filesystemGrants] = await Promise.all([
    countIfPresent("FileObject"),
    countIfPresent("TaskAttachment"),
    countIfPresent("FilesystemGrant"),
  ]);
  const counts = {
    FileObject: fileObjects,
    TaskAttachment: taskAttachments,
    FilesystemGrant: filesystemGrants,
  };
  const describe = (count: number | null): string => (count === null ? "absent" : String(count));
  console.log(`FileObject ${describe(counts.FileObject)}, TaskAttachment ${describe(counts.TaskAttachment)}, `
    + `FilesystemGrant ${describe(counts.FilesystemGrant)}`);
  // Any non-zero count, not just FileObject: the migration drops TaskAttachment and
  // deletes every FilesystemGrant row, so a run that prints those counts and then exits 0
  // reads as a green pre-flight for data it is about to destroy.
  const blocking = Object.entries(counts).filter(([, count]) => count !== null && count !== 0);
  if (blocking.length > 0) {
    console.error(`Refusing: ${blocking.map(([table, count]) => `${table}=${String(count)}`).join(", ")}. `
      + "The files migration drops TaskAttachment/FileObject and deletes all FilesystemGrant rows. "
      + "Export or clear these deliberately first.");
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
