import { RunnerKind, RunnerPreference } from "@prisma/client";

import { catalogRunnerForModel } from "./model-routing.js";

/**
 * The Direct tier has no spec or plan phase and ends in the same mechanical
 * readiness and merge contract as the full-assurance template. Implementation
 * is senior-dev-luna, not the executioner, whose
 * contract presumes an existing reviewed plan.
 */
export const DIRECT_TEMPLATE_NAME = "direct-engineer-workflow";
export const PR_TEMPLATE_NAME = "pr-engineer-workflow";
export const IMPLEMENTATION_PLAN_OUTPUT_KINDS = ["plan", "revised-plan"] as const;

export { catalogRunnerForModel } from "./model-routing.js";

export const assertCanonicalAgentSources = (
  roles: ReadonlyArray<{ name: string; model: string; runnerPreference: RunnerPreference }>,
): void => {
  const actual = new Map(roles.map((role) => [role.name, role]));
  if (actual.size !== roles.length) throw new Error("agents/ contract contains duplicate role names");
  for (const role of roles) {
    const catalogRunner = catalogRunnerForModel(role.model);
    if (catalogRunner && catalogRunner !== role.runnerPreference) {
      throw new Error(`${role.name} runner/model mismatch: ${role.runnerPreference}/${role.model}`);
    }
  }
};

export const isTemplateRunnerInherited = (runner: RunnerKind | null): boolean => runner === null;
