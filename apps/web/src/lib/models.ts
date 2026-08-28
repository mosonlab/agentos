/**
 * The model catalog and the runner rule live in `@anneal/db/model-routing`,
 * a subpath that imports nothing at all, so the console reads the same rule the
 * control plane runs instead of a hand copy of it. This module re-exports that
 * surface and adds the one question only the console asks.
 */

import { runnerFor, splitModel } from "@anneal/db/model-routing";
import type { RunnerPreference } from "./types";

export {
  ENFORCED_BY,
  findModel,
  joinModel,
  MODELS,
  runnerFor,
  runnerForModel,
  splitModel,
  TOOL_KEYS,
  validateModelPair,
} from "@anneal/db/model-routing";
export type { CatalogModel, ModelPairIssue } from "@anneal/db/model-routing";

/** Whether the pair exposes the Codex service tier. A console control: the
 *  field exists on every agent, and this decides where it is worth showing. */
export const supportsCodexServiceTier = (preference: RunnerPreference, model: string): boolean => {
  const runner = runnerFor(preference, model);
  const id = splitModel(model).model;
  return (runner === "CODEX" && id.startsWith("gpt-"))
    || (runner === "PI" && id.startsWith("openai-codex/"));
};
