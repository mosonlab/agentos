import { serve } from "@hono/node-server";
import { config } from "dotenv";

config({
  path: new URL("../../../.env", import.meta.url),
  quiet: true,
});

const [{ prisma }, { app }, { defaultWorkspaceRoot, reconcileAtStartup }] = await Promise.all([
  import("@agentos/db"),
  import("./app.js"),
  import("./reconcile.js"),
]);

const reconciliation = await reconcileAtStartup(
  prisma,
  process.env.RUNNER_WORKSPACE_ROOT ?? defaultWorkspaceRoot(),
  Number.parseInt(process.env.RUNNER_FAILED_WORKSPACE_RETENTION ?? "2", 10),
);
console.log(`Startup reconciliation: ${reconciliation.runs} orphan runs, ${reconciliation.workspaces} workspaces cleaned`);

const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);
const hostname = process.env.API_HOST ?? "0.0.0.0";

const server = serve(
  {
    fetch: app.fetch,
    hostname,
    port,
  },
  (info) => {
    console.log(`AgentOS API listening on http://${hostname}:${info.port}`);
  },
);

const shutdown = async (signal: string): Promise<void> => {
  console.log(`Received ${signal}; shutting down AgentOS API`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
