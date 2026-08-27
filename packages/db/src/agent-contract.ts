import { RunnerKind, RunnerPreference } from "@prisma/client";

import { catalogRunnerForModel } from "./model-routing.js";

export const CANONICAL_AGENT_DEFAULTS = [
  { name: "default", model: "gpt-5.6-sol:medium", runner: RunnerPreference.CODEX },
  { name: "frontend-dev", model: "claude-opus-5:medium", runner: RunnerPreference.CLAUDE },
  { name: "implementation-plan-executioner", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
  { name: "librarian", model: "openai-codex/gpt-5.6-luna:xhigh", runner: RunnerPreference.PI },
  // Not an LLM role. The sentinel Agent row step 12 binds so a mechanical run
  // can carry a non-null `Run.agentId` without presenting a second human gate.
  // `catalogRunnerForModel` returns null for this model, so the runner/model
  // mismatch assertion below never fires on it, and `INHERIT` is inert because
  // no adapter is ever constructed for it (agents/roles/merge-integrator.md).
  { name: "merge-integrator", model: "mechanical/merge-executor-v1", runner: RunnerPreference.INHERIT },
  { name: "merge-resolver", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
  { name: "plan", model: "claude-fable-5:medium", runner: RunnerPreference.CLAUDE },
  { name: "plan-reviser", model: "claude-opus-5:medium", runner: RunnerPreference.CLAUDE },
  { name: "regression-verifier", model: "claude-opus-5:medium", runner: RunnerPreference.CLAUDE },
  { name: "review-coordinator", model: "openai-codex/gpt-5.6-sol:xhigh", runner: RunnerPreference.PI },
  { name: "review-coordinator-opus", model: "claude-opus-5:high", runner: RunnerPreference.CLAUDE },
  { name: "review-coordinator-sol", model: "openai-codex/gpt-5.6-sol:xhigh", runner: RunnerPreference.PI },
  { name: "senior-dev", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
  { name: "senior-dev-luna", model: "gpt-5.6-luna:max", runner: RunnerPreference.CODEX },
  { name: "spec", model: "claude-opus-5:high", runner: RunnerPreference.CLAUDE },
] as const;

/**
 * Runtime migrations that predate operator-owned model selections. These are
 * the only persisted model/runner changes canonical sync may adopt without an
 * explicit operator override.
 */
export const CANONICAL_AGENT_RUNTIME_TRANSITIONS = new Map<string, {
  from: { model: string; runnerPreference: RunnerPreference };
  to: { model: string; runnerPreference: RunnerPreference };
}>([
  // 2026-08-25 ruling: the plan review is the sole reviewer gating implementation,
  // so it buys the same depth as the dual-vendor code review. Supersedes the
  // earlier CODEX-to-PI runner switch, whose target this from-value matches.
  ["review-coordinator", {
    from: { model: "openai-codex/gpt-5.6-sol:high", runnerPreference: RunnerPreference.PI },
    to: { model: "openai-codex/gpt-5.6-sol:xhigh", runnerPreference: RunnerPreference.PI },
  }],
  ["review-coordinator-sol", {
    from: { model: "openai-codex/gpt-5.6-sol:high", runnerPreference: RunnerPreference.PI },
    to: { model: "openai-codex/gpt-5.6-sol:xhigh", runnerPreference: RunnerPreference.PI },
  }],
  ["implementation-plan-executioner", {
    from: { model: "gpt-5.6-sol:medium", runnerPreference: RunnerPreference.CODEX },
    to: { model: "gpt-5.6-sol:high", runnerPreference: RunnerPreference.CODEX },
  }],
  // 2026-08-24 tier rulings: reviewed model/effort re-pins for uncustomized rows.
  ["librarian", {
    from: { model: "gpt-5.6-terra:high", runnerPreference: RunnerPreference.CODEX },
    to: { model: "openai-codex/gpt-5.6-luna:xhigh", runnerPreference: RunnerPreference.PI },
  }],
  ["regression-verifier", {
    from: { model: "openai-codex/gpt-5.6-sol:medium", runnerPreference: RunnerPreference.PI },
    to: { model: "claude-opus-5:medium", runnerPreference: RunnerPreference.CLAUDE },
  }],
  ["senior-dev", {
    from: { model: "gpt-5.6-sol:medium", runnerPreference: RunnerPreference.CODEX },
    to: { model: "gpt-5.6-sol:high", runnerPreference: RunnerPreference.CODEX },
  }],
  // 2026-08-26 ruling: revision is bounded by the consolidated findings, so it
  // does not buy frontier-tier depth. Supersedes the 2026-08-24 tier table's
  // plan-reviser row.
  ["plan-reviser", {
    from: { model: "claude-fable-5:medium", runnerPreference: RunnerPreference.CLAUDE },
    to: { model: "claude-opus-5:medium", runnerPreference: RunnerPreference.CLAUDE },
  }],
  // 2026-08-26 ruling: the spec is the specification of record every later step
  // is measured against, and the blind review is the only independent second
  // pair of eyes on the diff, so both buy frontier-tier depth.
  ["spec", {
    from: { model: "gpt-5.6-sol:high", runnerPreference: RunnerPreference.CODEX },
    to: { model: "claude-opus-5:high", runnerPreference: RunnerPreference.CLAUDE },
  }],
  ["review-coordinator-opus", {
    from: { model: "claude-opus-5:medium", runnerPreference: RunnerPreference.CLAUDE },
    to: { model: "claude-opus-5:high", runnerPreference: RunnerPreference.CLAUDE },
  }],
]);

/**
 * The Direct tier has no spec or plan phase and ends in the same mechanical
 * readiness and merge contract as the full-assurance template. Implementation
 * is senior-dev-luna, not the executioner, whose
 * contract presumes an existing reviewed plan.
 */
export const DIRECT_TEMPLATE_NAME = "direct-engineer-workflow";
export const IMPLEMENTATION_PLAN_OUTPUT_KINDS = ["plan", "revised-plan"] as const;

export { catalogRunnerForModel } from "./model-routing.js";

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
