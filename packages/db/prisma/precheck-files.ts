import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const [fileObjects, taskAttachments, filesystemGrants] = await Promise.all([
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS count FROM "FileObject"`,
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS count FROM "TaskAttachment"`,
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS count FROM "FilesystemGrant"`,
  ]);
  const counts = {
    FileObject: Number(fileObjects[0]?.count ?? 0n),
    TaskAttachment: Number(taskAttachments[0]?.count ?? 0n),
    FilesystemGrant: Number(filesystemGrants[0]?.count ?? 0n),
  };
  console.log(`FileObject ${counts.FileObject}, TaskAttachment ${counts.TaskAttachment}, FilesystemGrant ${counts.FilesystemGrant}`);
  // Any non-zero count, not just FileObject: the migration drops TaskAttachment and
  // deletes every FilesystemGrant row, so a run that prints those counts and then exits 0
  // reads as a green pre-flight for data it is about to destroy.
  const blocking = Object.entries(counts).filter(([, count]) => count !== 0);
  if (blocking.length > 0) {
    console.error(`Refusing: ${blocking.map(([table, count]) => `${table}=${count}`).join(", ")}. `
      + "The files migration drops TaskAttachment/FileObject and deletes all FilesystemGrant rows. "
      + "Export or clear these deliberately first (see docs/runbooks/files-deployment.md).");
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
