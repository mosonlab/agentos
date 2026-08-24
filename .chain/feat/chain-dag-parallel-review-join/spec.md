# Chain DAG Phase 2: parallel review fan-out and join

Specification for branch `feat/chain-dag-parallel-review-join`.
Status: for human approval. Audience: the plan agent and every later step of this chain.

## 1. Problem and who it is for

AgentOS executes template chains as a strict linear list. `Task` carries
`chainId` + `chainIndex` with `@@unique([chainId, chainIndex])`, every task is
also wired into a `followUpTaskId` linked list at instantiation, and
`activateChainSuccessorInternal` (`packages/db/src/workflow.ts`) activates
exactly one successor: the lowest `chainIndex` above the finished task that is
not `DONE`. Consequently two reviews that share one immutable input — the Sol
standards/spec review and the Opus blind review of the same pinned
`implementationBase...implementationHead` range — run one after the other even
though neither reads the other's output.

Who this is for:

- The operator running canonical Direct and Full Assurance chains. Six runner
  daemons are online; the second review currently waits behind the first for no
  correctness reason, and that serialization is pure wall-clock cost on every
  chain.
- The reviewers themselves. The Sol review role today is expected to spawn two
  nested `codex exec` review subprocesses (Standards and Specification) with a
  service-tier override. Leo has ruled that no Direct, Full, or large-diff
  review launches internal subprocesses: one Sol high main session covers both
  axes, so review parallelism becomes control-plane-visible task parallelism
  that the board, the budget, and the runner scheduler can all see.
- Whoever audits a merge. Cross-vendor authority (OpenAI implements and
  reviews on one axis, Anthropic reviews blind and adjudicates) and exact-head
  evidence must survive the change unchanged.

Phase 1 already landed the prerequisites: review outputs are immutable
`TaskStepOutput` records with canonical JSON contracts
(`packages/api/src/canonical-task-output.ts`), and review checkouts are pinned
to the implementation base/head by `pinnedImplementationRange`
(`packages/db/src/workflow.ts`) via `TaskTemplateStep.baseFromStepIndex`.

## 2. Outcome

Chains execute as a **layered DAG**. Every task node belongs to exactly one
execution layer. All nodes of a layer are eligible together; the next layer is
a join that becomes eligible only when **every** node of every earlier layer is
`DONE`. A failed, stopped, or parked branch fail-stops the join for operator
action; there is no partial-join fallback. The `followUpTaskId` execution path
is deleted in the same change, and chains instantiated before the migration
keep executing exactly as they do today.

## 3. Canonical execution graphs

### 3.1 Direct engineer workflow — 8 nodes, 7 layers

| Node (ordinal) | Layer | Step | Agent | outputKind | baseFrom |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | Implementation | `senior-dev` | `implementation` | null |
| 2 | 2 | Code review (Sol) | `review-coordinator-sol` | `sol-findings` | 1 |
| 3 | 2 | Blind review (Opus) | `review-coordinator-opus` | `blind-findings` | 1 |
| 4 | 3 | Adjudication (Opus) | `review-adjudicator-opus` | `must-fix` | 1 |
| 5 | 4 | Apply review fixes | `senior-dev` | `fixed-implementation` | null |
| 6 | 5 | Regression verification | `regression-verifier` | `regression-verification` | null |
| 7 | 6 | Merge readiness | server-owned readiness step (unchanged) | `merge-authorization` | null |
| 8 | 7 | Merge execution | merge integrator sentinel (unchanged) | unchanged | null |

Today's Direct template has 7 nodes because node 3 (`03-code-review-and-adjudication-opus.md`)
performs blind review *and* adjudication inside one task through the
three-phase `independent-findings` → `predecessor-evidence-unlocked` →
`closed-must-fix` write sequence. Phase 2 splits that task into a blind-review
node and an adjudication node.

### 3.2 Full Assurance (compound engineer) workflow — 13 nodes, 12 layers

| Node | Layer | Step | Change |
| --- | --- | --- | --- |
| 1 | 1 | Write a spec | unchanged (approval gate) |
| 2 | 2 | Plan | unchanged |
| 3 | 3 | Plan review | unchanged |
| 4 | 4 | Revise plan | unchanged |
| 5 | 5 | Implementation | unchanged |
| 6 | 6 | Code review (Sol) | parallel sibling |
| 7 | 6 | Blind review (Opus) | parallel sibling, new node |
| 8 | 7 | Adjudication (Opus) | join |
| 9 | 8 | Apply review fixes | renumbered |
| 10 | 9 | Regression verification | renumbered |
| 11 | 10 | Librarian | renumbered |
| 12 | 11 | Merge readiness | renumbered |
| 13 | 12 | Merge execution | renumbered |

Every layer except layer 6 (Direct: layer 2) holds exactly one node. The DAG is
layered, not an arbitrary `blocked_by` graph: a node's dependencies are "all
nodes in all lower layers of the same chain", nothing else.

## 4. Data model changes

### 4.1 Layer identity — Assumption A1

The Product Contract allows either relaxing `@@unique([chainId, chainIndex])`
or introducing an equally explicit layer identity. **This spec selects the
explicit layer identity and keeps `chainIndex` unique.** Reasons, all of them
load-bearing existing code:

- `pinnedImplementationRange` resolves the pinned base/head by
  `findFirst({ chainId, chainIndex: baseFromStepIndex })`. With duplicate
  indexes that read silently picks one of several rows.
- The merge executor reads the readiness step at `chainIndex - 1`
  (`packages/merge-executor/src/index.ts:131`) through
  `/session/runs/:id/chain/steps/:chainIndex/activity`.
- `chain.ts` ordering, `positions()`, and `GET /tasks/:id/chain` all treat
  `chainIndex` as the deterministic display order key.

Schema:

- `Task.chainLayer Int?` — the execution layer. Non-null exactly when
  `chainId` and `chainIndex` are both non-null.
- `TaskTemplateStep.layer Int` — required, default not permitted for canonical
  templates; existing rows are backfilled by the migration (§4.3).
- New index `@@index([chainId, chainLayer])` on `Task`.
- Retained: `@@unique([chainId, chainIndex])`, so `chainIndex` remains one
  deterministic ordering key for display and for base pinning.

Invariants enforced at template load and instantiation:

1. Layers are 1-based and contiguous: the set of layers is exactly
   `1..max(layer)`.
2. `layer` is non-decreasing in `stepIndex` order, and node ordinals within a
   layer are contiguous. Node ordinal order therefore never contradicts layer
   order.
3. `baseFromStepIndex` must reference a step in a **strictly lower** layer (a
   strengthening of the existing "strictly earlier stepIndex" rule).
4. Layer 1 holds exactly one node, and it is agent-executable (unchanged
   first-step rule in `instantiateTemplate`).

### 4.2 Removal of `followUpTaskId`

`Task.followUpTaskId`, its `@unique`, and the `TaskFollowUp` relation pair are
dropped. `instantiateTemplate` stops writing the linked list.
`activateChainSuccessorInternal`'s `followUpTaskId` branch and
`advanceTemplateTask`'s `return { gated: true, nextTaskId: task.followUpTaskId }`
are replaced by layer-derived successors (§5.4). Any surviving non-template
consumer of the column is deleted with it; no compatibility shim is kept.

### 4.3 Migration of existing data

One forward migration, no data loss, no prompt or assignment rewrite:

- Add `Task.chainLayer`, `TaskTemplateStep.layer`, and the new index.
- Backfill `TaskTemplateStep.layer` = dense rank of `stepIndex` within its
  template (so every pre-existing template step is its own layer), then make
  the column `NOT NULL`.
- Backfill `Task.chainLayer` = dense rank of `chainIndex` within
  `(projectId, chainId)` for every task whose `chainId` and `chainIndex` are
  both non-null; leave `NULL` otherwise. A pre-migration chain therefore has
  one node per layer and executes exactly as it does today.
- Drop `followUpTaskId` last.
- The migration touches only these columns. It does not modify `description`,
  `assigneeAgentId`, `status`, `Run`, `Session`, or `TaskStepOutput` rows. The
  currently instantiated *Event ingestion NUL safety and heartbeat isolation*
  chain is immutable operational state and is covered by this rule; it is not
  retrofitted or reordered.
- Canonical template *rows* are re-synced from the repository sources by the
  existing `db:sync-canonical-prompts` path (§7.3). Re-syncing changes the
  template definitions used by **future** instantiations only.

### 4.4 Continuation lineage — new `ChainContinuation` model

Proof that adjudication resumes the exact Opus blind-review provider
conversation. Recency is never evidence.

```
model ChainContinuation {
  id                     String   @id @default(cuid())
  projectId              String
  chainId                String
  producerTaskId         String            // blind-review task
  producerRunId          String
  producerSessionId      String
  consumerTaskId         String            // adjudication task
  providerConversationId String
  agentId                String
  model                  String
  effort                 String
  baseSha                String
  headSha                String
  outputId               String            // the blind TaskStepOutput row
  outputBodyHash         String            // sha256 of the persisted blind body
  consumedByRunId        String?
  consumeAttempt         Int      @default(0)
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt

  @@unique([consumerTaskId])
  @@index([chainId])
}
```

Write rule: the row is created **inside the same transaction** that marks the
blind-review task `DONE`, from the producer `Session` (`providerConversationId`,
`agentId`, model/effort snapshot from the `Run`) and the producer's immutable
`TaskStepOutput`. If the producer session has no `providerConversationId`, the
task does not complete: the run fails loudly with
`blind review completed without a resumable provider conversation`.

Read rule: when a run is claimed for the adjudication task, the claim payload
carries `resume: { providerConversationId, input }` derived from this row, plus
a `continuation` proof block (§6.3). The claim is refused, loudly and by name,
when the row is missing, bound to a different producer task, or disagrees with
the current blind output identity (`outputId`, `outputBodyHash`), the pinned
`baseSha`/`headSha`, the agent, the model, or the effort. The claim never
falls back to a fresh conversation while reporting reuse.

Fencing and retry: each claim increments `consumeAttempt` and sets
`consumedByRunId` under the task row lock, so two concurrent claims cannot both
resume. A retry of the adjudication task resumes the same
`providerConversationId` again (the conversation is the authority, not the
attempt). If the provider rejects the resume, the run fails with the provider
error; it does not silently open a fresh conversation. An operator who wants a
fresh-conversation adjudication must say so explicitly by clearing the
continuation row through an operator action, which is recorded in the activity
log.

## 5. Control-plane behavior

### 5.1 Eligibility and join

Define, for a task `T` with non-null `chainId`/`chainLayer`:

- `layerPrefix(T)` = all surviving tasks of the same `(projectId, chainId)`
  with `chainLayer < T.chainLayer`.
- `T` is **join-eligible** iff every task in `layerPrefix(T)` has status `DONE`.
  Archived rows still count as dependencies until they are `DONE` (unchanged
  from today's `firstUnfinishedStep` semantics).

`blockingPredecessor(rows, targetId)` (`packages/api/src/chain.ts`) is
generalized: it returns the first non-`DONE` task in `layerPrefix(target)`
ordered by `(chainLayer, chainIndex, id)`, and `null` when the prefix is
complete. Nodes in the **same** layer are never each other's blocker.

`firstUnfinishedStep` is replaced by `eligibleSteps(rows)`: every surviving task
of the lowest layer that still contains a non-`DONE` task. `chainStartDecisions`
marks each of those tasks `startable` (subject to the unchanged row-local
`taskStartability` checks); tasks in higher layers are not startable and report
their blocker.

### 5.2 Activation on completion

`activateChainSuccessorInternal` becomes `activateChainSuccessors` and returns
`{ nextTaskIds: string[]; gated: boolean }`:

1. Lock the chain prefix. `lockChainPrefixRows` is generalized from
   `chainIndex <= target` to `chainLayer <= targetLayer`, still ordered
   `("chainLayer", "chainIndex", "id") FOR UPDATE`, which keeps the lock order
   total and deadlock-free across concurrent completers.
2. Recompute the lowest layer that still contains a non-`DONE` task. If the
   finished task's own layer still has non-`DONE` siblings, activate nothing and
   write one activity row on the finished task:
   `Layer <n> incomplete; join not activated (waiting on: <names>)`.
3. Otherwise, for **every** surviving non-`DONE` task in that next layer, run
   the existing per-successor guard chain unchanged: task row lock, active-run
   guard (`ACTIVE_RUN_STATUSES`, including `WAITING_INBOX`), `parkedReason`,
   the `updatedAt` CAS with the `TODO|DOING|REVIEW` status predicate and its
   re-read loop, `pinnedImplementationRange` / integrator-stop handling, and the
   activity row. A successor whose CAS is lost to another completer is reported
   as `already active`, not activated twice.
4. Chain complete (no surviving non-`DONE` task at all) keeps today's single
   `Chain complete` activity row on the finished task.

Exactly-once is therefore preserved by the same two mechanisms already in place
— the prefix `FOR UPDATE` lock plus the per-successor `updatedAt` CAS — now
applied per successor instead of to a single successor. Two siblings finishing
simultaneously serialize on the prefix lock; the loser observes both siblings
`DONE`, recomputes, and finds the join already claimed.

### 5.3 Fail-stop

If any node of a layer ends `FAILED`, `BACKLOG` (parked), or stopped, the join
never activates: rule 2 above sees a non-`DONE` sibling. The surviving sibling
still completes normally and persists its output. The chain waits for operator
action (retry the failed node, or park/archive it and retry). There is **no**
partial join, no timeout-based join, and no "adjudicate with one report"
degraded path — the adjudication node additionally refuses to start without
both immutable sibling outputs (§6.3).

### 5.4 Gates, start, and retry

- **Approval gate.** A gated task still goes to `REVIEW` and raises the gate
  question. `advanceTemplateTask` returns `{ gated: true, nextTaskIds: [] }`;
  the gate approval path (`applyInboxDecisionTx`) marks the task `DONE` and
  then runs `activateChainSuccessors`, which is the only place the join is
  evaluated. A gate on one node of a parallel layer therefore holds the whole
  join, which is the intended conservative behavior.
- **Gate rejection.** The "return to the previous step" path currently picks
  the highest `chainIndex < gateTask.chainIndex`. It is generalized to the
  highest `(chainLayer, chainIndex)` strictly below the gate task, i.e. the
  last node of the previous layer; when the previous layer holds several nodes,
  the rejection target is the one with the highest `chainIndex` in that layer,
  and the choice is recorded in the activity row.
- **Manual start.** `POST /tasks/:id/start` keeps its 409 behavior but is now
  satisfied by join-eligibility: any eligible sibling may be started manually,
  in any order, while a higher-layer task returns 409 naming the blocking
  predecessor from §5.1.
- **Retry.** Retrying a completed-then-reopened node re-blocks its join for as
  long as the node is not `DONE`; on completion the join is re-evaluated by the
  same code path.

### 5.5 Runner capacity

Activation enqueues a run for every activated node of the layer
(`enqueueTaskRun` per node, in the same transaction). Which daemon claims which
run is unchanged scheduler behavior. Correctness must hold with a single
daemon: with one runner the two review nodes execute in an arbitrary order, one
after the other, and the join still waits for both. Capacity is an eligibility
and latency concern only.

### 5.6 Branch and workspace safety

All nodes of a chain share one derived branch (`sharedChainBranch`). Both
review nodes are read-only reviewers pinned by `baseFromStepIndex` to the
implementation base/head: they run in detached checkouts of the pinned head and
must not push. The spec requires that both parallel review steps keep
`opensPullRequest: false` and that neither writes to the chain branch (reports
are platform outputs only). No other layer in the canonical templates contains
more than one node, so no two writers ever share the branch concurrently.
**Assumption A2:** parallel siblings that both write to the shared chain branch
are out of scope for this phase; template validation rejects a layer with more
than one node whose `opensPullRequest` is true.

## 6. Review roles and session authority

### 6.1 Sol code review — one session, two axes

- `agents/roles/review-coordinator-sol.md` and the live canonical role prompt
  must contain **no** nested `codex exec` review subprocess and **no**
  review-specific service-tier override. Observation at spec time: the
  repository copy of this role already describes two sequential in-session
  passes and contains no subprocess command; the removal work is therefore
  (a) verifying and, where needed, correcting the live canonical configuration
  through the canonical prompt sync, and (b) adding a guard so the prompt
  cannot regain one.
- Guard: a test over the loaded role/step sources asserts that no review role
  prompt (`review-coordinator-sol`, `review-coordinator-opus`, the new
  adjudicator) contains `codex exec`, `service_tier`, or a background-subprocess
  launch instruction. No Full/large-diff exception exists.
- The Sol node keeps `outputKind: sol-findings` and its existing JSON contract:
  one report covering the Standards axis and the Specification axis, produced
  by one `gpt-5.6-sol:high` main session.

### 6.2 Opus blind review node

- Agent: `review-coordinator-opus`, `claude-opus-5` (cross-vendor authority
  relative to the OpenAI implementation and Sol review paths).
- `attachmentsFromPrevious: false` (existing claim rule at
  `packages/api/src/app.ts:4682` already withholds predecessor outputs).
  Extended: the blind node's task-output and chain read surfaces must also
  withhold **same-layer sibling** outputs, at every point in the run. The
  blind session can never see the Sol report — before or after persisting —
  because it no longer adjudicates.
- The three-phase write sequence collapses to a single immutable write of kind
  `blind-findings` (same finding JSON contract as `sol-findings`, bound to the
  pinned head). The `predecessor-evidence-unlocked` phase is removed from the
  blind node; the `closed-must-fix` phase moves to the adjudication node.
- Completion writes the `ChainContinuation` row (§4.4).

### 6.3 Opus adjudication node

- New role `review-adjudicator-opus` carrying only the adjudication half of
  today's `review-coordinator-opus` prompt: the canonical merge matrix (same
  defect adopted at the higher severity; the Opus finding retained by default;
  a Sol-only finding admitted only after verification against the code;
  contradictions recorded on both sides with the existing Inbox rule; P0/P1 are
  must-fix, P2 recorded and non-blocking).
- `attachmentsFromPrevious: true`. The run is refused unless **both** sibling
  outputs exist, are `DONE`-bound and immutable, and are bound to the same
  pinned `implementationBaseSha`/`implementationHeadSha` as this node's
  `baseFromStepIndex`.
- The run resumes the exact proven Opus conversation via the continuation
  contract (§4.4). A missing or mismatched proof fails the claim loudly.
- Output: kind `must-fix`, phase `closed-must-fix`, unchanged closed-artifact
  schema (`findings`, `dispositions`, `mustFixIds`) plus the existing
  self-consistency refusals, extended so `dispositions` must cover every
  finding id from **both** sibling reports. The adjudication output is a
  separate `TaskStepOutput` on a separate task; it can never rewrite the blind
  report.

### 6.4 Fixes and regression

- Apply-review-fixes stays a separate `senior-dev` write-authority session
  (unchanged prompt, renumbered).
- Post-fix regression runs a **fresh** Sol high session on the exact post-fix
  head. `agents/roles/regression-verifier.md` moves from
  `openai-codex/gpt-5.6-sol:medium` to `openai-codex/gpt-5.6-sol:high`
  (**Assumption A3**: the contract's "fresh Sol high session" is satisfied by
  raising the existing dedicated regression role rather than by adding a new
  one). It must not resume any review session, and no continuation row is
  created for it. The residual "resume the blind-review session" paragraphs in
  `review-coordinator-opus.md` and the Sol role's legacy regression paragraph
  are deleted.

## 7. Interface changes

### 7.1 Template sources

`agents/templates/*/NN-*.md` frontmatter gains a required `layer` field, added
to `STRUCTURAL_FIELDS` in `packages/db/src/template-sources.ts` and to
`templateStepStructureDifferences` so drift is detected. Loader validation adds
the §4.1 invariants. `CANONICAL_TEMPLATE_SOURCE_SPECS` becomes
`{ direct-engineer-workflow: stepCount 8, layerCount 7 }` and
`{ compound: stepCount 13, layerCount 12 }`. New and renamed files:

- Direct: `03-blind-review-opus.md` (new), `04-adjudication-opus.md` (new),
  and `04..07` renumbered to `05..08`.
- Compound: `07-blind-review-opus.md` (new), `08-adjudication-opus.md` (new),
  and `08..12` renumbered to `09..13`.
- The old combined `*-code-review-and-adjudication-opus.md` files are deleted,
  not kept alongside.

### 7.2 HTTP API

- `GET /tasks/:id/chain` step objects gain `layer: number | null` and
  `layerSiblings: string[]` (task ids in the same layer, excluding self), and
  keep `position` as the node ordinal. `blockingPredecessor` follows §5.1.
- `GET /tasks` (board view) `chainProgress` gains `layer` and `layerCount`;
  `done`/`total` remain node counts, and `activeStepName` becomes the first
  eligible node's step name (lowest layer, then lowest ordinal).
- The run-claim payload gains an optional `continuation` block
  (`producerTaskId`, `producerSessionId`, `providerConversationId`,
  `outputId`, `baseSha`, `headSha`) alongside the existing `resume` block.
- `/session/runs/:id/chain/steps/:chainIndex/activity` keeps its node-ordinal
  key, so the merge executor's `chainIndex - 1` readiness read is unaffected
  (readiness and merge execution remain adjacent single-node layers).
- Errors are named and loud: `chain layer join blocked by <task>`,
  `continuation proof missing for adjudication task <id>`,
  `continuation proof does not match the persisted blind review output`.

### 7.3 Canonical prompt sync

`npm run db:sync-canonical-prompts -w @agentos/db` syncs the new step count,
the `layer` column, the split review steps, and the corrected role prompts into
an existing installation, idempotently, without touching instantiated task
rows.

### 7.4 Board and chain UI

- The chain list groups rows by layer. A layer with more than one node renders
  as one visually grouped block labelled with the layer number, so parallel
  siblings never read as sequential steps.
- Each row keeps its node ordinal (`step.position`), distinct from the layer
  label; the two numbers are never conflated.
- The join row shows a "waiting for layer N" dependency marker naming the
  outstanding sibling(s) while the join is blocked.
- Board cards show `layer x/12` progress in addition to node progress.
- Copy is added to both locale bundles; no emoji or decorative symbols.

## 8. Concrete scenarios

**S1 — happy path, Direct, six daemons.** Implementation node completes.
Activation locks the layer prefix, sees layer 1 fully `DONE`, and enqueues runs
for the Sol node and the Opus blind node. Two different daemons claim them
within seconds of each other; the runs overlap in wall-clock time. Each
persists its immutable report bound to the pinned head. The second completer
observes both layer-2 nodes `DONE` and activates the adjudication node, which
claims with a continuation proof, resumes the Opus blind conversation, reads
both reports, and persists the closed must-fix list.

**S2 — one daemon.** Same graph. The daemon claims the Sol node, finishes it;
activation finds the Opus sibling still `TODO` and activates nothing. The
daemon then claims the Opus node; its completion activates the join. Identical
outcome, longer wall clock.

**S3 — simultaneous completion.** Both reviews complete in the same instant.
Both completion transactions attempt the layer-prefix lock; one wins, sees the
sibling not yet `DONE`, activates nothing. The other then sees both `DONE` and
activates the join once. Exactly one `Run` exists for the adjudication node.

**S4 — Sol review fails.** The Sol run ends `FAILED`. The Opus blind node
finishes and persists its report. The join stays blocked; the chain detail view
shows the adjudication node blocked by the failed Sol node. The operator
retries the Sol node; on its success the join activates. No adjudication ever
runs on one report.

**S5 — blind node parked.** An operator parks the blind node (`BACKLOG`). The
join reports `blocked by <blind review> (parked)` and does not activate;
recovering the parked node and completing it activates the join.

**S6 — adjudication retry.** The adjudication run crashes after resuming. The
operator retries. The claim re-reads the same `ChainContinuation` row,
increments `consumeAttempt`, and resumes the same `providerConversationId`.
The prior partial adjudication wrote no final output, so nothing is rewritten.

**S7 — continuation proof broken.** The blind session ended without a
`providerConversationId`. The blind task does not complete: its run fails with
the named refusal, so the join never activates on an unprovable lineage. An
operator retries the blind node; the retry produces a new conversation and a
fresh proof.

**S8 — legacy chain.** The instantiated *Event ingestion NUL safety and
heartbeat isolation* chain has one node per layer after backfill. Each
completion activates exactly the next node, as before. Its task descriptions,
assignments, runs, and sessions are untouched by the migration.

**S9 — blindness attempt.** The Opus blind session tries to read the Sol
sibling's output through the task-output or chain read surface. Both refuse for
that task; the session sees no sibling report at any point in its run.

## 9. Edge cases and failure behavior

| Case | Behavior |
| --- | --- |
| Task with `chainId` but `NULL` `chainIndex` | Unchanged: isolated, no auto-advance, existing "Chain row missing chainIndex; auto-advance skipped" activity. `chainLayer` stays `NULL`. |
| Deleted node inside a layer | Deleted rows are absent from the prefix, exactly as today; the join computes over surviving rows. |
| Archived-but-not-done node | Remains a dependency; the join stays blocked (unchanged semantics). |
| Sparse or non-contiguous `chainIndex` | Ordering is by `(chainLayer, chainIndex, id)`; `position` remains a dense 1-based ordinal. |
| Layer with a non-agent assignee | Allowed for single-node layers only (readiness/merge), unchanged. |
| Both reviews complete but one output fails canonical validation | The run does not complete, the task is not `DONE`, the join stays blocked. |
| Adjudication claimed while a sibling output is still being written | Impossible: the join activates only after both tasks are `DONE`, which requires their outputs to be durable and valid. |
| Concurrent operator start of two siblings | Both are eligible; both start. The active-run guard still prevents a second run per task. |
| Integrator stop | Unchanged: the readiness→merge layer keeps today's stop/park/recovery behavior, including `activateRecoveryIntegratorSuccessor`, which now calls the layered activator and still asserts it resolved exactly the expected integrator task. |
| Migration re-run | Idempotent; backfills are `WHERE chainLayer IS NULL`. |
| Budget/spend caps | Unchanged per task; two concurrent review runs consume two runs' worth of budget, as two tasks always did. |

## 10. Out of scope

- Arbitrary `blocked_by` dependency graphs, cross-chain dependencies, dynamic
  fan-out (N reviewers decided at runtime), and conditional layers.
- Partial joins, join timeouts, or any degraded single-report adjudication.
- Retrofitting, reordering, or re-instantiating any chain that exists before
  the migration, including the active NUL/heartbeat chain.
- Rewriting archived or historical task prompts. Archived descriptions remain
  evidence; later takeover work synthesizes a fresh brief from that evidence
  rather than replaying stale workflow instructions.
- Parallel *write* siblings on one chain branch (worktree isolation, merge
  barriers) — explicitly deferred, see Assumption A2.
- Runner scheduler changes: capacity, fairness, and claim policy are unchanged.
- Goal (5a0) execution lineage, merge-executor decision table, and the merge
  gate itself.
- Any change to the Fowler smell taxonomy, severity ladder, or finding JSON
  contract beyond the new `blind-findings` kind and the widened disposition
  coverage rule.

## 11. Assumptions

- **A1** Layer identity is a new explicit `chainLayer`/`layer` column pair, and
  `@@unique([chainId, chainIndex])` is retained, because `baseFromStepIndex`
  pinning, the merge-executor chain read route, and display ordering all rely
  on a unique node ordinal. The Product Contract explicitly permits this
  alternative.
- **A2** Parallel siblings that write to the shared chain branch are not
  supported in this phase; template validation rejects a multi-node layer with
  more than one `opensPullRequest: true` step.
- **A3** "Fresh Sol high session" for post-fix regression is delivered by
  raising the existing `regression-verifier` role to `gpt-5.6-sol:high` rather
  than introducing a new role.
- **A4** The blind-review node's three-phase write sequence collapses to one
  immutable `blind-findings` write, because the evidence-unlock phase existed
  only to let the same session adjudicate; adjudication is now its own node.
- **A5** A new role `review-adjudicator-opus` is added rather than reusing
  `review-coordinator-opus` for both nodes, so each node's prompt states one
  job and the blindness rule cannot be read as optional.
- **A6** An approval gate on any node of a multi-node layer holds the entire
  join (conservative reading; canonical templates place no gate on a review
  node).
- **A7** Gate rejection from a join targets the highest-ordinal node of the
  immediately preceding layer, recorded in the activity log.

None of these assumptions changes the Product Contract's objective, scope,
acceptance criteria, evidence requirements, authority model, or risk boundary,
so no blocking Inbox question is raised.

## 12. How a reviewer verifies the feature

Evidence must be produced at the exact candidate head.

1. **Template shape.** Instantiate the Direct template into a scratch project:
   8 task rows, `chainLayer` values `1,2,2,3,4,5,6,7`, node ordinals `1..8`.
   Instantiate the compound template: 13 rows, layers `1..6,6,7..12`.
   Canonical source-drift tests pass for both templates.
2. **Overlap.** An integration test (or a recorded live run) shows the Sol and
   Opus blind runs claimed by two different runner daemons with overlapping
   `[startedAt, endedAt]` intervals, and the timestamps are shown in the
   evidence.
3. **Join.** Database workflow tests prove: (a) completing one sibling
   activates nothing; (b) completing the second activates exactly one
   adjudication run; (c) two concurrent completion transactions produce exactly
   one run (exactly-once); (d) a `FAILED` sibling, a stopped sibling, and a
   parked sibling each leave the join blocked with a named activity row; (e)
   retrying and completing the failed sibling then activates the join.
4. **Single-daemon correctness.** The same join tests pass with one runner.
5. **Blindness and adjudication.** API tests prove the blind task cannot read
   the sibling output at any point, that the blind output is immutable once
   written, and that adjudication (i) refuses to claim without both outputs,
   (ii) refuses a missing/mismatched continuation proof by name, (iii) resumes
   the recorded `providerConversationId` when the proof matches, and (iv)
   cannot rewrite the blind report.
6. **No nested subprocesses.** A source/prompt test asserts no review role or
   review step prompt contains `codex exec`, `service_tier`, or a
   background-subprocess launch instruction, with no Full or large-diff
   exception. The Sol node produces one report containing both axes.
7. **Fresh sessions downstream.** Tests prove the apply-fixes and regression
   runs create new sessions, that regression creates no continuation resume,
   and that the regression verdict is bound to the post-fix head.
8. **Legacy behavior.** A migration test seeds a pre-migration chain (linked
   list + unique indexes), runs the migration, and asserts: one node per layer,
   unchanged sequential activation, and byte-identical `description`,
   `assigneeAgentId`, `Run`, and `Session` rows. A separate assertion shows the
   active NUL/heartbeat chain rows are unchanged.
9. **`followUpTaskId` gone.** Schema census / grep shows no remaining column,
   relation, or execution-path reference.
10. **UI.** Board and chain-detail tests show the layer grouping, the distinct
    layer label vs node ordinal, the parallel-sibling block, and the join's
    "waiting for layer N" marker naming the outstanding sibling.
11. **Gate.** `npm run` schema migration, db workflow tests, runner concurrency
    tests, API tests, web tests, and the repository merge gate all pass at the
    exact candidate head.
