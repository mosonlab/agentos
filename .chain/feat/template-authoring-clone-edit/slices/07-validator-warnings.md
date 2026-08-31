---
id: 07-validator-warnings
title: Non-blocking warnings returned with a successful replace
blocked_by: [03-replace-step-graph]
risk: false
---

# 07: Non-blocking warnings returned with a successful replace

**What to build:** A successful structure replace returns, in `warnings`, every warning that applies to the resulting graph (never a delta): `no_review_step` (no step's output kind resolves to a review role: `sol-findings` or `blind-findings`), `same_agent_implements_and_reviews` (one Agent is assignee of both an implementation-role step, `implementation` or `fixed-implementation`, and a review-role step), `pull_request_without_regression` (some step sets `opensPullRequest` and no step resolves to the regression role, `regression-verification`). Roles come from the platform's existing output-kind to Step-role mapping, so versioned kinds resolve too and unknown kinds contribute nothing. Each warning is `{ code, message, stepIndex? }`; `pull_request_without_regression` carries the lowest pull-request-opening step, the other two are graph-level. Warnings never change the status and are never written anywhere. The three codes are added to the handbook's replace entry as warnings.

**Blocked by:** 03-replace-step-graph

- [ ] A graph with implementation and no review step returns `200` with `no_review_step` and no other spurious warning; adding a `sol-findings` step removes it; verified by a new validator-warnings dbtest at the HTTP seam using the shared fixture.
- [ ] A graph where the same Agent holds an `implementation` step and a `blind-findings` step returns `same_agent_implements_and_reviews`; assigning the review to a different Agent removes it; verified by the same dbtest.
- [ ] A graph with a pull-request-opening step and no `regression-verification` step returns `pull_request_without_regression` with that step's index; adding a regression step removes it; verified by the same dbtest.
- [ ] A graph that triggers all three returns all three in one response, and a following replace of an unchanged graph returns the same full list (not a delta); verified by the same dbtest.
- [ ] After a warned save, row counts show only template and step rows changed; a read of the template carries no warning field; verified by the same dbtest.
- [ ] The three warning codes appear in the handbook's replace entry, marked as non-blocking; verified by reading the section.
