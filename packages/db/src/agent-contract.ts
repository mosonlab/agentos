import { RunnerKind, RunnerPreference } from "@prisma/client";

import { catalogRunnerForModel, splitModel } from "./model-routing.js";

/**
 * The Direct tier has no spec or plan phase and ends in the same mechanical
 * readiness and merge contract as the full-assurance template. Implementation
 * is senior-dev-luna, not the executioner, whose
 * contract presumes an existing reviewed plan.
 */
export const DIRECT_TEMPLATE_NAME = "direct-engineer-workflow";
/** The pull-request workflow installs only through an open pull request. */
export const PR_TEMPLATE_NAME = "pr-engineer-workflow";
export const IMPLEMENTATION_PLAN_OUTPUT_KINDS = ["plan", "revised-plan"] as const;

export { catalogRunnerForModel } from "./model-routing.js";

/**
 * The two roles whose slug names no model: `default` is the public starter, whose
 * whole point is that a first installation gets one Agent under a stable name, and
 * `merge-integrator` is the mechanical sentinel, which runs no model at all.
 */
export const MODEL_FREE_CANONICAL_ROLES = ["default", "merge-integrator"] as const;

/** Vendor and version tokens a catalog model id carries around its short name. */
const MODEL_ID_NOISE = new Set(["claude", "gpt", "openai", "codex"]);

/**
 * The short name a canonical slug carries: `gpt-6-astra` is `astra`,
 * `claude-fable-5` is `fable`. Derived rather than listed so a model added to the
 * catalog needs no second table here, and null when a model id carries no single
 * name — the mechanical `mechanical/merge-executor-v1` is the live example.
 */
export const modelShortName = (rawModel: string): string | null => {
  const { model } = splitModel(rawModel);
  const words = model.slice(model.lastIndexOf("/") + 1)
    .split("-")
    .filter((word) => /^[a-z]+$/u.test(word) && !MODEL_ID_NOISE.has(word));
  return words.length === 1 ? words[0]! : null;
};

/**
 * The canonical slug a role's runtime configuration implies: `role-model-effort`,
 * as in `senior-dev-astra-low`. Null for a role whose model names no short name or
 * pins no effort; those roles must be listed in `MODEL_FREE_CANONICAL_ROLES`.
 */
export const canonicalRoleSlugSuffix = (model: string): string | null => {
  const short = modelShortName(model);
  const { effort } = splitModel(model);
  return short && effort ? `-${short}-${effort}` : null;
};

/** Words a title may not contain: a title names the role, never its runtime. */
const RUNTIME_TITLE_WORDS = new Set([
  ...["low", "medium", "high", "xhigh", "max", "minimal", "none", "off"],
  ...["claude", "gpt", "codex", "pi", "openai", "mechanical"],
]);

/**
 * The `agents/roles/` naming contract, checked once where the sources are loaded.
 *
 * A slug states the runtime it binds (`code-reviewer-sol-high`) so two roles that
 * differ only by model or effort cannot collide, and a title states the role alone
 * (`Code Reviewer`) so the console reads as a roster of jobs rather than of models.
 * Both are checked here rather than by review, because a rollover that renames one
 * file and forgets the other leaves two names for one role.
 */
export const assertCanonicalAgentSources = (
  roles: ReadonlyArray<{
    canonicalRole: string;
    name: string;
    title: string;
    model: string;
    runnerPreference: RunnerPreference;
  }>,
): void => {
  const actual = new Map(roles.map((role) => [role.name, role]));
  if (actual.size !== roles.length) throw new Error("agents/ contract contains duplicate role names");
  const exceptions = new Set<string>(MODEL_FREE_CANONICAL_ROLES);
  for (const role of roles) {
    const catalogRunner = catalogRunnerForModel(role.model);
    if (catalogRunner && catalogRunner !== role.runnerPreference) {
      throw new Error(`${role.name} runner/model mismatch: ${role.runnerPreference}/${role.model}`);
    }
    if (role.canonicalRole !== role.name) {
      throw new Error(`${role.name} is loaded from role file ${role.canonicalRole}; a role file is named after the role`);
    }
    if (!exceptions.has(role.name)) {
      const suffix = canonicalRoleSlugSuffix(role.model);
      if (!suffix) {
        throw new Error(`${role.name} model ${role.model} names no model and effort; only ${[...exceptions].join(", ")} may omit them`);
      }
      if (!role.name.endsWith(suffix) || role.name.length <= suffix.length) {
        throw new Error(`${role.name} must be named <role>${suffix} for model ${role.model}`);
      }
    }
    const words = role.title.trim().split(/\s+/u);
    // One or two words: `Planner` and `Librarian` are whole roles, and nothing in
    // this roster needs three. Anything longer has started restating the runtime.
    if (words.length > 2 || !words.every((word) => /^[A-Z][a-z]+$/u.test(word))) {
      throw new Error(`${role.name} title ${JSON.stringify(role.title)} must be one or two capitalised words naming the role`);
    }
    const runtimeWord = words.find((word) => RUNTIME_TITLE_WORDS.has(word.toLowerCase())
      || word.toLowerCase() === modelShortName(role.model));
    if (runtimeWord) {
      throw new Error(`${role.name} title ${JSON.stringify(role.title)} names the runtime (${runtimeWord}); a title names the role`);
    }
  }
};

export const isTemplateRunnerInherited = (runner: RunnerKind | null): boolean => runner === null;
