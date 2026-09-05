Seed rollover could preserve historical template rows under names that `canonicalTemplateIdentity` could not recognize. The transition registry now owns and validates every seed-era name helper; merge-integrator retains re-exports for existing consumers. Source-discovered unit coverage catches unregistered helpers, and canonical prompt sync database coverage exercises persisted legacy rows.

## Decisions taken

- Keep and register all four compound generations: `10` (seed preservation introduced in `9794f785`), `9` (`7fb6289c`), `human-12` (`17ee82ba`), and `regression-first-13` (retained by the seed installation consolidation in `15dc845f`). Current seed predicates still rename those historical graphs to preserve their rows and task bindings. None is a disposable, produced-only name.
- Also register direct `human-6`, minted inline since `17ee82ba`, and route seed through its registry helper. This satisfies the brief's requirement that every name minted in packages/db resolves.
- Register seed-era identities separately from structural transition fingerprints within the same registry module. These graphs predate the closed structural contract, and some output protocols are retired. Preserve seed's existing predicates; do not invent shape/adoption authority or change which graphs canonical sync may roll over.
- Keep `template-sources.ts`, `canonical-step-adoption.ts`, `agents/`, prompt content, and migrations untouched. No new runtime dependency enters template-sources.
- The call-site criterion is applied to standalone minting: merge-integrator contains only re-exports. Existing installation and unit-test callers continue using the registry's exported `legacyTemplateName`; all production literal markers passed to it live in the registry.

## Validation

The new enumeration test failed on the starting implementation with the unregistered compound `10` name, then passed after the registry change. DB workspace tests, typecheck (including CLI), and lint are the Run proof boundary. API typecheck checks existing re-export consumers. Repository-wide typecheck/lint and canonical prompt sync database tests are Regression/Merge Gate evidence, per the Run instructions; they are not executed independently here.
