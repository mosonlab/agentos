import type { RunnerKind } from "./types";

export const TOOL_KEYS = ["BASH", "READ", "WRITE", "EDIT", "GLOB", "GREP", "WEB_FETCH", "WEB_SEARCH"] as const;
export type ToolKey = typeof TOOL_KEYS[number];

export const TOOL_LABEL_KEYS: Record<ToolKey, string> = {
  BASH: "agents.tools.BASH",
  READ: "agents.tools.READ",
  WRITE: "agents.tools.WRITE",
  EDIT: "agents.tools.EDIT",
  GLOB: "agents.tools.GLOB",
  GREP: "agents.tools.GREP",
  WEB_FETCH: "agents.tools.WEB_FETCH",
  WEB_SEARCH: "agents.tools.WEB_SEARCH",
};

/** Must stay in lockstep with packages/runner/src/adapters.ts's CLI maps. */
export const ENFORCED_BY: Record<RunnerKind, ToolKey[]> = {
  CLAUDE: [...TOOL_KEYS],
  CODEX: [],
  PI: ["BASH", "READ", "WRITE", "EDIT"],
};

export const isEnforced = (runner: RunnerKind, key: ToolKey): boolean => ENFORCED_BY[runner].includes(key);
