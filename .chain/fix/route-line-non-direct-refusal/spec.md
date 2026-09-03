The loud-refusal guard for machine-readable route lines is scoped to a single template, so on every other template the line is silently ignored - exactly the failure its own doc comment says must not happen.

Evidence (packages/api/src/templates.ts, read 2026-09-02 on d2314b91):

- `findMalformedRouteLine` is only called inside `if (template.name === "direct-engineer-workflow")` at :256.
- At :264 `implementationRoute` is set to `null` for any template whose name is not `direct-engineer-workflow`.
- The doc comment above `findMalformedRouteLine` states the intent: "A near-miss must refuse loudly: silently ignoring it dispatches the implementation step on the template default agent while the brief author believes their route was applied."

So a brief carrying a well-formed route line, instantiated from `compound-engineer-workflow`, `pr-engineer-workflow`, or any cloned template, runs its implementation step on the template default agent with no refusal and no notice. The author sees a chain that looks correctly routed. Template authoring (clone-and-edit) makes cloned templates ordinary, which widens this.

Not yet established, and part of the work: whether honouring the route on non-direct templates is correct, or whether the right fix is to refuse instantiation when a route line is present on a template that does not support routing. The second is smaller and fail-loud; prefer it unless there is a caller that needs per-template routing.

Acceptance:
- A route line present on a template that does not consume it no longer instantiates silently.
- The chosen behaviour is covered by a test at the instantiate boundary for at least one non-direct template.
- Behaviour on `direct-engineer-workflow` is unchanged.

Ruled out already, do not re-litigate: em dash separators. An em dash line parses as a whole agent name, misses the malformed check, and then refuses at :312 with "Implementation route agent ... was not found". That path is loud and needs no change.

Route: implementation=senior-dev - single-file API change with a fail-loud decision and a boundary test; needs judgement on which of the two shapes to take.