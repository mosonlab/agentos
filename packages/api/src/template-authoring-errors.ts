import type { RefusalStatus } from "./refusal-status.js";

/**
 * Stable refusal codes for the operator template-authoring surface, each
 * declared with the HTTP status family it is answered with. The code union is
 * derived from this table, so a code cannot exist without a status family.
 *
 * These are deliberately separate from TemplateInstantiationRefusalCode: a
 * malformed or conflicting authoring request has a different contract and
 * status family from a template that cannot be materialised into a Chain.
 */
export const templateAuthoringRefusalStatus = {
  template_not_in_project: 404,
  template_name_taken: 409,
  template_name_reserved: 409,
  template_canonical: 409,
  template_in_use: 409,
  graph_empty: 422,
  first_step_not_agent: 422,
  first_step_optional: 422,
  first_layer_not_single: 422,
  layer_order_invalid: 422,
  base_step_invalid: 422,
  base_step_optional: 422,
  gate_slot_step_optional: 422,
  optional_step_precedes_merge_tail: 422,
  prior_kind_unproduced: 422,
  output_kind_duplicate: 422,
  prior_kind_duplicate: 422,
  approval_gate_in_parallel_layer: 422,
  assignee_invalid: 422,
  integrator_binding_invalid: 422,
} as const satisfies Record<string, RefusalStatus>;

export type TemplateAuthoringRefusalCode = keyof typeof templateAuthoringRefusalStatus;

/** A stable, machine-readable refusal raised while authoring a template. */
export class TemplateAuthoringRefusal extends Error {
  constructor(
    readonly code: TemplateAuthoringRefusalCode,
    message: string,
    readonly stepIndex?: number,
  ) {
    super(message);
    this.name = "TemplateAuthoringRefusal";
  }
}

export const isTemplateAuthoringRefusal = (
  error: unknown,
): error is TemplateAuthoringRefusal => error instanceof TemplateAuthoringRefusal;
