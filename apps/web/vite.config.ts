import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from "vite";

import {
  LOOPBACK_HOST,
  WEB_DEV_PORT,
  WEB_PREVIEW_PORT,
  createProxyGuard,
  resolveProxyTarget,
  serverOrigins,
} from "./src/lib/local-origin.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceRoot = fileURLToPath(new URL("./src", import.meta.url));

/** DECISIONS #17: no login on localhost. The operator bearer token therefore
 *  stays in this dev/preview server — it is attached to every proxied request
 *  instead of being embedded in the browser bundle.
 *
 *  That makes this process a credential holder, so two checks run before it can
 *  ever attach the header: `resolveProxyTarget` decides the destination is the
 *  exact loopback origin (no proxy is created otherwise), and the guard plugin
 *  below decides, per request, that the caller is this server's own loopback
 *  origin. Both live in `src/lib/local-origin.ts`, which is unit-tested; the
 *  policy is not restated here. */
export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, repositoryRoot, "");
  // First, and before anything is built: a refused destination throws here, so
  // no proxy, no bearer header, no DNS lookup and no socket ever exists.
  const target = resolveProxyTarget(environment);
  const token = environment["OPERATOR_TOKEN"] ?? "";
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

  /** Installed inside `configureServer`, which Vite calls *before* it adds its
   *  own middlewares — so `server.middlewares.use` here runs ahead of the proxy
   *  rather than after it. The allowed origins are read per request from the
   *  address the server actually bound, so `--port` changes what is served and
   *  what is admitted at the same time, and never widens the policy.
   *
   *  The guarded paths are `Object.keys(proxy)` — the very keys Vite matches
   *  against — rather than a literal restated here. A proxy entry is guarded by
   *  the act of being registered, so no entry can exist that Vite forwards with
   *  the token attached and the guard never looked at. */
  const localTransportBoundary: Plugin = {
    name: "agentos-local-transport-boundary",
    configureServer(server) {
      const guard = createProxyGuard(() => {
        const address = server.httpServer?.address();
        const port = typeof address === "object" && address ? address.port : server.config.server.port ?? WEB_DEV_PORT;
        return serverOrigins(port);
      }, Object.keys(proxy));
      server.middlewares.use(guard);
    },
    configurePreviewServer(server) {
      const guard = createProxyGuard(() => {
        const address = server.httpServer.address();
        const port = typeof address === "object" && address ? address.port : server.config.preview.port ?? WEB_PREVIEW_PORT;
        return serverOrigins(port);
      }, Object.keys(proxy));
      server.middlewares.use(guard);
    },
  };

  return {
    plugins: [react(), tailwindcss(), localTransportBoundary],
    resolve: { alias: { "@": sourceRoot } },
    // The loopback literal, not `0.0.0.0` and not a name: this server holds the
    // operator token, so it answers on one address and only that one.
    server: { host: LOOPBACK_HOST, port: WEB_DEV_PORT, proxy },
    preview: { host: LOOPBACK_HOST, port: WEB_PREVIEW_PORT, proxy },
  };
});
