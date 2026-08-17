# Product Contract: Review Role Convergence

Contract ID: ARC-2026-08-17

Version: 1.1

Status: Active

## Objective

Use one Review Coordinator for specification, plan, and implementation
reviews, with explicit feasibility, scope, coherence, security, and
risk-focused verification coverage.

## In scope

- Make `review-coordinator` the reviewer for Full Assurance plan-review and
  code-review steps.
- Add an evidence-driven security lens to the Review Coordinator prompt.
- Bound security verification with an evidence ladder so ordinary review uses
  existing named regressions and any custom destructive reproduction is
  explicitly authorized, isolated, minimal, and checkpointed first.
- Remove `feasibility` and `code-reviewer` from the canonical source roster.
- Retire their database records only after the existing CP-A chain reaches
  its human-review gate.
- Align canonical contracts and current operational documentation.

## Out of scope

- Rewriting or interrupting existing CP-A task assignments.
- Creating a separate security Agent or security skill.
- Changing provider, model, or reasoning-effort defaults.
- Publishing a repository, migrating production, or restarting services.
- Retrospectively rewriting historical batch review evidence.

## Acceptance criteria and required evidence

1. The canonical source roster contains nine roles and excludes
   `feasibility` and `code-reviewer`.
2. Full Assurance steps 3 and 6 both bind `review-coordinator`.
3. The Review Coordinator accepts a spec, plan, or implementation diff and
   performs four named lenses plus a distinct risk-focused pass.
4. Security findings require an applicable trust boundary, reachable defect,
   or missing required control, with repository or runtime evidence.
5. The reviewer does not improvise bypass, exploit, or destructive shell
   reproductions during ordinary review. A custom reproduction requires an
   explicit Product Contract evidence requirement, isolated resources, a
   pre-reproduction findings checkpoint, and the smallest decisive case.
6. Source build, tests, typecheck, and diff checks pass.
7. Live archival and database-template verification occur only after CP-A
   reaches human review and no queued or active task references either
   retiring Agent.

## Risks and stopping conditions

- Stop live convergence if either retiring Agent has a queued or active task.
- Stop if source validation still finds a template or canonical reference to
  a retiring role.
- Stop if changing the review route would alter an already active task.
- Archival is soft retirement; task history remains intact.

## Dependencies

- Source convergence can proceed against current `origin/master`.
- Live convergence depends on CP-A reaching its human-review gate.

## Routing snapshot

```text
Routing Contract: v1.0
Route: Direct Critical
Implementation Agent: senior-dev
Reason: This changes review governance and the canonical task-template route.
```
