---
id: 06-validator-warnings
title: Non-blocking warnings returned with a successful replace
blocked_by: [02-replace-step-graph]
risk: false
requirements: [no-review-warning, self-review-warning, no-regression-warning, warnings-ephemeral]
verification:
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:db -w @anneal/api -- src/template-authoring-validator-warnings.dbtest.ts"
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:operator-api-docs"
---

# 06: Non-blocking warnings returned with a successful replace

**What to build:** A successful replace returns every applicable warning, never a delta: `no_review_step`, `same_agent_implements_and_reviews`, and `pull_request_without_regression`. Role classification comes from the existing output-kind role mapping, including versioned kinds; unknown kinds contribute nothing. The pull-request warning names the lowest implicated step, while the other two are graph-level. Warnings never block, alter status, or persist. The three handbook warnings and their automated assertions land here.

**Blocked by:** 02-replace-step-graph

**Verification:** The first command in frontmatter owns the HTTP and persistence criteria; the second owns the handbook criterion.

- [ ] Implementation without a review step saves with `200` and `no_review_step`; adding a recognized review role removes only that warning.
- [ ] Assigning one Agent to implementation and review returns `same_agent_implements_and_reviews`; assigning different Agents removes it.
- [ ] A pull-request-opening step without regression returns `pull_request_without_regression` at the lowest opening step; adding regression removes it.
- [ ] A graph triggering all three returns all three on every unchanged resubmission. A warned save changes only template and step rows, and read-back carries no warning state.
- [ ] The new handbook assertions are red against the frozen handbook and pass only when all three codes are documented as non-blocking and ephemeral.
