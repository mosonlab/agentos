# Canonical agent review package

Status: current as of 2026-08-26.

The adjudication node was removed from both canonical templates on 2026-08-26
and the `review-adjudicator-opus` role was archived with it: the fix step reads
both immutable reports and records a disposition for every finding id in its
own output. Chains created before that date still carry the node on their
renamed template rows, and the Agent rows those chains reference are retained
as history.

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
complete integrated diff from the frozen pre-implementation base. One Sol
high session makes two explicit passes over that same range: Standards and
Specification. It emits one immutable `sol-findings` output. It does not
launch nested review subprocesses, adjudicate the independent report, or fix
implementation code.

`review-coordinator-opus` performs only the independent blind review. It starts
without predecessor or sibling review evidence and remains unable to read
those reports through attachments, task outputs, chain activity, or any other
session-scoped route for the entire task and provider session. It emits one
immutable `blind-findings` output.

The fix step is the join successor of that parallel layer. It reads both
immutable sibling reports directly, and its output contract refuses any
`fixed-implementation` output whose dispositions do not exactly cover the
union of finding ids from the two reports, or whose reports are not bound to
the head the fix was made from. That check is the one the adjudication node
used to perform; it now runs in the platform rather than in a role.

`regression-verifier` reads the closed must-fix package after repairs, performs
the bounded whole-fix semantic verification at Sol medium, and runs the one
exact-head mechanical gate only after that verification passes. Its verdict is
the head-bound evidence consumed by merge authorization.

Security and risk-focused verification follow an evidence ladder: inspect the
implementation and existing tests, run the narrow named regressions, and
report missing required negative evidence as a must-fix. Ad hoc bypass,
exploit, or destructive reproductions are not ordinary review work. A custom
reproduction is allowed only when the versioned Product Contract explicitly
requires that class of evidence; the reviewer checkpoints current findings
first, uses only unique temporary roots and scratch databases, runs the
smallest decisive case, and stops without expanding into adjacent attack
exploration.

The former `feasibility` and `code-reviewer` roles duplicated subsets of this
contract. They are removed from the source roster and from new templates.
Database records with task history are retained as archived history after
their final assigned chain reaches its human-review gate.

## Runtime authority

Role frontmatter and `packages/db/src/agent-contract.ts` jointly define the
canonical model and runner defaults. `packages/db/prisma/seed.ts` imports the
role sources and binds the review and regression phases to their distinct
canonical roles in the Full Assurance template. An operator's model or runner
selection is an explicit runtime override and survives seed and canonical sync.

The Sol and blind Opus review tasks occupy one parallel execution layer and
are independently claimable after implementation. The fix step is the single
join successor, so it cannot start after only one report. Existing task rows
keep the assignee captured when their chain was created; the split does not
rewrite archived prompts, active runs, sessions, or stored outputs.

## Acceptance

- Exactly fifteen role files pass the canonical source contract, including
  the mechanical merge sentinel.
- Sol reviews both Standards and Specification axes in one high session and
  emit one `sol-findings` output; no review role launches a nested review
  subprocess or carries a service-tier override.
- The blind Opus report is durable before the fix step can read it, and
  blind-session scope remains unable to read the Sol sibling before or after
  persistence.
- The fix step runs only after both review tasks are `DONE`, and its output is
  refused unless both reports are bound to the head it fixed and every finding
  id from either report carries exactly one disposition.
- The post-fix verdict accounts for every must-fix at one exact head.
- The review prompt requires repository evidence for every finding.
- The security lens derives applicable trust boundaries and negative tests;
  it does not emit generic checklist findings.
- Security verification prefers existing named regressions; custom
  destructive reproduction is contract-bound, isolated, minimal, and
  checkpointed first.
- Only the implementation step opens the pull request; all other steps reuse
  it.
- Retired Agent records cannot be assigned to new tasks after archival.
