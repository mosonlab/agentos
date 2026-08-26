# Canonical agent review package

Status: current as of 2026-08-26.

The adjudication node was removed from both canonical templates on 2026-08-26.
The `review-adjudicator-opus` sections below describe the node as it ran until
then and as it still runs for chains created under it; no canonical template
step binds that role now. The fix step reads both immutable reports and records
a disposition for every finding id in its own output.

The canonical roster contains fifteen LLM roles and one mechanical sentinel:

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
- `review-adjudicator-opus`
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

`review-adjudicator-opus` is a separate cross-vendor authority after the two
review nodes in the parallel layer are both `DONE`. It always starts a fresh
Opus provider Session; it never resumes the blind conversation and needs no
provider conversation id or continuation proof. Its claim guard verifies both
immutable sibling reports, their `DONE` task status, their output kinds, and
the same pinned implementation base/head before it reads either report. It
applies the canonical merge matrix and emits the final immutable `must-fix`
output with a disposition for every finding id from both reports.

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
are independently claimable after implementation. The adjudicator is the
single join successor, so it cannot start after only one report. Existing task
rows keep the assignee captured when their chain was created; the split does
not rewrite archived prompts, active runs, sessions, or stored outputs.

Canonical sync may create the adjudicator Agent from this source for an
existing installation while preserving the active blind review Agent's
environment, repository grants, and disabled-tool boundary. It never changes
an active or completed chain.

## Acceptance

- Exactly seventeen role files pass the canonical source contract, including
  the mechanical merge sentinel.
- Sol reviews both Standards and Specification axes in one high session and
  emit one `sol-findings` output; no review role launches a nested review
  subprocess or carries a service-tier override.
- The blind Opus report is durable before the adjudicator can read it, and
  blind-session scope remains unable to read the Sol sibling before or after
  persistence.
- The adjudicator runs in a fresh Opus Session only after both review tasks
  are `DONE`, verifies the pinned base/head and both immutable reports, and
  produces a closed must-fix disposition for every finding id.
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
