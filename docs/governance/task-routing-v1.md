# Task Routing Contract v1

Version: 1.0

Status: Active

## Applies to

This contract governs the design, creation, dispatch, and routing of AgentOS tasks, task chains, and task templates. It is repository-level governance. Every runnable task or task chain still requires its own versioned Product Contract; a chain uses one contract, not one contract per step.

## Authority boundaries

The Product Contract fixes the objective, scope, acceptance criteria, evidence, risk boundaries, stopping conditions, and dependencies. Within those boundaries, the dispatcher and execution chain may choose technical implementation details.

A change to the objective, in-scope or out-of-scope work, acceptance criteria, required evidence, authority, or risk boundary requires a new Product Contract version and product-owner approval. Implementation may stop and request or perform a safety escalation at any time. Any downshift of the selected route, reasoning effort, or safeguards requires a new Product Contract version and product-owner approval.

Agent model and reasoning-effort settings are defaults, not permanent locks. Select the implementation role when the task or chain is created, record that selection in the routing snapshot, and keep the selected defaults stable while it is active. A recorded temporary override may be lateral, provider-specific, or safer; it may not weaken the selected route, effort, or safeguards without the approval above.

## Minimum Product Contract

A runnable task or task chain must record:

- Contract ID and version.
- Objective.
- In-scope and out-of-scope work.
- Acceptance criteria and required evidence.
- Risks, authority boundaries, and stopping conditions.
- Dependencies and prerequisites.
- The routing snapshot defined below.

SPEC and Plan are optional. The Product Contract is not.

## Route selection

Choose the shortest route that safely satisfies the Product Contract:

| Route | Use when | Implementation role and default effort |
| --- | --- | --- |
| Direct Standard | Product behavior and implementation are clear, bounded, and low risk. | `default` for general work or `frontend-dev` for routine frontend-only work; medium |
| Direct Critical | The implementation is clear but the change is high risk. | `senior-dev`; high |
| Planned Standard | Product behavior is clear, but architecture, sequencing, or cross-module implementation needs a written Plan. | `implementation-plan-executioner`; medium |
| Planned Critical | A written Plan is needed and the change is high risk. | `senior-dev`; high |

Add a SPEC step only when intended product behavior, user outcomes, acceptance semantics, or a data contract remains ambiguous. Add a Plan when architecture, sequencing, cross-module coordination, rollback, migration, or recovery cannot be implemented safely from the Product Contract alone.

Treat a task as Critical when it materially affects database migration or restore, security, secrets, permissions, concurrency, idempotency, control-plane ownership, runner or workspace lifecycle, process termination, failed-run evidence, production or release gates, destructive operations, or durable data correctness. When classification is unclear, select the safer route.

All routes may append review, fixes, and human acceptance gates required by the Product Contract. `implementation-plan-executioner` may be used only when a persisted `plan` or `revised-plan` artifact already exists.

## Implementation agent selection

- Use `frontend-dev` for bounded, routine, frontend-only changes.
- Use `default` for other bounded Direct Standard work.
- Use `implementation-plan-executioner` for Planned Standard implementation with an existing Plan.
- Use `senior-dev` for every Critical implementation, with or without a Plan.
- Keep specification, planning, review, migration, reliability, and recovery judgment at high effort where those roles are present.

The route chooses the role; the role owns its canonical runner, model, and reasoning-effort defaults. Exact defaults live in the role frontmatter and `packages/db/prisma/agent-contract.ts`. Do not copy exact model identifiers into task templates or Product Contracts unless an explicit provider requirement makes the identifier part of the contract.

## Per-chain routing snapshot

Record this block when creating or materially rerouting a chain:

```text
Routing Contract: v1.0
Route: Direct Standard
Implementation Agent: frontend-dev
Reason: Bounded UI-only change with mechanical acceptance criteria.
```

If risk or ambiguity increases during execution, pause before the newly unsafe work and escalate the route. If escalation changes a Product Contract boundary, return to the product owner for approval. A new task must use the current routing contract; an already active task keeps its recorded snapshot until it is explicitly rerouted.

## Existing nine-step template

`compound-engineer-workflow` remains the preserved Full Assurance workflow for work that benefits from its complete specification, planning, implementation, review, and human-acceptance sequence. It is not the universal default, a dynamic router, or a substitute for Critical routing. A Critical implementation still uses `senior-dev` at high effort even when the surrounding Full Assurance structure is appropriate.

Version 1 uses deterministic dispatch-time routing. It does not require a runtime router or a replacement for the existing template.
