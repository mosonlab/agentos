# Canonical agent review package

Status: current as of 2026-08-17.

The canonical roster contains nine roles:

- `default`
- `spec`
- `plan`
- `plan-reviser`
- `frontend-dev`
- `implementation-plan-executioner`
- `senior-dev`
- `review-coordinator`
- `librarian`

## Review role decision

`review-coordinator` is the single canonical reviewer. The same Agent reviews
specifications, plans, and implementation diffs. It performs four independent
lenses—feasibility, scope, coherence, and security—then one risk-focused
verification pass. It writes one consolidated report using the
`review-report` skill and never modifies the artifact it reviews.

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

Role frontmatter and `packages/db/prisma/agent-contract.ts` jointly define the
canonical model and runner defaults. `packages/db/prisma/seed.ts` imports the
role sources and binds both plan review and code review to
`review-coordinator` in the Full Assurance template.

Existing task rows keep the assignee captured when their chain was created.
Roster convergence does not rewrite or interrupt an active chain.

## Acceptance

- Exactly nine role files pass the canonical source contract.
- Full Assurance steps 3 and 6 both bind `review-coordinator`.
- The review prompt requires repository evidence for every finding.
- The security lens derives applicable trust boundaries and negative tests;
  it does not emit generic checklist findings.
- Security verification prefers existing named regressions; custom destructive
  reproduction is contract-bound, isolated, minimal, and checkpointed first.
- Retired Agent records cannot be assigned to new tasks after archival.
