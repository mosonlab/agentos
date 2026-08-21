Board tier-flow wiring: decouple template auto-start, add drag-to-Doing start confirmation, and surface a startability checklist.

All design decisions below are settled by Leo (2026-08-20); implement them as written, do not re-litigate.

## 1. Decouple instantiation from auto-start (packages/api)

instantiateTemplate (packages/api/src/templates.ts:170) currently calls enqueueTaskRun on the first step inside the instantiation transaction — creating a chain starts it immediately. Add an `autoStart` boolean to the instantiation input, DEFAULT FALSE. When false, all step tasks are created in TODO as today but nothing is enqueued; the chain is started later by starting its first step via POST /tasks/:id/start (which already handles chain steps). When true, preserve current behavior. Update existing callers/tests explicitly; do not silently rely on the default. The rule "first step must be agent-executable" still validates at instantiation time regardless of autoStart.

## 2. Drag-to-Doing start confirmation (apps/web)

Current drag handling (apps/web/src/pages/Tasks.tsx:172 move(), via desktop-board.tsx onDrop) PATCHes /tasks/:id {status} for every drag. Change ONLY the case "card dropped onto the DOING column AND the task is startable" (startable = the same preconditions POST /tasks/:id/start enforces at packages/api/src/app.ts:2776-2901: not archived, status TODO/BACKLOG, assigneeType AGENT, repo bound, assignee agent set with AgentRepoAccess grant, run budget left, no active run, chain predecessors done):
- Show a confirmation dialog (task name, agent, repo, target branch).
- Confirm → call POST /tasks/:id/start. Do NOT PATCH status: DOING is set by the runner claim (app.ts:3421); the board reflects it on reload/poll. Surface API errors to the user verbatim (fail loudly).
- Decline → no-op; the card stays where it was.
Rationale (Leo): one start is a real codex/claude session plus an unconditional runner push; a mis-drag must never trigger it. No implicit start on any drag.
Every other drag (any card to BACKLOG/TODO/REVIEW/DONE, non-startable cards to DOING, HUMAN cards anywhere) keeps today's plain PATCH behavior — explicitly out of scope to restrict them further.

## 3. Startability checklist in task Details (apps/web + packages/api)

In the task detail Details panel, render a per-precondition checklist (repo bound / AGENT assignee / repo access grant / budget remaining / no active run / predecessors done), each item shown as satisfied or missing. This is the visible definition of "Backlog = not configured, Todo = ready to start". Compute the verdicts server-side from the same predicates the /start route uses (extract/share, don't duplicate the logic in the web client); expose them on the task read path or a small dedicated endpoint — implementer's choice, but the dialog gating in item 2 must consume the same source of truth.

## Constraints

- Do not touch merge-integrator binding (packages/db/src/merge-integrator.ts) or template step contracts (packages/db/src/agent-contract.ts).
- No silent fallbacks; errors surface to the user (repo rule).
- Tests: extend unit + dbtest coverage for the autoStart flag and the startability predicate exposure. Baselines: unit db 192 / api 406; dbtest db 67/67, api 320/320 — all must stay green.
- Conventional Commits, English.
