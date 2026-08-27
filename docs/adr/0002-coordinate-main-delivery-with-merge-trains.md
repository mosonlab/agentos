---
status: proposed
---

# Coordinate main delivery with cumulative merge trains

AgentOS currently gives each delivery window ownership of the global merge
lease from final baseline selection through the full merge gate and the update
of `main`. That protocol protects exact-head evidence, but it also serializes
all gates even though the gate worker fleet has three remote execution slots.
This proposal moves the seam at which a candidate becomes `main` behind one
`MergeTrain` module: feature windows submit immutable candidates, the module
builds cumulative prefix commits, gates those prefixes concurrently, and is the
only writer that advances `main`.

This record is deliberately `proposed`, not accepted. It preserves the evidence,
constraints, rejected shortcuts, candidate design, failure cases, migration
shape, and open questions needed for a later window to confirm, improve, or
reject the proposal without access to the conversation that produced it.

## Working terms

These terms are local to this proposal. They do not become canonical
`CONTEXT.md` vocabulary until the proposal is accepted and implemented.

- **Merge Candidate**: one immutable feature branch head submitted for delivery,
  identified by repository, pull request, and full commit OID.
- **Train Base**: the exact `origin/main` OID from which one train is built.
- **Train Entry**: a Merge Candidate at a durable position in one train.
- **Train Prefix**: the cumulative integration commit after merging entries one
  through N. Prefix N has Prefix N-1 as its first parent and the Nth candidate
  head in its ancestry.
- **Gate Proof**: `MERGE GATE: PASS <oid>` for one exact train commit and one
  stated `--master` baseline.
- **Prefix Proof**: a Gate Proof for one Train Prefix, with the immediately
  preceding prefix, or the Train Base for the first prefix, supplied as
  `--master`.
- **Publishable Prefix**: the longest prefix for which every preceding prefix
  has a valid Prefix Proof and every submitted candidate head remains exact.
- **Ejected Entry**: a candidate removed from the current train because it
  conflicts, changes head, closes, or fails its prefix gate. Ejection is visible
  and never silently degrades into a different candidate.
- **Merge Coordinator**: the single active implementation of the `MergeTrain`
  interface and the only process authorized to advance `main`.

## Current protocol

The current protocol is split across governance, shell, remote workers, and
agent behavior:

1. `CONTRIBUTING.md` requires an exact-head merge-gate PASS and requires every
   delivery to acquire `scripts/merge-lease.sh` before the final integration,
   gate, and merge sequence.
2. `scripts/regression-verification.sh` performs semantic verification before
   `finalize`. Finalize fetches the target base, acquires the merge lease,
   fetches again to close the fetch/acquire race, dispatches the gate, and
   retains the lease after PASS for readiness and merge execution.
3. `scripts/merge-lease.sh` stores one global holder as a JSON blob at
   `refs/merge-lease/holder` on `origin`. Acquisition polls by default and
   release uses a task identity plus compare-and-swap behavior.
4. `scripts/gate-worker/gate-dispatch.sh` exposes two slots on the primary
   worker and one on the fallback worker. It can transport an explicit candidate
   and an explicit `--master` OID to a worker whose mirror has no remote.
5. `scripts/merge-gate.sh` runs a full profile in three dependency-ordered
   parallel groups. It already has a content-addressed build cache, parallel
   workspace tests, one pooled database wave, and an exact final tree check.
6. Each delivery window integrates latest `main`, acquires the same merge lease,
   runs the gate, advances `main`, releases or observes transfer of the lease,
   and cleans up its own worktree and branch.

ADR 0001 narrowed the hold substantially. Semantic verification no longer runs
under the lease, and the independent review and release-authority phases it
described were retired. The remaining hold is approximately the remote full
gate plus authorization and publication. That is much shorter than the old
hour-long holds, but it is still the full cost paid serially by every candidate.

## Observed delivery evidence on 2026-08-27

Ten architecture lanes implemented concurrently while delivery remained
serial. The following GitHub merge times were read during the run. They are not
claimed as exact gate durations, because some intervals include lease handoff,
integration, a failed first gate, or agent cleanup. They do show the throughput
of the complete delivery tail as observed by a caller.

| Delivery | Merged at UTC | Since previous merge |
| --- | --- | --- |
| Lane J, PR #190 | 14:23:55 | first observed |
| Lane G, PR #191 | 14:35:37 | 11m42s |
| Lane I, PR #192 | 14:57:22 | 21m45s |
| Lane C, PR #199 | 15:02:53 | 5m31s |
| Lane F, PR #193 | 15:08:48 | 5m55s |
| Lane D, PR #197 | 15:14:10 | 5m22s |
| Lane B, PR #194 | 15:19:54 | 5m44s |
| Independent follow-up, PR #195 | 15:24:25 | 4m31s |
| Lane H, PR #196 | 15:36:44 | 12m19s |

Lane H's first gate found a real recovery PATCH regression; it fixed the defect,
added coverage, and passed a second full gate. That event is evidence that the
full gate must remain authoritative, not an argument for a path-selective gate.

At 15:37:13 UTC, immediately after H released, lane A acquired the lease for PR
#200. At that point three remote gate slots existed, but only A could dispatch a
gate because every other candidate had to wait for the global merge lease.

The steady green portion of the sample delivered roughly one candidate every
five to six minutes. Six independent green candidates therefore consume roughly
30 to 36 minutes of serial tail time even when implementation is already done.

## Problem

The current lease has two responsibilities coupled into one interface:

- protect publication of `main` from concurrent writers; and
- prevent compute from producing a gate proof that another publication will
  invalidate before it can be consumed.

The first responsibility needs a single writer. The second does not require all
gate compute to be serial if candidates are arranged as nested prefixes.

The per-window interface is also shallow and error-prone. Every caller must know
when to fetch, when to acquire, how to recheck, how to interpret gate exit codes,
when to retain or release, how not to release a sibling's lease, how to verify
the remote update, and how to clean up. ADR 0001 records a historical case where
an agent released a lease after a failed push. The current code has repaired much
of that protocol, but the knowledge remains spread across every delivery caller.

Adding gate workers alone does not fix this problem. The worker dispatcher can
run three gates, but the lease admits only one delivery to it. Making the gate
internally wider also has diminishing leverage: the gate already parallelizes
the work allowed by its dependency graph, and one gate still has to execute all
lint, unit, migration, and database evidence.

## Required invariants

Any replacement must preserve all of these properties:

1. Published history is append-only. `main` advances only by fast-forward;
   rebase, reset, force-push, or substitution of an unsubmitted head is outside
   this design.
2. A publication consumes `MERGE GATE: PASS <exact-target-oid>`. A PASS for
   another commit, an earlier commit, or a branch name is not evidence.
3. A Gate Proof names the exact live `main` predecessor as `--master`. Prefix
   mode publishes one prefix at a time and therefore gives each prefix its own
   predecessor proof. Terminal-batch mode proves the terminal prefix against
   the Train Base and publishes the whole batch in one fast-forward.
4. The submitted pull-request head must remain the exact head recorded by its
   Train Entry until that entry publishes. Head drift ejects the entry.
5. Every delivered pull-request head is an ancestor of the surviving `main`.
   GitHub's PR state is verified after publication; it is not assumed.
6. Only one Merge Coordinator publishes. Candidate creation, local verification,
   pushing a feature branch, and opening a PR remain concurrent and unleased.
7. Mechanical conflicts are visible. The coordinator may perform a clean Git
   merge; it never invents a conflict resolution. A conflicted entry returns to
   its owner against the latest published base.
8. Gate FAIL remains a real judgement. Gate dispatch codes meaning no verdict,
   including busy slots, transport failure, or interruption, never become FAIL
   and never authorize publication.
9. The full gate remains the only CI and retains the existing test-safety rules,
   throwaway database, workspace root isolation, exact tree checks, and cleanup
   requirements.
10. A coordinator crash never rolls `main` back. Recovery starts by reading the
    remote branch, candidate heads, durable train record, and proofs; it does not
    trust local process memory.
11. Delivery machinery changes are proven in a single-entry train until the
    machinery they change is the surviving implementation.

## Proposed decision

Place the external seam at "submit this immutable candidate for delivery" and
replace per-window lease ownership with one deep `MergeTrain` module.

The conceptual caller interface is intentionally small:

```ts
type MergeCandidate = Readonly<{
  repository: string;
  pullRequest: number;
  headSha: string;
}>;

type MergeTicket = Readonly<{ id: string }>;

interface MergeTrain {
  submit(candidate: MergeCandidate): Promise<MergeTicket>;
  read(ticket: MergeTicket): Promise<MergeTicketState>;
}
```

Cancellation, reprioritization, operator recovery, and metrics are not added to
the first external interface without a current caller. They may exist as
operator commands inside the implementation while the design is proved. The
important property is that callers do not learn the lease, train ref, gate slot,
integration worktree, or publication protocol.

The implementation owns:

- validating immutable PR and head identity;
- durable queue order;
- choosing one Train Base;
- building cumulative Train Prefixes in isolated worktrees;
- dispatching Prefix Proofs with exact predecessor baselines;
- interpreting every gate verdict and no-verdict outcome;
- selecting the longest Publishable Prefix;
- acquiring and releasing publication authority;
- advancing `main` one prefix at a time;
- verifying PR state and ancestry after each advance;
- ejecting conflicts, failed entries, and drifting heads;
- recovery after a process or network failure; and
- cleanup and a durable audit record.

The real Git/GitHub adapter and a recording fake are the two adapters at the
module's internal Git seam. Tests exercise the same planner and state machine as
the real adapter. Shell commands do not become a second implementation of the
protocol.

## Prefix construction and concurrent gating

For Train Base `M0` and three submitted candidate heads `A`, `B`, and `C`, the
coordinator constructs nested merge commits:

```text
M0 -- merge A --> P1 -- merge B --> P2 -- merge C --> P3

gate P1 with --master M0
gate P2 with --master P1
gate P3 with --master P2
```

The three gate dispatches are independent compute jobs and may occupy all three
remote slots at once. `P1`, `P2`, and `P3` already exist as immutable commits;
their predecessor OIDs do not need to be the current remote `main` for a worker
to test them. `gate-dispatch.sh` already accepts and transports an explicit
candidate and explicit `--master` object.

If all three gates PASS, the coordinator acquires publication authority and:

1. verifies `origin/main == M0` and all three candidate heads are unchanged;
2. fast-forwards `main` from `M0` to `P1` and reads it back;
3. consumes the P2 proof only after verifying `origin/main == P1`, then
   fast-forwards to `P2`;
4. repeats for `P3`;
5. verifies that PR heads A, B, and C are ancestors of `main` and their PRs are
   merged; and
6. releases publication authority and cleans train state.

The pushes occur under one short publication hold. Advancing one prefix at a
time keeps each proof's stated baseline equal to the live `main` at the moment
the proof is consumed. A direct jump from `M0` to `P3` is not used, even though
the graph is a fast-forward, because it would skip the live-baseline condition
for P2 and P3.

## Failure and recovery cases

### Mechanical merge conflict

If candidate B cannot merge mechanically onto P1, B is ejected with the conflict
evidence. The coordinator does not create P2 from a guessed resolution. Later
entries are rebuilt from P1 without B only after their original ordering and
fairness semantics are explicitly defined. The first implementation may instead
end the batch at P1 and leave all later entries queued, which is simpler and
preserves FIFO.

### Gate FAIL

If P1 PASSes, P2 FAILs, and P3 PASSes, only P1 is publishable. P3 contains B and
cannot bypass the failed prefix. A PASS for P3 is retained only as diagnostic
evidence; it is not merge authority. B is ejected for repair, and C is rebuilt
on the next valid base.

If P1 FAILs, no prefix publishes. Later PASS results cannot bypass the first
failed entry because their commit ancestry includes it.

### No gate verdict

Busy worker slots, SSH failure, dispatcher precondition failure, interruption,
and OOM are no-verdict outcomes. The entry remains queued and the same immutable
prefix may be re-dispatched. No-verdict does not eject a candidate or authorize
publication.

### Main changes before publication

If `origin/main` is no longer the Train Base, the coordinator publishes nothing
from that train. It discards publication intent, preserves gate output as
diagnostic evidence, and rebuilds prefixes from the new base. This should become
rare once the coordinator is the only writer; it remains required during cutover
and for operator emergency writes.

### Candidate head changes or PR closes

If a PR head differs from the submitted full OID, or the PR is no longer open,
that entry is ejected. A new head is a new Merge Candidate and receives a new
ticket; the coordinator never retargets an existing ticket silently.

### Coordinator crash before publication

No remote branch has changed. A replacement reads the durable train record,
remote candidate heads, and gate proofs. It may resume only if every identity is
exact; otherwise it rebuilds. Rebuilding is always a valid fallback because no
proof has been consumed.

### Coordinator crash between prefix pushes

`main` points at an exact prefix and never needs rollback. Recovery identifies
that prefix from remote ancestry, verifies its proof was recorded, and either
continues with the next proven prefix or stops safely. Every push and read-back
is its own durable checkpoint.

### Publication push or read-back fails

The coordinator stops immediately and reads remote state through the existing
network retry policy. It never chains release after a failed push with `;`, and
it never reports the exit status of a formatter or pipe as the push result. If
the remote advanced, recovery follows the crash-between-prefixes case. If it did
not, the same exact push can be retried while authority is still held.

### Cleanup fails

Delivery remains published, but the ticket records cleanup failure and names the
exact worktree, local branch, remote branch, or train ref left behind. Cleanup
never changes merge authority and never hides a successful publication.

### Delivery machinery changes

A candidate that changes the coordinator, merge lease, gate dispatcher, merge
gate, train persistence, or the governance that defines merge authority runs as
a single-entry train. This avoids asking an old coordinator to interpret later
prefixes built under a protocol that an earlier prefix changes.

## Persistence and ownership

The coordinator needs durable state shared by all callers. Two plausible homes
must be compared in an implementation spike:

1. a JSON blob in a dedicated origin ref, following the proven
   `refs/merge-lease/holder` compare-and-swap pattern; or
2. AgentOS database state, with a Git ref used only for publication authority.

An origin ref works for deliveries that do not originate in an AgentOS Chain and
keeps queue identity beside the repository it advances. Database state offers
better queryability and recovery tooling but would make the control plane a
required dependency for every repository delivery. The initial CLI prototype
should prefer an origin ref unless a current non-AgentOS caller can be removed.

Whichever store is selected, the durable record must include at least:

- train id and schema version;
- Train Base;
- ordered ticket ids, PR numbers, and submitted head OIDs;
- every prefix OID and exact predecessor OID;
- gate dispatch attempt and outcome, preserving no-verdict separately;
- publication checkpoints and remote read-backs;
- ejection reason and evidence; and
- cleanup state.

The store is an implementation detail behind `MergeTrain`. Callers do not edit
the ref or table directly.

## Ordering and fairness

The first implementation should use FIFO by accepted submission time. Priority,
manual reordering, repository-wide batching policy, and starvation prevention
are real product decisions and should not be hidden in the initial coordinator.

FIFO has one deliberate consequence: a conflict or failed first entry blocks
later prefixes until the entry is ejected. The coordinator must make ejection
fast and explicit. It must not leave a failed head at the front while continuing
to spend gate capacity on descendants that cannot publish.

The first batch size should match the three currently measured remote slots.
Making this a generic tuning surface before another capacity shape exists would
add interface without a caller. The implementation may read the existing worker
slot inventory internally so the value is not duplicated.

## Performance model

Let G be the typical full-gate duration, S the usable worker slots, and N the
number of conflict-free green candidates already ready for delivery.

- Current serial tail: approximately `N * G`.
- Prefix train: approximately `ceil(N / S) * G`, plus small integration and
  publication costs.
- One terminal gate for a batch: approximately `ceil(N / batchSize) * G`, but a
  failure does not identify the first bad entry and requires splitting or
  sequential diagnosis.

With the observed steady G of roughly five to six minutes and S of three, six
green candidates move from about 30 to 36 minutes of gate time toward 10 to 12
minutes. This is a hypothesis to measure, not an acceptance claim. Conflicts,
failures, cache misses, and rebuilds reduce the gain.

Worker utilization is not the only metric. The implementation must record:

- queue wait before train admission;
- time to build each prefix;
- gate slot wait, run time, and outcome;
- time from first PASS to publication;
- wasted gate minutes after an earlier prefix fails or drifts;
- publication hold duration;
- conflict and ejection counts; and
- end-to-end candidate delivery latency.

The current lease blob records acquisition time but not queue arrival, so it
cannot answer the full throughput question alone.

## Implementation sequence

### Phase 0: measurements and executable scenarios

- Add the timing fields above without changing delivery behavior.
- Build a recording fake for Git/GitHub operations and a bare-origin integration
  harness.
- Encode the failure cases in this record as tests before changing authority.
- Verify experimentally that fast-forwarding cumulative merge commits makes all
  included PR heads ancestors of `main` and causes GitHub to mark each PR merged.

### Phase 1: serial coordinator, one entry

- Introduce the `MergeTrain` module and route one candidate through it.
- Keep batch size one and the current gate/lease ordering.
- Move integration, proof interpretation, publication, read-back, release, and
  cleanup behind the module interface.
- Replace direct per-window publication rather than layering the coordinator on
  top of it.

This phase earns locality and recovery value before changing throughput.

### Phase 2: cumulative batches with one terminal gate

- Admit up to three clean candidates.
- Build cumulative merge commits and gate the terminal prefix once with the
  Train Base as `--master`.
- On PASS, fast-forward `main` once from the Train Base to the terminal prefix
  after proving the terminal tree contains every submitted head.
- On FAIL, publish nothing and split the batch to locate the failing entry.

This is the smallest throughput experiment, but it delays failure attribution.
If that operational cost is unacceptable, skip directly from Phase 1 to Phase 3.

### Phase 3: concurrent prefix gates

- Dispatch each prefix with its exact predecessor as `--master`.
- Consume only the longest contiguous passing prefix.
- Rebuild from the first failed, conflicting, or drifting entry.
- Use the measured worker slot inventory without exposing slot policy to callers.

### Phase 4: remove the old authority path

- Change operator and agent instructions so feature windows submit and stop.
- Remove their direct acquire/release and main-push protocol in the same cutover.
- Rollover frozen canonical prompts where the delivery instruction is embedded;
  do not mutate historical task prompts.
- Keep a batch-size-one coordinator mode as the operational rollback. Do not keep
  per-agent publication as a second compatibility path.

## Verification matrix

The module interface and its real/fake adapters must cover at least:

| Scenario | Required result |
| --- | --- |
| Three clean candidates, all gates PASS | main advances P1, P2, P3; all PR heads are ancestors; all PRs merged |
| P1 PASS, P2 FAIL, P3 PASS | only P1 publishes; P2 ejects; P3 is not authority |
| P1 FAIL | nothing publishes; later prefixes cannot bypass P1 |
| Gate dispatch returns busy or transport failure | no FAIL is recorded; immutable prefix retries |
| Candidate B conflicts while building P2 | B ejects with conflict evidence; no guessed resolution |
| Candidate head changes after submission | entry ejects; changed head requires a new ticket |
| main changes before publication | train publishes nothing and rebuilds from new base |
| Crash before publication | restart resumes or rebuilds without changing main |
| Crash after P1 before P2 | restart reads main=P1 and may consume only P2's exact proof next |
| Push reports failure but remote advanced | read-back detects published prefix; no duplicate or rollback |
| Release races a new holder | compare-and-swap refuses to remove the new holder |
| Cleanup fails after publication | delivery stays published; ticket reports exact residue |
| Coordinator/gate machinery changes | candidate is restricted to a single-entry train |

The integration harness must use a bare disposable origin, isolated worktrees,
and fake gate proofs bound to exact commits. A smaller pure planner should cover
prefix selection and ejection tables without Git. Remote-worker smoke tests then
prove that explicit predecessor OIDs traverse the existing transport unchanged.

## Considered options

### Keep the current global lease per candidate

This is safe and simple to reason about. It remains the correct behavior while
this proposal is unaccepted and during Phase 1. It leaves worker capacity idle
and makes delivery latency linear in the number of ready candidates.

### Move lease acquisition after each independent gate

Rejected. Concurrent candidates built from the same `main` do not contain one
another. The first publication advances the baseline and makes the other proofs
stale. Those candidates must integrate again and re-run the gate, consuming more
compute without increasing accepted throughput.

### Add more gate workers

Rejected as a standalone answer. The current lease admits one gate regardless of
slot count. More capacity helps only after gate admission and publication are
separated by a train.

### Select tests by changed paths

Rejected. The merge gate is the only CI, cross-package effects are real, and H's
first gate found a recovery regression outside its locally targeted happy path.
The proposal changes scheduling, not the evidence required for merge.

### Cache test verdicts

Rejected. The current build cache accelerates deterministic build outputs while
every test still executes. Reusing a test verdict across a different cumulative
commit would weaken exact-head evidence.

### Gate only the terminal batch prefix

Retained as Phase 2, not the preferred end state. It uses one slot efficiently
and reduces gate count, but a failure gives no prefix-local judgement and can
block several unrelated candidates until the batch is split.

### Run every prefix gate concurrently

Preferred end state. Nested baselines keep proofs useful after earlier prefixes
publish, while a failed prefix limits publication to the preceding contiguous
PASS range. Its cost is a coordinator state machine and some wasted downstream
gates after an early failure.

## Consequences

- Merge authority becomes one deep module with a small caller interface. Lease,
  Git, gate, and recovery knowledge gain locality instead of being repeated in
  every agent window.
- Green, conflict-free throughput can use all measured worker slots without
  weakening the full gate or exact-head binding.
- Integration order becomes an explicit durable fact rather than whichever
  window wins the lease race.
- The coordinator becomes critical infrastructure and needs stronger recovery,
  observability, and defense-list treatment than the present shell convention.
- Some gate work is speculative. A failed early prefix invalidates useful
  authority from later prefixes, although those results remain diagnostic.
- Conflicting candidates may wait longer because the coordinator refuses to
  invent resolutions. Their owners receive a precise new base and conflict.
- Frozen prompt rules make cutover more expensive: agent delivery instructions
  that embed acquire/release behavior require a canonical template rollover.
- The existing serial protocol remains authority until this proposal is accepted,
  implemented, gated, and cut over atomically.

## Open questions for the accepting review

1. Should the first throughput phase use one terminal batch gate or move directly
   to prefix gates after the serial coordinator proves recovery?
2. Is an origin ref the correct durable queue store for non-AgentOS deliveries,
   or can every current caller be required to use AgentOS database state?
3. Should a conflicting FIFO entry end the current batch or be ejected while
   later entries retain their order and rebuild immediately?
4. Which changes require mandatory single-entry trains beyond the delivery
   machinery paths listed above?
5. What measured failure rate makes downstream speculative prefix gates too
   wasteful relative to terminal batch gates?
6. Does GitHub mark every included PR merged under the proposed cumulative merge
   commit graph in all supported repository and fork configurations?
7. What is the exact durable proof record: raw gate output, parsed verdict plus
   hash, or a signed worker attestation? The current system treats worker output
   as trusted evidence, not independent authority.
8. Should publication advance all proven prefixes under one lease or release
   between prefixes? This proposal recommends one short hold because releasing
   would allow an external writer to invalidate the next exact predecessor.

## Acceptance criteria for this decision

This ADR should move from `proposed` to `accepted` only after a prototype proves:

- three cumulative prefixes can be transported and gated with explicit nested
  baselines by the existing worker fleet;
- a longest-contiguous-PASS planner handles every row in the verification matrix;
- a crash between prefix pushes resumes without rollback or duplicate delivery;
- submitted PR heads become ancestors of `main` and GitHub records the expected
  merged state;
- a main-drift compare-and-swap publishes nothing stale;
- batch-size-one mode is at least as safe and observable as the current protocol;
- measured green throughput improves materially without an unacceptable rise in
  wasted gate minutes; and
- cutover removes direct per-agent publication rather than leaving two writers.

## Current authority and related records

Until acceptance, the current protocol remains authoritative:

- [ADR 0001: Narrow the merge lease hold window](0001-merge-lease-hold-window.md)
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md), "Delivering to main"
- [`scripts/merge-lease.sh`](../../scripts/merge-lease.sh)
- [`scripts/regression-verification.sh`](../../scripts/regression-verification.sh)
- [`scripts/merge-gate.sh`](../../scripts/merge-gate.sh)
- [`docs/runbooks/gate-worker.md`](../runbooks/gate-worker.md)
