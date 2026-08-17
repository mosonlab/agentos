import type { PrismaClient } from "@agentos/db";

import { createApp as createLiveApp } from "./app.js";
import { defaultWorkspaceRoot } from "./workspace-root.js";

/** Test-only capability. Production imports createApp directly from app.ts. */
export const createApp = (db: PrismaClient) => createLiveApp(db, {
  workspaceRoot: process.env.RUNNER_WORKSPACE_ROOT ?? defaultWorkspaceRoot(),
  ownership: { assertHeld: () => undefined },
});

export { partitionArchivable } from "./app.js";
