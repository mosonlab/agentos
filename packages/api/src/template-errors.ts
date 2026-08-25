/**
 * Refusals raised while materialising a template chain.
 *
 * The instantiate route deliberately handles this type before its legacy
 * message-based compatibility matcher.  A refusal therefore keeps its stable
 * machine-readable code even when its human-facing wording changes.
 */
export class TemplateInstantiationRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TemplateInstantiationRefusal";
  }
}

export const isTemplateInstantiationRefusal = (
  error: unknown,
): error is TemplateInstantiationRefusal => error instanceof TemplateInstantiationRefusal;
