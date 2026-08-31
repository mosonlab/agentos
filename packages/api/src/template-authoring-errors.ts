/**
 * Stable refusal codes for the operator template-authoring surface.
 *
 * These are deliberately separate from TemplateInstantiationRefusalCode: a
 * malformed or conflicting authoring request has a different contract and
 * status family from a template that cannot be materialised into a Chain.
 */
export type TemplateAuthoringRefusalCode =
  | "template_not_in_project"
  | "template_name_taken"
  | "template_name_reserved"
  | "template_canonical"
  | "template_in_use"
  | "graph_empty"
  | "first_step_not_agent"
  | "first_layer_not_single"
  | "layer_order_invalid"
  | "base_step_invalid"
  | "prior_kind_unproduced"
  | "output_kind_duplicate"
  | "prior_kind_duplicate"
  | "approval_gate_in_parallel_layer"
  | "assignee_invalid"
  | "integrator_binding_invalid";

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
