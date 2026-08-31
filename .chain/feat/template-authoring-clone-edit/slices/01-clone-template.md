---
id: 01-clone-template
title: Clone a task template under a new name
blocked_by: []
risk: true
requirements: [clone, authoring-refusal-envelope, clone-handbook]
verification:
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:db -w @anneal/api -- src/template-authoring-clone.dbtest.ts"
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && node --import tsx --test packages/api/src/refusal.test.ts"
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:operator-api-docs"
---

# 01: Clone a task template under a new name

**What to build:** An operator calls the project-scoped clone route with a name and optional description and receives `201` with an independent, non-canonical copy in the existing template-read projection. The copy carries the source description unless overridden, variables, and every step field including commit, spawn, runner, base-position and prompt data, with the same indexes; every webhook field is cleared; trigger fires and Tasks are not copied. Cloning a canonical or already-used source is allowed. The route refuses with `template_not_in_project` (404), `template_name_taken` (409), or `template_name_reserved` (409). The name is trimmed, non-empty and bounded like the existing template name input; the validator is not run. This vertical slice also introduces the distinct authoring-refusal type, its complete code union and optional `stepIndex`, widens the shared status union to `422`, and maps addressing, conflict and validator errors to the specified `404`, `409` and `422` envelopes. The handbook entry and its automated route assertion land here.

**Blocked by:** None (can start immediately)

**Verification:** The first command in frontmatter owns the HTTP criteria, the second owns exhaustive refusal rendering, and the third owns the handbook criterion.

- [ ] A clone of a multi-step template with a configured webhook returns `201`; read-back has identical description, variables and every step field, while every webhook field is empty and no trigger fire or Task was copied.
- [ ] An explicit description replaces the source description; cloning a canonical or used source succeeds, leaves source Tasks attached only to the source, and creates a name outside canonical identity.
- [ ] A source in another project answers `404 template_not_in_project`; a taken project name answers `409 template_name_taken`; one current canonical name and one registered-legacy name answer `409 template_name_reserved`; every refusal creates no template row.
- [ ] Surrounding name whitespace is trimmed; a blank or over-long name is a `400` schema refusal. The complete authoring refusal union maps to the specified envelope and status with `stepIndex` present only when supplied.
- [ ] The handbook test fails at the frozen base and passes only when the clone entry includes its required and optional fields, `201`, all three refusal codes with statuses, and a request example.

**Regression verification:** Existing instantiation refusals retain their current codes and `400` statuses; this is checked by the unchanged unit suites during chain-level verification, not counted as slice acceptance.
