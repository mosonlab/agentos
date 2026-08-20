import { RunnerKind, RunnerPreference } from "@prisma/client";

export const CANONICAL_AGENT_DEFAULTS = [
  { name: "default", model: "gpt-5.6-sol:medium", runner: RunnerPreference.CODEX },
  { name: "frontend-dev", model: "claude-opus-5:high", runner: RunnerPreference.CLAUDE },
  { name: "implementation-plan-executioner", model: "gpt-5.6-sol:medium", runner: RunnerPreference.CODEX },
  { name: "librarian", model: "gpt-5.6-terra:high", runner: RunnerPreference.CODEX },
  // Not an LLM role. The sentinel Agent row step 12 binds so a mechanical run
  // can carry a non-null `Run.agentId` without presenting a second human gate.
  // `catalogRunnerForModel` returns null for this model, so the runner/model
  // mismatch assertion below never fires on it, and `INHERIT` is inert because
  // no adapter is ever constructed for it (agents/roles/merge-integrator.md).
  { name: "merge-integrator", model: "mechanical/merge-executor-v1", runner: RunnerPreference.INHERIT },
  { name: "plan", model: "claude-fable-5:medium", runner: RunnerPreference.CLAUDE },
  { name: "plan-reviser", model: "claude-fable-5:medium", runner: RunnerPreference.CLAUDE },
  { name: "review-coordinator", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
  { name: "review-coordinator-opus", model: "claude-opus-5:high", runner: RunnerPreference.CLAUDE },
  { name: "review-coordinator-sol", model: "gpt-5.6-sol:high", runner: RunnerPreference.CODEX },
  { name: "senior-dev", model: "gpt-5.6-sol:medium", runner: RunnerPreference.CODEX },
  { name: "spec", model: "claude-fable-5:medium", runner: RunnerPreference.CLAUDE },
] as const;

export const CANONICAL_TEMPLATE_STEPS = [
  { stepIndex: 1, agentName: "spec", outputKind: "spec", approvalGate: true, opensPullRequest: false, attachmentsFromPrevious: false },
  { stepIndex: 2, agentName: "plan", outputKind: "plan", approvalGate: false, opensPullRequest: false, attachmentsFromPrevious: true },
  { stepIndex: 3, agentName: "review-coordinator", outputKind: "plan-review", approvalGate: false, opensPullRequest: false, attachmentsFromPrevious: true },
  { stepIndex: 4, agentName: "plan-reviser", outputKind: "revised-plan", approvalGate: true, opensPullRequest: false, attachmentsFromPrevious: true },
  { stepIndex: 5, agentName: "implementation-plan-executioner", outputKind: "implementation", approvalGate: false, opensPullRequest: true, attachmentsFromPrevious: true },
  { stepIndex: 6, agentName: "review-coordinator-sol", outputKind: "sol-findings", approvalGate: false, opensPullRequest: false, attachmentsFromPrevious: true },
  // Blind review must persist its own report before reading step 6.
  { stepIndex: 7, agentName: "review-coordinator-opus", outputKind: "must-fix", approvalGate: false, opensPullRequest: false, attachmentsFromPrevious: false },
  { stepIndex: 8, agentName: "senior-dev", outputKind: "fixed-implementation", approvalGate: false, opensPullRequest: false, attachmentsFromPrevious: true },
  // Regression verification consumes the complete step-8 fix diff.
  { stepIndex: 9, agentName: "review-coordinator-opus", outputKind: "regression-verification", approvalGate: false, opensPullRequest: false, attachmentsFromPrevious: true },
  { stepIndex: 10, agentName: "librarian", outputKind: "documentation", approvalGate: false, opensPullRequest: false, attachmentsFromPrevious: true },
  { stepIndex: 11, agentName: null, outputKind: "approval", approvalGate: true, opensPullRequest: false, attachmentsFromPrevious: true },
  // Step 12 executes the merge mechanically and publishes nothing:
  // `opensPullRequest: false` is load-bearing, because `templates.ts` copies it
  // onto the materialized task row and `enqueueTaskRun` copies that onto the
  // run. Step 5 is the only row allowed to create the chain's pull request;
  // every review, fix, documentation, approval, and merge row reuses it.
  { stepIndex: 12, agentName: "merge-integrator", outputKind: "merge-result", approvalGate: false, opensPullRequest: false, attachmentsFromPrevious: true },
] as const;

/**
 * The Direct tier: no spec or plan phase, and no mechanical merge — the
 * integrator's bidirectional binding admits only step 12 of the twelve-step
 * template, so a direct chain ends at its human pull-request gate and the
 * human merges. Implementation is senior-dev, not the executioner, whose
 * contract presumes an existing reviewed plan.
 */
export const DIRECT_TEMPLATE_NAME = "direct-engineer-workflow";

export const DIRECT_TEMPLATE_STEPS = [
  { stepIndex: 1, agentName: "senior-dev", outputKind: "implementation", approvalGate: false, opensPullRequest: true, attachmentsFromPrevious: false },
  { stepIndex: 2, agentName: "review-coordinator-sol", outputKind: "sol-findings", approvalGate: false, opensPullRequest: false, attachmentsFromPrevious: true },
  // Blind review must persist its own report before reading step 2.
  { stepIndex: 3, agentName: "review-coordinator-opus", outputKind: "must-fix", approvalGate: false, opensPullRequest: false, attachmentsFromPrevious: false },
  { stepIndex: 4, agentName: "senior-dev", outputKind: "fixed-implementation", approvalGate: false, opensPullRequest: false, attachmentsFromPrevious: true },
  { stepIndex: 5, agentName: "review-coordinator-opus", outputKind: "regression-verification", approvalGate: false, opensPullRequest: false, attachmentsFromPrevious: true },
  { stepIndex: 6, agentName: null, outputKind: "approval", approvalGate: true, opensPullRequest: false, attachmentsFromPrevious: true },
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
