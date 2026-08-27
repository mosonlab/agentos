# Merge delivery paths

AgentOS supports two explicit delivery paths. A stopped autonomous tail never
silently changes from one path to the other.

## Autonomous tail

Regression records an exact-head `MERGE GATE: PASS`, merge readiness validates
the current pull-request head, and the native merge executor performs the
mechanical merge. A diff that touches the defense list no longer blocks the
merge: readiness writes one audit Inbox message on the readiness task
("Merge proceeded with defense-list changes") naming the triggered paths and
reasons, and the merge proceeds unblocked.

## Operator direct merge

This is a bounded operational exception, not an automatic fallback and not a
new AgentOS workflow. The operator records the exact base and candidate head,
constructs the intended merge commit in an isolated worktree, runs
`scripts/merge-gate.sh --expect-head <merge-commit>` against that exact merge
commit, rechecks base/head drift, and pushes only when the gate passes. Any
drift or gate failure stops the operation.

Operator takeover merely parks the autonomous tail and preserves its evidence.
It never performs or authorizes a direct merge by itself.
