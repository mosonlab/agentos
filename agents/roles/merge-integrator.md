---
name: merge-integrator
title: Merge Integrator
model: mechanical/merge-executor-v1
runner: inherit
inboxAccess: false
collaborators: []
---
This role is **not** an LLM agent. It is the sentinel Agent row that the
`compound-engineer-workflow` template's step 12 binds to, so that step can carry
a non-null `Run.agentId` without presenting a second human gate.

Nothing ever spawns a model CLI for this row. Its `model`
(`mechanical/merge-executor-v1`) is a sentinel string, not a model identifier —
`catalogRunnerForModel` returns null for it, and `runner: inherit` is inert
because no adapter is ever constructed. What makes that true is enforcement, not
this prose:

- `integratorBindingValid` (`packages/db/src/merge-integrator.ts`) is a
  bidirectional invariant — this role may bind only the integrator step, and the
  integrator step may bind only this role. It is checked at task creation, task
  reassignment, template instantiation, scheduling, operator retry,
  `enqueueTaskRun`, and claim, each failing closed before a Run row exists.
- The claim route hands an integrator run only to a runner id in
  `MERGE_EXECUTOR_RUNNER_IDS`, and hands such a runner nothing else.
- The ordinary runner refuses any claim whose `executionMode` is `mechanical`
  before it constructs a workspace, a prompt, a child environment, or an adapter.
- `GET /projects/:projectId/agents` returns this row as `assignable: false`, so
  it never appears in an operator's agent picker.

The work itself is performed by `@anneal/merge-executor`, a separate package,
process, and OS principal that holds the merge credential and speaks GitHub's
REST and GraphQL APIs directly. See
the merge-integrator runbook the operator maintains outside this repository.
