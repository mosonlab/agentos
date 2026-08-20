import type { RunnerKind, RunnerPreference } from "./types";

export type CatalogModel = {
  id: string;
  label: string;
  runner: RunnerKind;
  efforts: string[];
  defaultEffort: string;
};

/**
 * CODEX was checked against the installed CLI on 2026-08-16. Its structured
 * invalid-enum response named all seven values captured in
 * spikes/cli-capabilities/samples/codex-effort-nonsense.stdout.
 */
const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const MODELS: CatalogModel[] = [
  { id: "claude-fable-5", label: "Claude Fable 5", runner: "CLAUDE", efforts: CLAUDE_EFFORTS, defaultEffort: "medium" },
  { id: "claude-opus-5", label: "Claude Opus 5", runner: "CLAUDE", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", runner: "CLAUDE", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", runner: "CLAUDE", efforts: CLAUDE_EFFORTS, defaultEffort: "high" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (codex)", runner: "CODEX", efforts: CODEX_EFFORTS, defaultEffort: "high" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (codex)", runner: "CODEX", efforts: CODEX_EFFORTS, defaultEffort: "medium" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna (codex)", runner: "CODEX", efforts: CODEX_EFFORTS, defaultEffort: "max" },
  { id: "openai-codex/gpt-5.6-luna", label: "GPT-5.6 Luna (pi)", runner: "PI", efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], defaultEffort: "max" },
];

export const splitModel = (raw: string): { model: string; effort: string | null } => {
  const at = raw.lastIndexOf(":");
  return at > 0 ? { model: raw.slice(0, at), effort: raw.slice(at + 1) } : { model: raw, effort: null };
};

export const joinModel = (model: string, effort: string | null): string => effort === null ? model : `${model}:${effort}`;

export const findModel = (id: string): CatalogModel | null => MODELS.find((entry) => entry.id === id) ?? null;

/** Catalog linkage for the model picker. For the runtime answer, use
 * `resolveRunner`, which mirrors packages/db/src/workflow.ts:22-30. */
export const runnerForModel = (id: string): RunnerKind | null => findModel(splitModel(id).model)?.runner ?? null;

/** Byte-faithful web mirror of packages/db/src/workflow.ts:22-30. This predicts
 * the actual runner for Custom models; it is deliberately distinct from the
 * catalog linkage returned by `runnerForModel`. */
export const resolveRunner = (preference: RunnerPreference, model: string): RunnerKind => {
  if (preference === "CLAUDE" || preference === "CODEX" || preference === "PI") return preference;
  const normalized = model.toLowerCase();
  if (normalized.includes("codex")) return "CODEX";
  if (normalized.includes("deepseek") || normalized.split(/[\/:_-]+/u).includes("pi")) return "PI";
  return "CLAUDE";
};

export type ModelPairIssue =
  | { kind: "mismatch"; model: string; expected: RunnerKind; actual: RunnerPreference }
  | { kind: "empty-model" }
  | null;

export const validateModelPair = (model: string, preference: RunnerPreference): ModelPairIssue => {
  if (model.trim().length === 0) return { kind: "empty-model" };
  const id = splitModel(model).model;
  const entry = findModel(id);
  if (entry && (preference === "CLAUDE" || preference === "CODEX" || preference === "PI") && preference !== entry.runner) {
    return { kind: "mismatch", model: id, expected: entry.runner, actual: preference };
  }
  return null;
};
