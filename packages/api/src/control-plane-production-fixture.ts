import { spawn } from "node:child_process";

if (process.env.AGENTOS_TEST_SPAWN_OWNERSHIP_DESCENDANT === "1") {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let spawned = false;
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (!spawned && text.includes("CONTROL_PLANE_OWNERSHIP_ACQUIRED")) {
      spawned = true;
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
        detached: false,
      });
      originalWrite(`OWNERSHIP_PRODUCTION_DESCENDANT_PID ${descendant.pid}\n`);
    }
    return Reflect.apply(originalWrite, process.stdout, [chunk, ...args]) as boolean;
  }) as typeof process.stdout.write;
}
