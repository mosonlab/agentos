# Chain Phase 2: Parallel Review Layer and Join

## 1. Problem and outcome

AgentOS chains are currently linear. The Sol review and the independent Opus
review run one after the other even though neither consumes the other's output.
This costs the operator wall-clock time on every chain, and it makes the
combined Opus review/adjudication step carry two different authorities.

This is for the operator who runs canonical Direct and Full Assurance chains
with several runner daemons online, and for whoever audits a merge: the split
keeps blind review and adjudication as separate, separately evidenced
authorities.

Implement the smallest extension that solves this specific problem: an ordered
chain may contain multiple tasks in one explicit layer. Every task in the
current layer must be `DONE` before the next layer is activated. Canonical
Direct and Full Assurance chains use one two-node review layer followed by one
fresh Opus adjudication task.

This is not a general DAG engine. There are no persisted edges, join records,
layer-status records, continuation records, dynamic fan-out rules, or public
APIs for constructing parallel layers.

## 2. Canonical graphs

`chainIndex` remains the unique node ordinal. `chainLayer` controls execution.

### 2.1 Direct workflow

```text
layer 1: implementation (node 1)
              |
layer 2: sol review (node 2) || opus blind review (node 3)
              |                         |
              +-----------+-------------+
                          |
layer 3: opus adjudication (node 4)
                          |
layer 4: apply review fixes (node 5)
                          |
layer 5: regression verification (node 6)
                          |
layer 6: merge readiness (node 7)
                          |
layer 7: merge execution (node 8)
```

### 2.2 Full Assurance workflow

```text
layers 1-5: spec -> plan -> plan review -> revise plan -> implementation
                                                               |
layer 6: sol review (node 6) || opus blind review (node 7)
              |                         |
              +-----------+-------------+
                          |
layer 7: opus adjudication (node 8)
                          |
layers 8-12: fixes -> regression -> librarian -> readiness -> merge
```

Every other canonical layer contains one node.

## 3. Minimal persisted model

### 3.1 Schema

Add only these fields:

- `TaskTemplateStep.layer Int`
- `Task.chainLayer Int?`

Keep `Task.chainIndex` and `@@unique([chainId, chainIndex])`. It remains the
stable node identity used by ordering, pinned-base references, activity reads,
and merge execution.

Add a database `CHECK` requiring `chainId`, `chainIndex`, and `chainLayer` to be
either all `NULL` or all non-`NULL`. A malformed partial chain row is rejected;
it is never treated as a standalone task.

Remove `Task.followUpTaskId`, its relation, its unique index, and every runtime
fallback that follows it. There is one successor authority: the layer
scheduler.

Do not add `Chain`, `Layer`, edge, join, `LayerStatus`, `workspaceMode`, or
conversation-continuation tables.

### 3.2 Data migration

The migration is exact and fail-loud:

1. Refuse a partial chain identity and refuse a `followUpTaskId` relationship
   whose source and target are not already members of the same project and
   chain in increasing `chainIndex` order.
2. For every existing template, assign one step per layer using a dense rank of
   `stepIndex`, then make `TaskTemplateStep.layer` non-null.
3. For every existing chain, assign one node per layer using a dense rank of
   `chainIndex` within `(projectId, chainId)`. Existing chains therefore retain
   their current sequential behavior.
4. Add and validate the all-or-none `CHECK`.
5. Drop `followUpTaskId` and its relation/index.

The live pre-migration census contains no partial chain identities and no
standalone follow-up list, so this migration preserves current rows without a
compatibility path. Re-running the migration is handled by the normal migration
ledger, not by a new versioning framework.

### 3.3 Canonical template replacement

Do not mutate template-step rows referenced by instantiated tasks.

Canonical sync recognizes only the exact old shapes:

- `direct-engineer-workflow`: 7 steps
- `compound-engineer-workflow`: 12 steps

It renames those persisted templates to deterministic legacy identities
`direct-engineer-workflow-legacy-v1` and
`compound-engineer-workflow-legacy-v1`, preserving their `TaskTemplateStep`
rows and every instantiated task reference. It then creates the new 8-step and
13-step templates under the canonical names.

Any different persisted shape is structural drift and sync refuses it. Do not
build generic template versioning or clone arbitrary templates.

Canonical source validation requires layers to be non-decreasing in
`stepIndex` order and requires every `baseFromStepIndex` to name a strictly
lower layer. Only the two exact canonical graphs in section 2 may contain a
multi-node layer. Noncanonical templates remain linear.

On an existing installation, sync may create exactly one new Agent,
`review-adjudicator-opus`, from its canonical role source while copying the
active `review-coordinator-opus` Agent's environment, repository grants, and
disabled-tool boundary. A missing or archived source, or an archived target,
is a named refusal. This is a source-declared one-time transition, not a generic
role-cloning facility.

## 4. Runtime invariants

### 4.1 Lock order

Every transaction that may mutate a chained Task follows one order:

1. If the mutation belongs to a Run, lock that Run first.
2. Lock every existing Task row for `(projectId, chainId)` in
   `(chainLayer, chainIndex, id)` order.
3. Re-read the chain state and mutate Tasks or enqueue Runs.

No code path may lock one chain Task and later expand to sibling Tasks. Remove
the prefix-lock algorithm, successor `updatedAt` compare-and-swap, recursive
re-read, and individual `followUpTaskId` locking from activation. Database and
programming errors roll back the entire transaction.

This full-chain mutex is intentionally coarse. Chains are small, completion is
infrequent, and a single lock protocol is easier to prove than multiple partial
protocols.

### 4.2 Layer activation

After a task becomes `DONE`, the scheduler works from the fresh locked rows:

1. If any task in its `chainLayer` is not exactly `DONE`, stop.
2. Find the smallest higher `chainLayer`. If none exists, the chain is complete.
3. For every task in that next layer, enqueue at most one Run when it has no
   active Run and is otherwise eligible.

The first review completion cannot activate adjudication. The second review
completion activates it exactly once. Existing `(taskId, runNumber)` and
active-run database constraints remain the final duplicate backstop.

All statuses other than `DONE`, including `TODO`, active execution, `REVIEW`,
failure, and a parked or archived state, block the join. There is no partial,
timeout, or degraded join.

If one next-layer task has an expected eligibility problem, such as an archived
Agent, record that task's existing stopped/parked status and reason while still
enqueuing eligible siblings. The layer remains blocked until the invalid task
is repaired and completed. Unexpected database or program failures roll back
the whole transaction.

### 4.3 Start, retry, and approval gates

- Manual start and retry use the same locked layer-eligibility check; they do
  not bypass the join.
- A canonical multi-node layer cannot contain an approval gate.
- A server-owned or other non-Agent gate may follow only a single executable
  node in the preceding layer.
- Rejecting an ordinary Agent approval gate requeues that same gated task. It
  does not select an arbitrary sibling or previous layer.

The existing specification revision loop remains normative and must not
regress:

```text
Spec Run publishes canonical output -> human reviews/discusses it
  -> approve: mark Spec DONE and activate Plan
  -> reject: fresh Spec Run receives the previous output
       -> if no rejection feedback exists, it asks the human through Inbox
       -> revised Run publishes a new canonical output
       -> human approves that new output -> activate Plan
```

Changing a branch file alone never changes the approved artifact. Approval is
always bound to the current persisted `task_output` from the current successful
Run. This feature does not add a rejection-feedback field or a new revision
node; the existing fresh-Run plus Inbox question path already supports an
external model discussion without another lifecycle.

### 4.4 Workspace and publication

Every node in a multi-node canonical layer must:

- have the same non-`NULL` `baseFromStepIndex`;
- set `opensPullRequest: false`;
- execute in the existing detached checkout pinned to the same immutable
  implementation base/head; and
- write no branch files and publish no branch.

Template validation rejects a multi-node layer that violates any of these
rules. Parallel branch writers are not supported.

## 5. Review authority

### 5.1 Independent reports

The Sol review and Opus blind review start as separate fresh Sessions after the
implementation layer completes. Neither consumes the other's output.

- `review-coordinator-sol` keeps its existing two-axis review and emits one
  immutable `sol-findings` output.
- `review-coordinator-opus` is narrowed to blind independent review only. It
  emits one immutable `blind-findings` output and never unlocks predecessor or
  sibling evidence.
- Both outputs are bound to the same pinned `implementationBaseSha` and
  `implementationHeadSha`.

The blind task cannot read the Sol sibling through attachments, task-output
responses, chain activity, or other session-scoped read routes. Review prompts
must not launch nested `codex exec` or other review subprocesses.

### 5.2 Fresh adjudication

`review-adjudicator-opus` is a separate adjudication-only role and always runs
in a fresh provider Session. It does not resume the blind review conversation
and requires no provider conversation id or continuation proof.

Its claim is refused unless both immutable sibling outputs exist, were produced
by `DONE` tasks, and match its pinned implementation base/head. It reads both
reports, applies the existing canonical merge matrix, and emits the final
`must-fix` output with dispositions covering every finding id from both reports.
Only this output is review authority for the apply-fixes step.

Apply-review-fixes and regression verification remain fresh, separate Sessions.
Their existing output contracts and exact-head authority remain unchanged.

## 6. Minimal interfaces

### 6.1 Template sources

Add required `layer` frontmatter to canonical template steps and include it in
the existing structural-field validation and drift comparison.

The Direct template becomes 8 nodes with layers
`1,2,2,3,4,5,6,7`. The Full Assurance template becomes 13 nodes with layers
`1,2,3,4,5,6,6,7,8,9,10,11,12`. Delete the old combined Opus
review-and-adjudication step sources when their split replacements land.

### 6.2 HTTP and UI

- Public task creation continues to accept only `chainId + chainIndex` as a
  pair. It exposes no parallel-layer or dependency input. The server assigns
  `chainLayer = chainIndex` for these linear API-created chains.
- Public template-step creation exposes no layer input and assigns
  `layer = stepIndex`, so custom templates remain linear.
- Template instantiation copies `TaskTemplateStep.layer` into
  `Task.chainLayer`.
- Chain reads add only `layer` to each task/node representation. They do not add
  sibling ids, dependency arrays, or edges.
- Board chain progress adds derived `currentLayer` and `layerCount`; existing
  node counts remain.
- The chain UI groups rows with equal `layer`. It derives sibling display and
  outstanding blockers from the returned rows. No separately persisted or
  returned sibling list exists.

Sparse, zero-based, and one-based stored layer values are valid ordering keys.
The UI presents a dense one-based layer ordinal derived from sorted distinct
values, so legacy and API-created chains render consistently.

## 7. Failure behavior

| Condition | Required behavior |
| --- | --- |
| First review completes | Persist its output; do not enqueue adjudication. |
| Both reviews complete concurrently | Serialize on the chain mutex; enqueue exactly one adjudication Run. |
| One review Run fails | Use the existing retry lifecycle; the other report remains valid and the join stays blocked. |
| Failed review later succeeds | Re-evaluate the same join and enqueue adjudication once. |
| One sibling is parked or has an archived Agent | Record the existing named reason; do not degrade the join. |
| One next-layer sibling is invalid while another is eligible | Enqueue the eligible sibling; keep the layer blocked by the invalid task. |
| Review output is missing or bound to another head | Refuse completion or adjudication claim by name. |
| Canonical template has an invalid parallel layer | Refuse source loading/sync; do not linearize it silently. |
| Legacy follow-up relationship is inconsistent | Abort migration before dropping the column. |

Do not add a new retry state. A failed review receives the existing fresh-Run
retry. Reopening a `DONE` review, replacing an accepted review output, or
handling failure after a final output is persisted is out of scope.

## 8. Acceptance criteria

Evidence is produced against a scratch database/API environment and the exact
candidate head.

1. Schema and migration tests prove the all-or-none chain identity,
   one-layer-per-node legacy backfill, safe `followUpTaskId` removal,
   deterministic template
   replacement, preserved instantiated-step references, and idempotent
   canonical sync.
2. Template tests instantiate Direct as 8 nodes/layers
   `1,2,2,3,4,5,6,7` and Full Assurance as 13 nodes/layers
   `1,2,3,4,5,6,6,7,8,9,10,11,12`.
3. An API integration test completes implementation and proves that both review
   Runs become claimable. Two distinct runner identities claim the two Runs,
   and both claims contain the same pinned base/head.
4. Completing the first review creates no adjudication Run. Completing the
   second creates exactly one. A simultaneous-completion test proves the same
   result under concurrent transactions.
5. A parameterized integration test covers failed, parked, and archived-Agent
   siblings; each blocks the join, and repairing/retrying the task activates
   adjudication exactly once.
6. Session-scope tests prove the blind Opus Run cannot read the Sol output and
   that adjudication refuses either missing/mismatched report before reading
   both valid immutable outputs in a fresh Session.
7. Approval-gate regression tests prove reject requeues the same Agent task,
   supplies its prior output through `previousRunHandoff`, and approval of the
   replacement output activates Plan once.
8. Chain-read and web tests prove layer grouping and derived progress without
   sibling/dependency payloads.
9. A source and schema census proves no remaining `followUpTaskId`,
   `ChainContinuation`, public dependency input, nested review subprocess, or
   old combined review-step source.
10. The repository exact-head merge gate passes.

No live six-daemon demonstration is required. Scheduler capacity affects
latency, not correctness.

## 9. Out of scope

- Arbitrary DAG edges, public parallel-chain construction, dynamic reviewer
  counts, conditional layers, partial joins, and join timeouts.
- Parallel tasks that write to or publish the same branch.
- Provider conversation resume or any continuation-proof data model.
- Layer status, sibling arrays, dependency arrays, and a generic workflow or
  template-version framework.
- A new approval-feedback UI or database field. The existing reject, fresh Run,
  previous-output handoff, and Inbox question path remains the revision flow.
- Reopening a completed review or rewriting an accepted immutable report.
- Changes to runner fairness, capacity, budget policy, merge authority, or the
  merge gate.

## 10. Assumptions and recorded contract amendments

The following readings are fixed here so the plan agent does not have to ask.
The first two amend the recorded Product Contract and were approved by the
human at this step's approval gate; the rest are simplest-reading assumptions.

1. **Adjudication runs a fresh Opus Session (amendment).** The Product
   Contract required adjudication to continue the exact blind-review provider
   conversation through a chain-scoped continuation contract. That requirement
   is withdrawn. `review-adjudicator-opus` always starts a fresh Session, needs
   no `providerConversationId`, and no continuation lineage is persisted.
   Cross-vendor authority is preserved by the role/model, not by conversation
   identity; blindness is preserved because the fresh session reads both
   immutable outputs only after the join. No `ChainContinuation` table exists.
2. **No live multi-daemon demonstration (amendment).** The Product Contract
   asked for timestamped evidence of two runner daemons overlapping in
   wall-clock time. That requirement is withdrawn. Acceptance item 3 instead
   proves both review Runs become claimable and are claimed by two distinct
   runner identities with the same pinned base/head. Capacity affects latency,
   not correctness, and correctness must hold with one daemon.
3. **Layer identity, not duplicate ordinals.** `chainIndex` stays unique and
   remains the node identity used by ordering, `baseFromStepIndex` pinning,
   chain activity reads, and merge execution. `chainLayer` is the added
   execution key. This is the alternative the Product Contract explicitly
   permits.
4. **Coarse full-chain lock.** Activation takes one `(chainLayer, chainIndex,
   id)`-ordered lock over every task of the chain rather than a prefix lock
   plus per-successor compare-and-swap. Chains are small and completions are
   infrequent, so one provable protocol beats two partial ones.
5. **Legacy templates are renamed, not edited.** Canonical sync renames the
   persisted 7-step and 12-step templates to `-legacy-v1` identities and
   creates the new 8-step and 13-step canonical templates. Instantiated tasks
   keep pointing at their original step rows, so running chains — including
   the Event ingestion NUL safety and heartbeat isolation chain — are byte
   unchanged.
6. **Adjudication is a new role.** `review-adjudicator-opus` is added rather
   than reusing `review-coordinator-opus` for both nodes, so the blind role's
   prompt states exactly one job and blindness cannot read as optional.
7. **Post-fix regression.** Regression stays its existing dedicated role and
   Session, freshly started on the exact post-fix head; it never resumes a
   review Session.
