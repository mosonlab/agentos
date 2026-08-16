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
  if (counts.FileObject !== 0) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
