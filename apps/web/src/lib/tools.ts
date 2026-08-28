import { ENFORCED_BY, type ToolKey } from "@anneal/db/model-routing";

import type { RunnerKind } from "./types";

export { ENFORCED_BY, TOOL_KEYS } from "@anneal/db/model-routing";
export type { ToolKey } from "@anneal/db/model-routing";

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

export const isEnforced = (runner: RunnerKind, key: ToolKey): boolean => ENFORCED_BY[runner].includes(key);
