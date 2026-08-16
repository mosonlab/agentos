import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceRoot = fileURLToPath(new URL("./src", import.meta.url));

/** DECISIONS #17: no login on localhost. The operator bearer token therefore
 *  stays in this dev/preview server — it is attached to every proxied request
 *  instead of being embedded in the browser bundle. */
export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, repositoryRoot, "");
  const token = environment.OPERATOR_TOKEN ?? "";
  const target = environment.WEB_API_URL ?? `http://127.0.0.1:${environment.API_PORT ?? "3000"}`;
  if (token === "") {
    console.warn("[agentos/web] OPERATOR_TOKEN is not set in the repository root .env; the control plane will answer 401.");
  }

  const proxy: Record<string, ProxyOptions> = {
    "/api": {
      target,
      changeOrigin: false,
      headers: { Authorization: `Bearer ${token}` },
      rewrite: (path) => path.replace(/^\/api/, ""),
    },
  };

  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": sourceRoot } },
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
  };
});
