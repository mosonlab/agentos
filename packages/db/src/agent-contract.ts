import { RunnerKind, RunnerPreference } from "@prisma/client";

export const CANONICAL_AGENT_DEFAULTS = [
  { name: "default", model: "gpt-5.6-sol:medium", runner: RunnerPreference.CODEX },
  { name: "frontend-dev", model: "claude-opus-5:high", runner: RunnerPreference.CLAUDE },
  { name: "implementation-plan-executioner", model: "claude-opus-5:high", runner: RunnerPreference.CLAUDE },
  { name: "librarian", model: "gpt-5.6-luna:high", runner: RunnerPreference.CODEX },
  // Not an LLM role. The sentinel Agent row step 10 binds so a mechanical run
  // can carry a non-null `Run.agentId` without presenting a second human gate.
  // `catalogRunnerForModel` returns null for this model, so the runner/model
  // mismatch assertion below never fires on it, and `INHERIT` is inert because
  // no adapter is ever constructed for it (agents/roles/merge-integrator.md).
  { name: "merge-integrator", model: "mechanical/merge-executor-v1", runner: RunnerPreference.INHERIT },
  { name: "plan", model: "claude-fable-5:medium", runner: RunnerPreference.CLAUDE },
  { name: "plan-reviser", model: "claude-opus-5:high", runner: RunnerPreference.CLAUDE },
  { name: "review-coordinator", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
  { name: "senior-dev", model: "claude-opus-5:high", runner: RunnerPreference.CLAUDE },
  { name: "spec", model: "claude-fable-5:medium", runner: RunnerPreference.CLAUDE },
] as const;

export const CANONICAL_TEMPLATE_STEPS = [
  { stepIndex: 1, agentName: "spec", outputKind: "spec", approvalGate: true, opensPullRequest: true },
  { stepIndex: 2, agentName: "plan", outputKind: "plan", approvalGate: false, opensPullRequest: true },
  { stepIndex: 3, agentName: "review-coordinator", outputKind: "plan-review", approvalGate: false, opensPullRequest: true },
  { stepIndex: 4, agentName: "plan-reviser", outputKind: "revised-plan", approvalGate: true, opensPullRequest: true },
  { stepIndex: 5, agentName: "implementation-plan-executioner", outputKind: "implementation", approvalGate: false, opensPullRequest: true },
  { stepIndex: 6, agentName: "review-coordinator", outputKind: "code-review", approvalGate: false, opensPullRequest: true },
  { stepIndex: 7, agentName: "senior-dev", outputKind: "fixed-implementation", approvalGate: false, opensPullRequest: true },
  { stepIndex: 8, agentName: "librarian", outputKind: "documentation", approvalGate: false, opensPullRequest: true },
  { stepIndex: 9, agentName: null, outputKind: "approval", approvalGate: true, opensPullRequest: true },
  // Step 10 executes the merge mechanically and publishes nothing:
  // `opensPullRequest: false` is load-bearing, because `templates.ts` copies it
  // onto the materialized task row and `enqueueTaskRun` copies that onto the
  // run. Steps 1-9 carry `true` to preserve exactly today's seeded behaviour,
  // which took `schema.prisma`'s column default because the seed tuple omitted
  // the field entirely.
  { stepIndex: 10, agentName: "merge-integrator", outputKind: "merge-result", approvalGate: false, opensPullRequest: false },
] as const;

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
