---
id: 02-replace-step-graph
title: Atomic whole-graph replace with in-use and canonical guards
blocked_by: [01-clone-template]
risk: true
requirements: [replace-core, replace-guards, graph-empty, strict-replace-schema, template-lock, replace-handbook]
verification:
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:db -w @anneal/api -- src/template-authoring-replace.dbtest.ts"
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:operator-api-docs"
---

# 02: Atomic whole-graph replace with in-use and canonical guards

**What to build:** An operator calls the project-scoped step-replace route with an array containing every editable step field except `stepIndex`; `baseFromStepIndex` is the submitted array's 1-based position. Success returns `200` with the template read projection, dense server-assigned indexes and the complete warning array. Add, remove, reorder and per-field edit are one atomic operation. Both the top-level request and every nested Step reject unknown keys, so a caller-supplied `stepIndex` or any other undeclared field fails loudly instead of being stripped. The old step rows are deleted and the new rows created in one Serializable transaction that first takes the template-row mutex. The same locked transaction checks project ownership, canonical identity and any Task reference before validation and mutation. The pure validator frame owns the fixed order and `graph_empty`; later slices add the remaining checks at their assigned positions. The lock documentation records the real participating lock classes: replace takes template then step-row locks, while instantiation takes the template mutex before its existing Task, Agent and grant locks and before Task inserts acquire template-step foreign-key reference locks. The implementation audits existing template writers for reverse acquisition before claiming the order is cycle-free. The route handbook entry and its automated assertion land here.

**Blocked by:** 01-clone-template

**Verification:** The first command in frontmatter owns every HTTP and persistence criterion; the second owns the handbook criterion.

- [ ] A request that adds, removes and reorders steps returns `200` with dense indexes in submitted order; read-back is exactly the submitted graph.
- [ ] Every editable field round-trips, including a null spawn policy. In the reordered request the caller explicitly supplies `baseFromStepIndex` equal to the base step's new 1-based array position, and the server persists that submitted position unchanged alongside dense indexes.
- [ ] A caller-supplied `stepIndex`, an unknown top-level field and an unknown nested Step field each answer `400`; the prior graph remains byte-identical in every case. Bounds violations are likewise schema refusals.
- [ ] Another project's template answers `404 template_not_in_project`; current and registered-legacy canonical names answer `409 template_canonical`; after instantiation both structural and prompt-only replaces answer `409 template_in_use` with clone-again recovery text. Every refusal leaves the graph unchanged.
- [ ] An empty graph answers `422 graph_empty`; a successful replace changes only template and step rows, with no warning, activity or Task persistence.
- [ ] The handbook test fails at the frozen base and passes only when the replace entry covers the request, response, addressing/state codes, `graph_empty`, warning semantics and a request example, and the obsolete no-authoring statement is removed.
