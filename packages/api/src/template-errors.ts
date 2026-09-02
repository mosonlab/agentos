export type TemplateInstantiationRefusalCode =
  | "after_task_already_bound"
  | "after_task_already_done"
  | "after_task_archived"
  | "after_task_not_chained"
  | "after_task_not_found"
  | "after_task_not_terminal"
  | "dispatch_conflicts_with_auto_start"
  | "gates_merge_step_absent"
  | "gates_spec_step_absent"
  | "implementation_route_agent_renamed"
  | "implementation_route_conflicts_with_step_override"
  | "implementation_route_malformed"
  | "repo_not_found"
  | "step_override_agent_archived"
  | "step_override_agent_not_found"
  | "step_override_compound_implementation"
  | "step_override_integrator_binding"
  | "step_override_invalid_key"
  | "step_override_missing_repo_grant"
  | "step_override_step_not_agent"
  | "step_override_too_many"
  | "step_override_unknown_step"
  | "template_agent_repo_grant_missing"
  | "template_base_reference_missing"
  | "template_base_reference_not_earlier"
  | "template_branch_invalid"
  | "template_compound_implementation_assignee_invalid"
  | "template_first_step_not_agent"
  | "template_has_no_instantiable_steps"
  | "template_has_no_steps"
  | "template_integrator_binding_invalid"
  | "template_not_found"
  | "template_step_agent_archived"
  | "template_step_agent_missing"
  | "template_variables_missing"
  | "template_variables_unknown";

/** A stable, machine-readable refusal raised while materialising a template chain. */
export class TemplateInstantiationRefusal extends Error {
  constructor(
    readonly code: TemplateInstantiationRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "TemplateInstantiationRefusal";
  }
}

export const isTemplateInstantiationRefusal = (
  error: unknown,
): error is TemplateInstantiationRefusal => error instanceof TemplateInstantiationRefusal;
