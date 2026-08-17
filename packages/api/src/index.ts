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
let startupBusy = false;

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
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
    await closeServer();
    if (prisma) await prisma.$disconnect();
    if (ownership) await ownership.release();
    process.exitCode = exitCode;
  })();
  return cleanupPromise;
};

const ensureStartupActive = async (): Promise<void> => {
  if (!requestedSignal) return;
  await cleanup(0);
  throw new Error(`startup-cancelled-by-${requestedSignal}`);
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

  startupBusy = true;
  const [database, { createApp }, { reconcileAtStartup }, { startScheduler }, files, { serve }] = await Promise.all([
    import("@agentos/db"),
    import("./app.js"),
    import("./reconcile.js"),
    import("./scheduler.js"),
    import("./files/config.js"),
    import("@hono/node-server"),
  ]);
  prisma = database.prisma;
  startupBusy = false;
  await ensureStartupActive();

  const filesRoot = files.resolveFilesRoot();
  await files.warnIfICloudPath(filesRoot);
  await files.assertFilesRootIsolated(filesRoot, ownership.canonicalWorkspaceRoot);
  files.warnIfRunnerSharesPrincipal(filesRoot);

  startupBusy = true;
  await ownership.assertHeld();
  const reconciliation = await reconcileAtStartup(
    prisma,
    ownership.canonicalWorkspaceRoot,
    Number.parseInt(process.env.RUNNER_FAILED_WORKSPACE_RETENTION ?? "2", 10),
  );
  startupBusy = false;
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
};

try {
  await main();
} catch (error: unknown) {
  startupBusy = false;
  if (error instanceof ControlPlaneOwnershipStartupError) {
    process.exitCode = error.exitCode;
  } else if (!requestedSignal) {
    console.error("AgentOS API startup failed", error);
    await cleanup(1).catch((cleanupError: unknown) => console.error("AgentOS API cleanup failed", cleanupError));
  }
}
