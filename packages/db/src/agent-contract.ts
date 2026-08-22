import { RunnerKind, RunnerPreference } from "@prisma/client";

export const CANONICAL_AGENT_DEFAULTS = [
  { name: "default", model: "gpt-5.6-sol:medium", runner: RunnerPreference.CODEX },
  { name: "frontend-dev", model: "claude-opus-5:medium", runner: RunnerPreference.CLAUDE },
  { name: "implementation-plan-executioner", model: "gpt-5.6-sol:medium", runner: RunnerPreference.CODEX },
  { name: "librarian", model: "gpt-5.6-terra:high", runner: RunnerPreference.CODEX },
  // Not an LLM role. The sentinel Agent row step 12 binds so a mechanical run
  // can carry a non-null `Run.agentId` without presenting a second human gate.
  // `catalogRunnerForModel` returns null for this model, so the runner/model
  // mismatch assertion below never fires on it, and `INHERIT` is inert because
  // no adapter is ever constructed for it (agents/roles/merge-integrator.md).
  { name: "merge-integrator", model: "mechanical/merge-executor-v1", runner: RunnerPreference.INHERIT },
  { name: "merge-resolver", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
  { name: "plan", model: "claude-fable-5:medium", runner: RunnerPreference.CLAUDE },
  { name: "plan-reviser", model: "claude-fable-5:medium", runner: RunnerPreference.CLAUDE },
  { name: "review-coordinator", model: "openai-codex/gpt-5.6-sol:high", runner: RunnerPreference.PI },
  { name: "review-coordinator-opus", model: "claude-opus-5:medium", runner: RunnerPreference.CLAUDE },
  { name: "review-coordinator-sol", model: "openai-codex/gpt-5.6-sol:high", runner: RunnerPreference.PI },
  { name: "senior-dev", model: "gpt-5.6-sol:medium", runner: RunnerPreference.CODEX },
  { name: "senior-dev-luna", model: "gpt-5.6-luna:max", runner: RunnerPreference.CODEX },
  { name: "spec", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
] as const;

/**
 * The Direct tier has no spec or plan phase and ends in the same mechanical
 * readiness and merge contract as the full-assurance template. Implementation
 * is senior-dev-luna, not the executioner, whose
 * contract presumes an existing reviewed plan.
 */
export const DIRECT_TEMPLATE_NAME = "direct-engineer-workflow";
export const IMPLEMENTATION_PLAN_OUTPUT_KINDS = ["plan", "revised-plan"] as const;

export const catalogRunnerForModel = (raw: string): RunnerPreference | null => {
  const model = raw.slice(0, raw.lastIndexOf(":") > 0 ? raw.lastIndexOf(":") : raw.length);
  if (model.startsWith("claude-")) return RunnerPreference.CLAUDE;
  if (model.startsWith("openai-codex/")) return RunnerPreference.PI;
  if (model.startsWith("gpt-")) return RunnerPreference.CODEX;
  return null;
};

export const assertCanonicalAgentSources = (
  roles: Array<{ name: string; model: string; runnerPreference: RunnerPreference }>,
): void => {
  const actual = new Map(roles.map((role) => [role.name, role]));
  if (actual.size !== roles.length) throw new Error("agents/ contract contains duplicate role names");
  const expectedNames = CANONICAL_AGENT_DEFAULTS.map((role) => role.name);
  const actualNames = [...actual.keys()].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify([...expectedNames].sort())) {
    throw new Error(`agents/ canonical roles must be ${expectedNames.join(", ")}; found ${actualNames.join(", ")}`);
  }
  for (const expected of CANONICAL_AGENT_DEFAULTS) {
    const role = actual.get(expected.name)!;
    if (role.model !== expected.model || role.runnerPreference !== expected.runner) {
      throw new Error(`${role.name} must use ${expected.runner}/${expected.model}; found ${role.runnerPreference}/${role.model}`);
    }
    const catalogRunner = catalogRunnerForModel(role.model);
    if (catalogRunner && catalogRunner !== role.runnerPreference) {
      throw new Error(`${role.name} runner/model mismatch: ${role.runnerPreference}/${role.model}`);
    }
  }
};

export const isTemplateRunnerInherited = (runner: RunnerKind | null): boolean => runner === null;
