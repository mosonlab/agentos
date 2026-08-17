import { homedir } from "node:os";
import { join } from "node:path";

import type { ServerType } from "@hono/node-server";
import { config } from "dotenv";

import {
  acquireControlPlaneOwnership,
  ControlPlaneOwnershipStartupError,
  type ControlPlaneOwnership,
} from "./control-plane-ownership.js";

config({
  path: new URL("../../../.env", import.meta.url),
  quiet: true,
});

let ownership: ControlPlaneOwnership | undefined;
let server: ServerType | undefined;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let prisma: (typeof import("@agentos/db"))["prisma"] | undefined;
let cleanupPromise: Promise<void> | undefined;
let requestedSignal: NodeJS.Signals | undefined;
// Signals must never start cleanup before an in-flight ownership acquisition has
// published its capability. Keep the whole startup sequence busy and let the
// explicit checkpoints join it to the single cleanup state machine.
let startupBusy = true;
let finalExitCode = 0;

class StartupCancelledBySignalError extends Error {}

const closeServer = async (): Promise<void> => {
  if (!server) return;
  const closing = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => {
    closing.close((error?: Error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw error;
  });
};

const cleanup = (exitCode: number): Promise<void> => {
  finalExitCode = Math.max(finalExitCode, exitCode);
  cleanupPromise ??= (async () => {
    const failures: unknown[] = [];
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
    await closeServer().catch((error: unknown) => failures.push(error));
    if (prisma) await prisma.$disconnect().catch((error: unknown) => failures.push(error));
    if (ownership) await ownership.release().catch((error: unknown) => failures.push(error));
    if (failures.length > 0) {
      finalExitCode = 1;
      throw new AggregateError(failures, "AgentOS API cleanup failed");
    }
  })();
  return cleanupPromise.finally(() => { process.exitCode = finalExitCode; });
};

const ensureStartupActive = async (): Promise<void> => {
  if (!requestedSignal) return;
  await cleanup(0);
  throw new StartupCancelledBySignalError(`startup-cancelled-by-${requestedSignal}`);
};

const onSignal = (signal: NodeJS.Signals): void => {
  if (requestedSignal) return;
  requestedSignal = signal;
  console.log(`Received ${signal}; shutting down AgentOS API`);
  if (!startupBusy) void cleanup(0).catch((error: unknown) => {
    console.error("AgentOS API shutdown failed", error);
    process.exitCode = 1;
  });
};

process.once("SIGINT", () => onSignal("SIGINT"));
process.once("SIGTERM", () => onSignal("SIGTERM"));

const main = async (): Promise<void> => {
  const configuredWorkspaceRoot = process.env.RUNNER_WORKSPACE_ROOT;
  const configuredFilesRoot = process.env.FILES_ROOT ?? join(homedir(), "Documents", "agentos");
  ownership = await acquireControlPlaneOwnership({
    filesRoot: configuredFilesRoot,
    ...(configuredWorkspaceRoot ? { workspaceRoot: configuredWorkspaceRoot } : {}),
    ...(process.env.CONTROL_PLANE_STATE_DIR ? { stateDir: process.env.CONTROL_PLANE_STATE_DIR } : {}),
  });
  await ensureStartupActive();

  const [database, { createApp }, { reconcileAtStartup }, { startScheduler }, files, { serve }] = await Promise.all([
    import("@agentos/db"),
    import("./app.js"),
    import("./reconcile.js"),
    import("./scheduler.js"),
    import("./files/config.js"),
    import("@hono/node-server"),
  ]);
  prisma = database.prisma;
  await ensureStartupActive();

  const filesRoot = files.resolveFilesRoot();
  await files.warnIfICloudPath(filesRoot);
  await files.assertFilesRootIsolated(filesRoot, ownership.canonicalWorkspaceRoot);
  await files.getFileStore();
  files.warnIfRunnerSharesPrincipal(filesRoot);

  await ownership.assertHeld();
  const reconciliation = await reconcileAtStartup(
    prisma,
    ownership.canonicalWorkspaceRoot,
    Number.parseInt(process.env.RUNNER_FAILED_WORKSPACE_RETENTION ?? "2", 10),
  );
  console.log(`Startup reconciliation: ${reconciliation.runs} database runs reconciled, ${reconciliation.workspaces} workspaces cleaned, ${reconciliation.archivedNotices} archived-run notices`);
  await ensureStartupActive();

  const app = createApp(prisma, {
    workspaceRoot: ownership.canonicalWorkspaceRoot,
    ownership,
  });
  const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);
  const hostname = process.env.API_HOST ?? "0.0.0.0";
  const activeServer = serve({ fetch: app.fetch, hostname, port });
  server = activeServer;
  await new Promise<void>((resolve, reject) => {
    const listening = (): void => {
      activeServer.off("error", failed);
      resolve();
    };
    const failed = (error: Error): void => {
      activeServer.off("listening", listening);
      reject(error);
    };
    activeServer.once("listening", listening);
    activeServer.once("error", failed);
  });
  await ensureStartupActive();
  const address = activeServer.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`AgentOS API listening on http://${hostname}:${listeningPort}`);
  schedulerTimer = startScheduler(prisma);
  startupBusy = false;
};

try {
  await main();
} catch (error: unknown) {
  startupBusy = false;
  if (error instanceof ControlPlaneOwnershipStartupError) {
    process.exitCode = error.exitCode;
  } else if (error instanceof StartupCancelledBySignalError) {
    await cleanup(0).catch((cleanupError: unknown) => console.error("AgentOS API cleanup failed", cleanupError));
  } else {
    console.error("AgentOS API startup failed", error);
    await cleanup(1).catch((cleanupError: unknown) => console.error("AgentOS API cleanup failed", cleanupError));
  }
}
