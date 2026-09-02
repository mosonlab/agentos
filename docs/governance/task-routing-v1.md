# Task Routing Contract v1

Version: 1.10 (2026-09-02: corrects the basis for serializing two migration-adding chains — the release-candidate pin moves when a migration's timestamp moves the recorded terminal, not on every migration — and realigns the recorded snapshot block with the current version)

Previous: 1.9 (2026-09-02: configurable approval gates add project defaults, per-dispatch overrides, and TODO-only slot toggles while preserving exact-head merge-tail authorization)

Previous: 1.8 (2026-09-02: dependency qualification names parallel dispatch as the default, narrows the true-dependency test to code and deploy order, and records that an `afterTaskId` binding is one-way)

Status: Active

## Applies to

This contract governs the design, creation, dispatch, and routing of Anneal tasks, task chains, and task templates. Every runnable task or chain requires one versioned Product Contract; a chain does not create a separate contract per step.

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

Choose Direct when one implementation context window can deliver a brief whose change points are enumerable; write the brief from `docs/BRIEF-TEMPLATE.md` before instantiating, because the chain's implementation `description` is the specification of record. Choose Full Assurance when the work exceeds one implementation window or decomposes into independently demonstrable slices; a surface too large for a brief to enumerate belongs here, not to an assignee escalation.

## Implementation assignee routing

Keep the template's default implementation assignee. Assign `senior-dev` (same rule for the review-fix step) only when the work touches persisted data or a defense-list path — merge gate, gate worker, migrations, merge automation — or when that classification is uncertain. Assign `frontend-dev` when the work is primarily a new or redesigned web page or UI surface (the operator 2026-08-27); the defense-list rule wins when both apply.

A backlog card that needs a non-default implementation assignee states it as the machine-readable line `Route: implementation=<agent-name>` in its description. Direct-template instantiation consumes that line, resolves the named Agent in the project, applies the existing override safety checks, and assigns it to the implementation step. Explicit `stepOverrides` remain a separate API mechanism; supplying both mechanisms for the direct implementation step is refused. Other templates do not interpret Route-looking prose.

## Critical classification

Critical means only that the work touches persisted data or performs an irreversible external action. No other condition makes a task Critical by itself.

Critical is a risk label, not a routing tier or a model route: it marks the slices and review attention a chain owes the work, while model and effort stay with the assigned roles. Here, `persisted data` means runtime-created user or system data, including its schema, that must survive a version change. Structural risk means a change to a public interface, persisted data, a component boundary, or a foundational dependency.

## Canonical execution graphs

The seeded templates under `agents/templates/` are the execution canon: step prompts, layer structure, blind-review isolation, and the mechanical merge tail live in those Markdown sources, and `agents/README.md` owns the structural rules that bind them. Model and runner defaults live in `agents/roles/` frontmatter and `packages/db/src/agent-contract.ts`.

Chains instantiated before a template change keep their stored prompts, assignments, and behavior; canonical sync preserves superseded templates under deterministic legacy identities instead of rewriting instantiated work. A rollover leaves each task's stored prompt unchanged.

## Human approval placement

`Task.approvalGate` is the sole runtime authority for an Agent step. A role persists its output and finishes; the control plane moves a gated task to REVIEW and an ungated task to DONE. An Agent may ask a blocking Product Contract question, but it does not create a second approval request merely because its artifact is a specification or plan.

Both configurable approval gates are off by default, so a newly created project
and its chains remain fully autonomous unless an operator enables a gate. The
two configurable slots are the specification step (`outputKind: spec`, the
specification step in the Full Assurance/compound chain) and the server-owned
merge readiness step (the step recognised by `isMergeReadinessStep`, step 11 in
the compound chain and step 7 in the direct chain). No other step is a gate
slot.

Each project has independent `specGateDefault` and `mergeGateDefault` boolean
defaults, both initially `false`. At dispatch, the optional `gates.spec` and
`gates.merge` values override the corresponding project default for that chain
only. For either slot, resolution is exactly: dispatch override, then project
default, then the template step's frontmatter `approvalGate`. Every other step
keeps its frontmatter value. An operator may toggle a slot task's
`approvalGate` after dispatch only while that task is still `TODO`; a non-slot
chain task or a slot already `DOING`, `REVIEW`, or `DONE` is refused. Existing
chains retain their stored gate values.

Place the fewest gates that preserve human judgment:

- Add a specification gate only when the spec step resolves product behavior, acceptance semantics, or a data-contract ambiguity left open by the approved Product Contract.
- Do not gate the plan step before independent review. In Full Assurance, put implementation authorization after reviewed-plan closure at the revise-plan step.
- Keep implementation, review, adjudication, repair, regression, and documentation automatic inside approved boundaries.
For a gated merge-readiness slot, completion of regression opens the existing
integrator-feeding gate with regression evidence and server-read evidence (the
pull-request head, base, and required-check conclusions) shown before approval.
Approval records an
exact-head operator authorization and releases the readiness task to its
ordinary server-owned readiness worker; it does not mark readiness `DONE` or
activate merge execution directly. The worker performs its ordinary
exact-head, base, ancestry, defense, and lease re-verification before the sole
integrator authorization is produced. If the head or base drifts after
approval, the tail stops without merging and regression/readiness reopen the
gate with a fresh evidence card for the changed state; the old authorization is
not reused. Rejecting the merge gate ends the chain terminal, never activates
the merge execution step, and leaves the pull request open and unmerged. A
specification-gate rejection keeps the existing requeue behavior and consumes
the task's normal `maxSessionsPerTask` budget.

Direct has no planning gates. Gate selection is recorded at dispatch; an active Agent does not rewrite it.

## Per-chain routing snapshot

Record this block when creating or materially rerouting a chain:

```text
Routing Contract: v1.10
Tier: Direct
Implementation Agent: <project-agent-name>
Critical: no
Reason: Bounded change; Direct review and exact-head acceptance remain intact.
```

If risk or ambiguity increases during execution, pause before the newly unsafe work and reroute. If rerouting changes a Product Contract boundary, return to the product owner for approval. New work uses the current routing contract; active work keeps its recorded snapshot until explicitly rerouted.

## Backlog card lifecycle

A backlog card is a dispatch-ready brief waiting for a decision, not a work item of its own. The board holds either the card or its chain, never both.

- Create the card with `assigneeType: HUMAN` so no runner claims it, with the brief as its description (written from `docs/BRIEF-TEMPLATE.md`) plus the machine-readable `Route:` line when the implementation assignee is non-default. The create API accepts an optional `status` of `BACKLOG` or `TODO` and defaults to `TODO`; pass `status: BACKLOG` to create a human Backlog card atomically without a follow-up PATCH.
- Dispatch instantiates a chain from the card: the brief becomes the instantiate `description` (the chain's implementation task is then the specification of record), and direct-template instantiation consumes and validates its `Route:` line. Chain-to-chain ordering passes `afterTaskId` (the predecessor chain's final task) to the instantiate endpoint; the bound chain dispatches when the predecessor completes. `afterTaskId` is incompatible with `autoStart`, and each predecessor task takes one successor.
- Dependency qualification precedes every instantiation: classify the new chain against every in-flight or co-dispatched chain and pick exactly one outcome. Parallel is the default; bind with `afterTaskId` only for a true dependency, and serialize by choice only for heavy overlap or a concurrent migration.
  1. True dependency — this chain's code reads code the other chain merges, or the other chain must be deployed before this one can be verified: bind with `afterTaskId` and record the basis (`Depends on: <chain> — <what is consumed or why deploy-first>`) in the instantiate description or the card's activity log. A brief that mentions the other chain, shares a document with it, or ships an adjacent feature on the same surface is independent. Binding is one-way: the bound chain's first step refuses a manual start until the predecessor is DONE, and only deleting the bound chain releases it (see the instantiate route in `docs/operator-api.md`).
  2. Heavy overlap — no dependency, but both chains rewrite the same code area: weigh expected refresh-conflict repair cost against serial wall-clock loss; either choice is valid, and a serial choice records its reason the same way.
  3. Independent — dispatch in parallel, no justification needed; the merge tail and the deploy quiet window already serialize delivery.
  Serialize an independent pair anyway when the merge would be clean but the semantics unsafe — changes to the same fail-closed enforcement path, behavior coupled across disjoint files (examples, not a closed list). Serialize unconditionally when both chains add a Prisma migration, whichever tables they touch: a migration merged after a release cut updates the `RELEASE_CANDIDATE_MIGRATIONS` pin in `packages/db/src/release-migrate.ts` whenever its timestamp moves the recorded terminal, so two concurrent migration-adding chains land on the same two lines (7 of the 19 refresh-conflict repairs between 2026-08-24 and 2026-08-31 were exactly those two lines).
- Archive the card at the moment of instantiation. The archived card remains recoverable in the Archived view; re-dispatching its work is a new decision, not a revival of the card.

## Board column semantics

The board shows where work sits in the intent-to-delivery flow. The
[Backlog card lifecycle](#backlog-card-lifecycle) defines card creation,
dispatch, and archival; the definitions here cover the column semantics.

- **Backlog — intent.** An un-instantiated brief that is still being refined,
  awaits a decision, or is deliberately parked; it is not connected to
  execution. For an indefinitely parked HUMAN card, prefix its title with
  `Parked:`.
- **Todo — runnable execution.** An instantiated chain or step whose
  specification of record is final, runnable now or waiting for activation or
  a dependency unlock. The entry boundary is explicit: un-instantiated intent
  enters the board in Backlog; instantiated chains and their steps enter in
  Todo and then move through the later columns.
- **Doing — active execution.** The runner has activated an AGENT task and work
  is in progress.
- **Review — awaiting a lifecycle decision.** An AGENT task is paused for an
  approval or review gate, or has surfaced a run issue that needs attention
  before the chain can continue.
- **Done — complete.** The task or chain step is finished.

An operator can stop and park a running chain step, which returns it to Backlog
as a parked step. Resume it with **Start now** or **Recover parked step**, not
ordinary card dispatch.

The operator owns Backlog and Todo transitions and marking HUMAN tasks Done.
The runner and chain scheduler own Doing, Review, and Done transitions for
AGENT tasks. In the usual flow, the operator moves finalized intent from
Backlog to Todo, then the runner advances each instantiated step through Doing,
Review, and Done.
