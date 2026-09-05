---
status: accepted
date: 2026-08-27
---

# Coordinate concurrent host deliveries with cumulative merge prefixes

## Decision

When two or three host-side feature windows have open pull requests ready at the
same time, one coordinating window runs `scripts/merge-train.mjs` with their PR
numbers and exact head OIDs in FIFO order. The command:

1. reads the exact live `origin/main` base;
2. builds cumulative merge commits `P1`, `P2`, and `P3` in one temporary
   worktree, removing `.chain` from every resulting tree;
3. runs the existing full merge gate for every prefix concurrently, with each
   prefix's exact predecessor as `--master`;
4. selects the longest contiguous PASS prefix;
5. acquires the existing merge lease only for publication;
6. rechecks live `main` and every included PR head;
7. fast-forwards `main` one proven prefix at a time and reads every update back;
8. verifies candidate ancestry and GitHub's merged projection; and
9. releases the lease and removes its temporary worktree.

The fixed command surface is:

```sh
scripts/merge-train.mjs \
  --task <coordinator-id> \
  --candidate <pr>:<40-character-head> \
  --candidate <pr>:<40-character-head> \
  [--candidate <pr>:<40-character-head>]
```

This is a host delivery coordinator, not a general queue service. Argument order
is the queue. Width is fixed at three because the current worker fleet has three
measured slots. There is no database table, queue ref, background daemon,
generic API, priority policy, or recovery state machine.

## Why this boundary

The existing protocol is safe but serial: every delivery holds the global merge
lease while its final full gate runs. Three remote gate slots exist, but only
the lease holder can use one of them for a delivery. Moving the gate before the
lease for unrelated branch heads would only create stale proofs after the first
head lands.

Cumulative prefixes preserve exact evidence while allowing concurrent compute.
For base `M0` and candidates `A`, `B`, and `C`:

```text
M0 -- merge A --> P1 -- merge B --> P2 -- merge C --> P3

gate P1 with --master M0
gate P2 with --master P1
gate P3 with --master P2
```

All three commits exist before any gate starts. The gates may therefore run at
the same time. Publication remains serial and short:

```text
main: M0 -> P1 -> P2 -> P3
```

Each proof is consumed only when its named predecessor is the live `main`.

## Scope

This decision changes only concurrent host-side delivery. It deliberately does
not change:

- Anneal Chain task state;
- regression-verification output schemas;
- canonical Agent templates;
- merge-gate semantics or coverage;
- the GitHub App merge executor; or
- single-candidate Chain delivery.

Those systems have current callers and their own authorization contracts.
Folding this coordinator into them would require a new batch authorization
model, a prompt rollover, DB migration, and a second kind of gate attestation.
That work is not required to solve the observed multi-window host bottleneck.

Both the existing single-candidate path and this coordinator use the same merge
lease, so only one of them can publish at a time. Delivery machinery changes,
including changes to this command, remain single-candidate deliveries through
the existing path. New machinery never authorizes its own first publication.

## Required invariants

1. `main` advances only by fast-forward. No rebase, reset, force-push, or head
   substitution is allowed.
2. Every published prefix has `MERGE GATE: PASS <exact-prefix-oid>`.
3. The proof baseline is the exact first parent and the exact live predecessor
   at publication time.
4. Every prefix is a two-parent merge commit: the preceding prefix first and the
   submitted PR head second.
5. `.chain` is absent from every published tree.
6. Candidate PR number, state, and full head OID are checked before gating and
   again before publication.
7. A conflict is reported. The coordinator never invents a resolution.
8. Gate FAIL, NOT AUTHORITATIVE, and no-verdict remain distinct from PASS.
9. Only a contiguous PASS prefix can publish. A later PASS cannot cross an
   earlier FAIL, no-verdict, conflict, or drift.
10. Every push has an exact remote read-back before the next prefix is attempted.
11. If a push's remote result cannot be read, the merge lease is retained for
    operator recovery.
12. A rerun starts from live `main`; already-delivered candidate heads are
    detected by ancestry and skipped.

## Failure behavior

| Event | Result |
| --- | --- |
| P1 PASS, P2 FAIL, P3 PASS | Publish P1 only |
| P1 FAIL or no-verdict | Publish nothing |
| Candidate B conflicts while building P2 | End the batch at P1; report B and its conflicted files |
| A candidate head changes or its PR closes | Cut publication before that candidate |
| `main` changes while gates run | Publish nothing; rerun from the new live base |
| Process exits before publication | No remote state changed; rerun |
| Process exits after publishing P1 | Rerun; P1's candidate is skipped and the rest are rebuilt |
| Push fails and read-back says `main` is unchanged | Release the lease and fail loudly |
| Push result cannot be read | Retain the lease and require operator inspection |
| GitHub has not yet projected a contained PR as merged | Report a warning; exact Git ancestry remains the delivery fact |

The coordinator keeps no durable queue or proof cache. Git commits, live
`main`, exact PR heads, gate output, and the merge lease are already the durable
facts needed for a safe rerun. Recovering an old speculative proof would add
more identity and lifecycle rules than rerunning at most three gates.

## Why not GitHub Merge Queue

GitHub Merge Queue can provide managed ordering, speculative grouping, required
checks, and automatic removal of incompatible entries. It is a good fit when
GitHub-native branch protection and GitHub Actions checks are the complete merge
authority.

It is not selected here. Availability and cost depend on repository ownership,
visibility, and GitHub plan; cost is therefore not a reliable universal reason
to reject it. More importantly, this repository's authority is not GitHub's
standard check-and-merge path:

- `scripts/merge-gate.sh` is the only CI and emits an exact commit proof;
- each merge uses an exact predecessor contract;
- `.chain` must be removed from the published tree; and
- the existing merge lease and merge executor already own publication safety.

Using GitHub Merge Queue would either require replacing those contracts with
GitHub-native checks or maintaining two queue and merge authorities. It also
ties the protocol to one hosted feature whose eligibility can change with
ownership or plan. The small coordinator reuses the current open-source Git,
shell, gate, and lease primitives and adds no paid service dependency.

## Rejected additions

The earlier proposal contained several designs without a current requirement.
They are removed:

- A generic `MergeTrain.submit/read` application API. The current caller is one
  coordinating terminal command.
- A durable DB or origin-ref queue. A maximum of three explicit arguments is the
  whole current queue.
- A terminal-prefix-only gate phase. It saves gate work but makes one failure
  block and obscure the whole batch.
- Resuming or reusing old gate proofs after a crash. Rebuilding from live state
  is simpler and safer.
- Priority, reordering, configurable batch width, starvation policy, and a
  metrics subsystem. None has a current caller or acceptance criterion.
- A new merge executor batch protocol. The existing lease already serializes
  publication across host and Chain callers.
- A full coordinator state machine with tickets, ejection states, and cleanup
  records. The command returns one explicit result and fails loudly.

## Consequences

- Two or three green independent candidates can use all three gate slots while
  preserving exact-head evidence.
- The lease covers only live-state recheck and prefix publication, not the full
  gate duration.
- To avoid wasting completed gate proofs when another window holds the lease for
  only a few seconds, lease acquisition waits up to 10 minutes by default and
  accepts an operator-supplied bound through `--lease-wait-minutes <n>`. This
  wait still occurs after gating, so the lease remains a publication-only hold;
  once acquired, live `main` must still equal the original base or the train
  returns `stale-base` and discards the proofs.
- FIFO is visible in the command line rather than hidden in lease acquisition
  timing.
- A downstream gate may be wasted when an earlier prefix fails. With a maximum
  width of three, that bounded waste is preferable to a durable scheduler.
- A coordinator process is still a privileged `main` writer. It uses the same
  lease and fast-forward constraints as the existing host procedure.
- Host and Chain delivery remain separate callers of shared mechanical
  authority. They are not falsely unified by changing unrelated DB contracts.

## Verification

`scripts/merge-train.test.mjs` uses disposable bare origins and real Git
worktrees. It proves:

- three clean prefixes gate concurrently and publish in FIFO order;
- `.chain` is absent from the prefix tree;
- a failed middle prefix cuts publication even when the final prefix passes;
- a mechanical conflict ends the batch without an invented resolution;
- main drift after gates causes zero publication;
- rerunning after a partial publication reads live `main`, skips the delivered
  head, and rebuilds the remaining candidates;
- the post-gate acquire forwards the bounded `--timeout-minutes`, including an
  explicit zero;
- a wait resolved with unchanged `main` publishes the already-gated prefixes
  without rerunning a gate;
- a wait resolved with moved `main` returns `stale-base` and publishes nothing;
  and
- an expired wait returns `lease-contended` carrying `leaseWaitedMs`.

The full merge gate remains the acceptance authority for the exact commit that
introduces this machinery. That first delivery uses the old single-candidate
path as required by the single-entry rule.

## Related authority

- [ADR 0001: Narrow the merge lease hold window](0001-merge-lease-hold-window.md)
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md), "Delivering to main"
- [`scripts/merge-train.mjs`](../../scripts/merge-train.mjs)
- [`scripts/merge-lease.sh`](../../scripts/merge-lease.sh)
- [`packages/runner/runtime-tools/gate-worker/gate-dispatch.sh`](../../packages/runner/runtime-tools/gate-worker/gate-dispatch.sh)
- [`scripts/merge-gate.sh`](../../scripts/merge-gate.sh)
