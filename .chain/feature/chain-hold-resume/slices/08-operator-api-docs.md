---
id: 08-operator-api-docs
title: Operator handbook entries for hold and resume
blocked_by: []
risk: false
---

# 08: Operator handbook entries for hold and resume

**What to build:** An operator reading the handbook can drive both routes
without reading the server. `docs/operator-api.md` gains
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
around).

**Blocked by:** None (can start immediately).

- [ ] Both new route sections exist with path parameter, JSON fields, refusals,
      and a `curl` example in the handbook's existing shape; verified by
      reading the rendered section against the spec's route contract.
- [ ] The Chain read route's section describes the `control` object and its
      `null` case; verified the same way.
- [ ] The repository's documentation checks (frozen-docs and release-docs test
      scripts) stay green.
