# Product Contract: Review Role Convergence

Contract ID: ARC-2026-08-17

Version: 1.3

Status: Active

## Amendment 1.3 (2026-08-26)

The separate adjudication node is removed from both canonical templates. Its
authority moves into the fix step, which reads both immutable reports and
records a disposition for every finding id in its own `fixed-implementation`
output. Everything below about the two independent review authorities still
governs; the clauses that place adjudication in its own node, its own claim
guard, and its own `must-fix` output describe the graph that ran until this
amendment and still govern the chains created under it. The
`review-adjudicator-opus` role is archived with the node: it leaves the
canonical roster, and its Agent records are retained only as history for the
chains that ran under the previous graph. The roster clause in acceptance
criterion 1 reads fourteen LLM roles under this amendment.

## Objective

Keep plan review, independent implementation review, blind cross-vendor review,
and adjudication as distinct authorities, while keeping the two independent
implementation reviews concurrent and their join deterministic.

## In scope

- Keep `review-coordinator` as the Full Assurance plan reviewer.
- Run `review-coordinator-sol` and `review-coordinator-opus` as parallel,
  independent implementation-review siblings.
- Use `review-adjudicator-opus` as the fresh-session join authority after both
  review reports are durable and valid.
- Require the Sol role to cover Standards and Specification in one high session,
  with no nested review subprocess.
- Keep blind Opus unable to read predecessor or sibling review evidence for its
  entire task/provider session.
- Keep the evidence-driven security lens and its bounded evidence ladder for
  each implementation reviewer.

## Out of scope

- Rewriting or interrupting existing task assignments.
- Creating a separate security Agent or security skill.
- Changing an existing task's stored assignment, run, session, or output.
- Restoring provider-conversation continuation; adjudication is deliberately a
  fresh session.
- Publishing a repository, migrating production, or restarting services.
- Retrospectively rewriting historical batch review evidence.

## Acceptance criteria and required evidence

1. The canonical source roster contains sixteen LLM roles and one mechanical
   merge sentinel. Retired reviewer records remain only as archived history.
2. Full Assurance node 3 binds `review-coordinator`; node 6 binds
   `review-coordinator-sol`; node 7 binds `review-coordinator-opus`; and node 8
   binds `review-adjudicator-opus`.
3. Nodes 6 and 7 share one execution layer, are independently claimable from
   the same pinned implementation range, and node 8 cannot activate until both
   are `DONE`.
4. Sol emits one immutable `sol-findings` report from sequential Standards and
   Specification passes in one high session. Blind Opus emits one immutable
   `blind-findings` report without ever reading the Sol report.
5. The adjudicator begins a fresh Opus session, validates both immutable reports
   and their pinned base/head before reading either, and emits one immutable
   `must-fix` report with a disposition for every source finding id.
6. Security findings require an applicable trust boundary, reachable defect, or
   missing required control, with repository or runtime evidence. Ordinary
   review uses existing named regressions; a custom destructive reproduction
   requires an explicit Product Contract evidence requirement, isolated
   resources, a pre-reproduction findings checkpoint, and the smallest decisive
   case.
7. Existing instantiated chains keep their captured assignments and prompts,
   except that a not-yet-started task's stored prompt is refreshed across a
   prompt-only rollover under the operator procedure maintained outside this
   repository; new canonical templates use the split review/adjudication graph.

## Risks and stopping conditions

- Stop a join when either review sibling is not exactly `DONE`; do not use a
  partial, timeout, or degraded join.
- Refuse adjudication if either report is absent, mutable, from a non-`DONE`
  task, has the wrong kind, or does not match the implementation base/head.
- Stop if a source/template change would alter an already instantiated task.
- Archived roles and templates preserve task history; they are not candidates
  for new work.

## Dependencies

- The layered scheduler, immutable output guards, and canonical template sync
  must be available together.
- Existing chains remain a compatibility dependency: their legacy output,
  readiness, and mechanical-merge identities must continue to execute linearly.

## Routing snapshot

```text
Routing Contract: v1.2
Route: Full Assurance
Implementation Agent: implementation-plan-executioner
Reason: Parallel review fan-out and a deterministic cross-vendor adjudication join.
```
