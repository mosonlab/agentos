# Task Routing Contract v1

Version: 1.4 (2026-08-27: the tier list names only the two chain tiers, matching the rule that in-session work sits outside them; wording is English throughout)

Status: Active

## Applies to

This contract governs the design, creation, dispatch, and routing of AgentOS tasks, task chains, and task templates. Every runnable task or chain requires one versioned Product Contract; a chain does not create a separate contract per step.

This contract records dispatch-time governance only. Execution structure, step prompts, and model or runner defaults live in their canonical sources named below and are not copied here.

## Authority boundaries

The Product Contract fixes the objective, scope, acceptance criteria, evidence, risk boundaries, stopping conditions, and dependencies. Within those boundaries, the dispatcher and execution chain may choose implementation details.

The human user holds dispatch authority. Work stays in the current session unless the user explicitly requests a task chain. Complexity, risk, or an available template may support recommending a chain, but none authorizes creating or dispatching one.

Changing the objective, scope, acceptance criteria, required evidence, authority, or risk boundary requires a new Product Contract version and product-owner approval. Any downshift of the selected route, effort, or safeguards requires the same approval.

Model and effort routing follows the operator's current routing policy. Select the implementation role and record the routing snapshot at dispatch. Rerouting uses a new process and a new snapshot; an active Agent does not change model or effort in-session. Model and effort belong in agent configuration, not task prompts.

## Minimum Product Contract

A runnable task or chain records:

- Contract ID and version.
- Objective.
- In-scope and out-of-scope work.
- Acceptance criteria and required evidence.
- Risks, authority boundaries, and stopping conditions.
- Dependencies and prerequisites.
- The routing snapshot defined below.

SPEC and Plan are optional. The Product Contract is not.

## Task tiers

Work done directly in the current session is outside these tiers and does not require a Product Contract. The tiers apply only after the human user explicitly requests a task chain.

Choose the shortest tier that satisfies the Product Contract. This contract defines two chain tiers:

- Direct: no specification or plan; implementation proceeds straight from the task brief and is delivered through parallel reviews, a self-adjudicating fix step, regression, and the mechanical merge tail.
- Full Assurance: the full chain; its specification and plan stages own decomposition.

Direct is a formal chain route, not an exemption from review or exact-head mechanical authorization. Full Assurance is required when the Product Contract calls for specification, planning, plan review, or revised-plan implementation authorization.

Template choice and dispatch-time implementation-assignee escalation follow the "Work directly" section of `AGENTS.md`.

## Critical classification

Critical means only that the work touches persisted data or performs an irreversible external action. No other condition makes a task Critical by itself.

Critical is a risk label, not a routing tier or a model route: it marks the slices and review attention a chain owes the work, while model and effort stay with the assigned roles. Here, `persisted data` means runtime-created user or system data, including its schema, that must survive a version change. Structural risk means a change to a public interface, persisted data, a component boundary, or a foundational dependency.

## Canonical execution graphs

The seeded templates under `agents/templates/` are the execution canon: step prompts, layer structure, blind-review isolation, and the mechanical merge tail live in those Markdown sources, and `agents/README.md` owns the structural rules that bind them. Model and runner defaults live in `agents/roles/` frontmatter and `packages/db/src/agent-contract.ts`.

Chains instantiated before a template change keep their stored prompts, assignments, and behavior; canonical sync preserves superseded templates under deterministic legacy identities instead of rewriting instantiated work. One exception, added with prompt-only rollovers (2026-08-26): a task that has not started — no Run at all — has its stored prompt recomposed from the current canonical step, since a prompt-only rollover is the declaration that the old text stopped being true. Anything that has run keeps what it was dispatched under.

## Human approval placement

`Task.approvalGate` is the sole runtime authority for an Agent step. A role persists its output and finishes; the control plane moves a gated task to REVIEW and an ungated task to DONE. An Agent may ask a blocking Product Contract question, but it does not create a second approval request merely because its artifact is a specification or plan.

Place the fewest gates that preserve human judgment:

- Add a specification gate only when the spec step resolves product behavior, acceptance semantics, or a data-contract ambiguity left open by the approved Product Contract.
- Do not gate the plan step before independent review. In Full Assurance, put implementation authorization after reviewed-plan closure at the revise-plan step.
- Keep implementation, review, adjudication, repair, regression, and documentation automatic inside approved boundaries.
- No human gate guards the merge tail: server-owned readiness and the mechanical integrator enforce exact-head authorization, and head, base, required-check, or material-evidence drift stops them without a human decision.

Direct has no planning gates. Gate selection is recorded at dispatch; an active Agent does not rewrite it.

## Per-chain routing snapshot

Record this block when creating or materially rerouting a chain:

```text
Routing Contract: v1.4
Tier: Direct
Implementation Agent: senior-dev-luna
Critical: no
Reason: Bounded change; Direct review and exact-head acceptance remain intact.
```

If risk or ambiguity increases during execution, pause before the newly unsafe work and reroute. If rerouting changes a Product Contract boundary, return to the product owner for approval. New work uses the current routing contract; active work keeps its recorded snapshot until explicitly rerouted.
