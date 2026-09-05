Seed rollover could preserve historical template rows under names that `canonicalTemplateIdentity` could not recognize. The transition registry now owns and validates every seed-era name helper; merge-integrator no longer re-exports name helpers. Source-discovered unit coverage catches unregistered helpers, and canonical prompt sync database coverage exercises persisted legacy rows.

## Decisions taken

- Keep and register all four compound generations: `10` (seed preservation introduced in `9794f785`), `9` (`7fb6289c`), `human-12` (`17ee82ba`), and `regression-first-13` (retained by the seed installation consolidation in `15dc845f`). Current seed predicates still rename those historical graphs to preserve their rows and task bindings. None is a disposable, produced-only name.
- Also register direct `human-6`, minted inline since `17ee82ba`, and route seed through its registry helper. This satisfies the brief's requirement that every name minted in packages/db resolves.
- Register seed-era identities separately from structural transition fingerprints within the same registry module. These graphs predate the closed structural contract, and some output protocols are retired. Preserve seed's existing predicates; do not invent shape/adoption authority or change which graphs canonical sync may roll over.
- Keep `template-sources.ts`, `canonical-step-adoption.ts`, `agents/`, prompt content, and migrations untouched. No new runtime dependency enters template-sources.
- The primitive `legacyTemplateName` is private. Installation and regression fixtures use the registry-owned `templateRolloverName`; the exact acceptance grep now finds calls only in the registry.
- Preserve both fixed `v1` names because API fixtures consume them as row identities. Move their constants into the registry and resolve these exact unsuffixed identities, without relaxing the row-id requirement for other generations or granting structural adoption authority.
- Recognized seed-era and fixed v1 names now receive canonical run-open implementation guards and native implementation subagent settings by output role; compound implementation bindings require Codex gpt-* capability. Template authoring also reserves these names and refuses editing canonical rows. These are intended identity consequences, independent of sync rollover authority. Unit coverage checks seed-era family classification and non-implementation exclusions; existing run-open tests cover capability refusals.
- Production source AST coverage forbids inline legacy literals outside the registry; test fixtures remain free to express expected and invalid names. Export discovery explicitly rejects unsupported helper arities. Marker lists are computed once, direct names use the shared constant, and the compound constant is checked against the registry type.

## Validation

The new enumeration test failed on the starting implementation with the unregistered compound `10` name, then passed after the registry change. DB workspace tests, typecheck (including CLI), and lint are the Run proof boundary. API typecheck and lint check migrated registry-helper consumers. Repository-wide typecheck/lint and canonical prompt sync database tests are Regression/Merge Gate evidence, per the Run instructions; they are not executed independently here.

Review fixes adopt SPEC-LEGACY-001 and BLIND-01 through BLIND-08. Validation: all 490 DB unit tests pass; DB typecheck (including CLI), API typecheck, DB lint, API lint, and the exact registry-only call-site grep pass. The fixed-v1 regression checks the exported constants as well as their exact persisted spelling.

The retry began at runner salvage commit `ea414d78`, whose parent is the common reviewed head `38d04655`. The operator authorized completing and validating these salvaged fixes against that original review head, preserving append-only lineage.
