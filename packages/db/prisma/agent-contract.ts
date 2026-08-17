import { RunnerKind, RunnerPreference } from "@prisma/client";

export const CANONICAL_AGENT_DEFAULTS = [
  { name: "code-reviewer", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
  { name: "default", model: "gpt-5.6-sol:medium", runner: RunnerPreference.CODEX },
  { name: "feasibility", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
  { name: "frontend-dev", model: "gpt-5.6-sol:medium", runner: RunnerPreference.CODEX },
  { name: "implementation-plan-executioner", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
  { name: "librarian", model: "gpt-5.6-luna:high", runner: RunnerPreference.CODEX },
  { name: "plan", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
  { name: "plan-reviser", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
  { name: "review-coordinator", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
  { name: "senior-dev", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
  { name: "spec", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
] as const;

export const CANONICAL_TEMPLATE_STEPS = [
  { stepIndex: 1, agentName: "spec" },
  { stepIndex: 2, agentName: "plan" },
  { stepIndex: 3, agentName: "review-coordinator" },
  { stepIndex: 4, agentName: "plan-reviser" },
  { stepIndex: 5, agentName: "implementation-plan-executioner" },
  { stepIndex: 6, agentName: "code-reviewer" },
  { stepIndex: 7, agentName: "senior-dev" },
  { stepIndex: 8, agentName: "librarian" },
  { stepIndex: 9, agentName: null },
] as const;

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
