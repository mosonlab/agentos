# Merge delivery paths

AgentOS supports two explicit delivery paths. A stopped autonomous tail never
silently changes from one path to the other.

## Autonomous tail

Regression records an exact-head `MERGE GATE: PASS`, merge readiness validates
the current pull-request head and any defense-list review obligations, and the
native merge executor performs the mechanical merge. An independent-review
rejection stops at an Inbox decision. The operator may create one repair task,
adopt the current exact head for a fresh Regression run, or park the tail for
operator takeover.

Adopting a head authorizes only a fresh Regression run. It is not merge
authorization: readiness and the native executor still have to validate their
own exact-head contracts.

## Operator direct merge

This is a bounded operational exception, not an automatic fallback and not a
new AgentOS workflow. The operator records the exact base and candidate head,
constructs the intended merge commit in an isolated worktree, runs
`scripts/merge-gate.sh --expect-head <merge-commit>` against that exact merge
commit, rechecks base/head drift, and pushes only when the gate passes. Any
drift or gate failure stops the operation.

Operator takeover merely parks the autonomous tail and preserves its evidence.
It never performs or authorizes a direct merge by itself.
