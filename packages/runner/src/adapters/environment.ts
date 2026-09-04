import { join } from "node:path";

import type { RunnerConfig } from "../config.js";

const runnerProxyVariables = [
  [["HTTP_PROXY", "http_proxy"], "RUNNER_HTTP_PROXY"],
  [["HTTPS_PROXY", "https_proxy"], "RUNNER_HTTPS_PROXY"],
  [["NO_PROXY", "no_proxy"], "RUNNER_NO_PROXY"],
] as const;

/**
 * Builds the proxy environment owned by the runner, not by a CLI's user
 * settings. RUNNER_* is the only operator surface, so an unrelated proxy in
 * the runner daemon's own environment cannot silently reach child processes.
 */
export const runnerProxyEnvironment = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  Object.fromEntries(runnerProxyVariables.flatMap(([childNames, configuredName]) => {
    const value = env[configuredName];
    return value ? childNames.map((childName) => [childName, value]) : [];
  }));

export const workspaceEnvironment = (
  config: Pick<RunnerConfig, "path" | "home" | "runAsPrefix">
    & Partial<Pick<RunnerConfig, "gateServer" | "gateLocalSlots">>
    & Partial<Pick<RunnerConfig, "proxyEnvironment">>,
): NodeJS.ProcessEnv => ({
  PATH: config.path,
  HOME: config.home,
  // Codex and PI relocate HOME to isolate user-level skill discovery. Keep
  // Git's runner-account configuration (identity, credential helpers, URL
  // rewrites, and signing policy) on its original absolute path.
  GIT_CONFIG_GLOBAL: join(config.home, ".gitconfig"),
  LANG: "C.UTF-8",
  GIT_TERMINAL_PROMPT: "0",
  ...(config.gateServer ? { AGENTOS_GATE_SERVER: config.gateServer } : {}),
  ...(config.gateLocalSlots !== undefined ? {
    AGENTOS_GATE_ALLOW_LOCAL: "1",
    AGENTOS_GATE_LOCAL_SLOTS: String(config.gateLocalSlots),
  } : {}),
  ...(config.proxyEnvironment ?? runnerProxyEnvironment()),
  // macOS Keychain lookups (claude CLI auth) fail without the login identity.
  // Only the daemon's own identity is meant here: under a run-as prefix the
  // child is a different account, and telling it USER=<daemon owner> while
  // HOME is the launched account's home makes the CLI look up a Keychain and a
  // git identity for a user it is not running as. Leave the launcher to set it.
  ...(config.runAsPrefix.length === 0 && process.env.USER
    ? { USER: process.env.USER, LOGNAME: process.env.LOGNAME ?? process.env.USER }
    : {}),
});
