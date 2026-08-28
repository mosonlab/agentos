import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { testDatabaseUrl } from "./testdb.js";

const execFileAsync = promisify(execFile);
const DB_DIRECTORY = fileURLToPath(new URL("../../db", import.meta.url));

export const runDbScript = async (script: string): Promise<string> => {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", `prisma/${script}`],
      {
        cwd: DB_DIRECTORY,
        env: { ...process.env, DATABASE_URL: testDatabaseUrl },
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return `${result.stdout}${result.stderr}`;
  } catch (error: unknown) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`canonical ${script} failed\n${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message ?? ""}`);
  }
};
