# Canonical agent review package

Status: current as of 2026-08-22.

The canonical roster contains fourteen LLM roles and one mechanical sentinel:

- `default`
- `spec`
- `plan`
- `plan-reviser`
- `frontend-dev`
- `implementation-plan-executioner`
- `senior-dev`
- `senior-dev-luna`
- `review-coordinator`
- `review-coordinator-sol`
- `review-coordinator-opus`
- `regression-verifier`
- `librarian`
- `merge-resolver`
- `merge-integrator` (mechanical sentinel)

## Review role decision

`review-coordinator` reviews plans only. It checks vertical-slice
demonstrability, slice size, dependency edges, merge/split decisions, explicit
expand/migrate/contract sequencing, and whether every acceptance criterion is
red at the frozen base.

`review-coordinator-sol` performs the first implementation review over the
complete integrated diff from the frozen pre-implementation base. It persists
stable findings as its committed task output.

`regression-verifier` reads the closed must-fix package after repairs, performs
the bounded whole-fix semantic verification at Sol medium, and runs the one
exact-head mechanical gate only after that verification passes. Its verdict is
the head-bound evidence consumed by merge authorization.

`review-coordinator-opus` first persists an independent blind review, then reads
the first report and applies the canonical merge matrix to close the must-fix
list. Its role prompt retains post-fix regression instructions only for legacy
task rows instantiated before the canonical template moved that phase to the
dedicated verifier.

Security and risk-focused verification follow an evidence ladder: inspect the
implementation and existing tests, run the narrow named regressions, and report
missing required negative evidence as a must-fix. Ad hoc bypass, exploit, or
destructive reproductions are not ordinary review work. A custom reproduction
is allowed only when the versioned Product Contract explicitly requires that
class of evidence; the reviewer checkpoints current findings first, uses only
unique temporary roots and scratch databases, runs the smallest decisive case,
and stops without expanding into adjacent attack exploration.

The former `feasibility` and `code-reviewer` roles duplicated subsets of this
contract. They are removed from the source roster and from new templates.
Database records with task history are retained as archived history after
their final assigned chain reaches its human-review gate.

## Runtime authority

Role frontmatter and `packages/db/src/agent-contract.ts` jointly define the
canonical model and runner defaults. `packages/db/prisma/seed.ts` imports the
role sources and binds the review and regression phases to their distinct
canonical roles in the Full Assurance template.

Existing task rows keep the assignee captured when their chain was created.
Canonical sync migrates only unarchived TODO regression tasks with no Run,
Session, or step output; it never rewrites or interrupts an active or completed
chain.

## Acceptance

- Exactly fifteen role files pass the canonical source contract, including the
  mechanical merge sentinel.
- Full Assurance step 3 binds `review-coordinator`, step 6 binds
  `review-coordinator-sol`, step 7 binds `review-coordinator-opus`, and step 9
  binds `regression-verifier`.
- The first report is durable before the final reviewer reads it.
- The closed must-fix list follows the canonical merge matrix and the post-fix
  verdict accounts for every must-fix at one exact head.
- The review prompt requires repository evidence for every finding.
- The security lens derives applicable trust boundaries and negative tests;
  it does not emit generic checklist findings.
- Security verification prefers existing named regressions; custom destructive
  reproduction is contract-bound, isolated, minimal, and checkpointed first.
- Only implementation step 5 opens the pull request; all other steps reuse it.
- Retired Agent records cannot be assigned to new tasks after archival.
