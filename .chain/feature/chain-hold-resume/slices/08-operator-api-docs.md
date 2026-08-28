---
id: 08-operator-api-docs
title: Operator handbook entries for hold and resume
blocked_by: []
risk: false
artifacts:
  - docs/operator-api.md
verification:
  test_file: scripts/operator-api-docs.test.mjs
  command: npm run test:operator-api-docs
---

# 08: Operator handbook entries for hold and resume

**What to build:** An operator reading the handbook can drive both routes
without reading the server. The operator API handbook gains
`POST /tasks/:taskId/chain/hold` and `POST /tasks/:taskId/chain/resume` in the
Tasks section, in the handbook's existing per-route shape — path parameter,
required `requestId`, Hold's optional `reason`, the idempotent no-op and 404/409
refusal behaviour, and a `curl` example each — placed in route-registration
order next to the existing Chain read route, whose section gains a description
of the new `control` object including its `null`-when-never-held reading. The
route contracts are fully fixed by the spec of record, so this slice needs no
implementation slice to land first; it must not imply that `.chain/` artifacts
survive a merge, and must first confirm the handbook is not in the frozen-docs
set (if it is, that conflict goes back to the operator instead of being edited
around). The focused executable handbook contract test and its exact command are
named in the slice metadata; the pre-existing frozen-record and release-
documentation checks remain regression coverage, not acceptance evidence for
these routes.

**Blocked by:** None (can start immediately).

- [ ] Both new route sections exist with path parameter, JSON fields, refusals,
      idempotent no-op behavior, and a `curl` example in the handbook's existing
      shape; verified by the focused executable handbook test.
- [ ] The Chain read route's section describes the `control` object and its
      `null`-when-never-held case; verified by the same test.
- [ ] The focused handbook contract test fails against the frozen base when either
      route section, request field, refusal/idempotence text, curl example, or
      the GET control/null contract is absent, and passes via the metadata's
      exact command; the existing frozen-record and release-documentation checks
      also stay green as regression verification.
