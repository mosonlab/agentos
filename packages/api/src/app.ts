import { prisma } from "@agentos/db";
import { Hono } from "hono";

export const app = new Hono();

app.get("/", (context) =>
  context.json({
    name: "AgentOS control plane",
    phase: 0,
  }),
);

app.get("/health", async (context) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    return context.json({
      status: "ok",
      database: "connected",
      checkedAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error("Health check failed", error);

    return context.json(
      {
        status: "error",
        database: "disconnected",
        checkedAt: new Date().toISOString(),
      },
      503,
    );
  }
});

app.notFound((context) =>
  context.json(
    {
      error: "Not found",
    },
    404,
  ),
);

