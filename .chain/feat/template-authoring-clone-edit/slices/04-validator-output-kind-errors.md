---
id: 04-validator-output-kind-errors
title: Validator errors for output kind production and duplication
blocked_by: [02-replace-step-graph]
risk: false
requirements: [prior-kind-produced, output-kind-unique, prior-kind-unique]
verification:
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:db -w @anneal/api -- src/template-authoring-validator-output-kinds.dbtest.ts"
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:operator-api-docs"
---

# 04: Validator errors for output kind production and duplication

**What to build:** A structure replace is refused with `422` when output-kind wiring violates `prior_kind_unproduced`, `output_kind_duplicate`, or `prior_kind_duplicate`. These checks occupy positions 6 through 8 in the fixed order. Unknown output kinds remain legal, while `stepIndex` names the consumer or later duplicate. The three handbook codes and their automated assertions land here.

**Blocked by:** 02-replace-step-graph

**Verification:** The first command in frontmatter owns the HTTP and atomicity criteria; the second owns the handbook criterion.

- [ ] A consumer whose kind has no producer, or only a same-layer producer, answers `422 prior_kind_unproduced` naming the consumer; a strictly earlier-layer producer succeeds.
- [ ] Two producers of the same kind answer `422 output_kind_duplicate` naming the later producer.
- [ ] A repeated prior kind within one step answers `422 prior_kind_duplicate` naming that step.
- [ ] A consistently wired free-form kind succeeds with `200`, while every refused request leaves the saved steps unchanged.
- [ ] The new handbook assertions are red against the frozen handbook and pass only when all three codes appear under replace with status `422`.
