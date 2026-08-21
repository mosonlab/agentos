# Blind review — template chain retry branch (Opus)

Reviewer: review-coordinator-opus, session cmt2gjd0909m8mp457g13y243.
Written and committed before opening `reviews/sol-findings.md`.

## Range

- base `00b94f9861861d19c5bdc78b57cb5949d82bd730`
- head `482e0b1aaa217539c3492e6bdea8c3ece60f43aa`

Both resolve in the tree. `implementation_range` in `sessions.md` names exactly
this pair. Direct chain: no `slices/` directory, so `spec.md` is the whole
authority. Everything the chain carries is reachable at head — the diff is
`packages/api/src/app.ts` (one hunk), `packages/api/src/chain-branch.dbtest.ts`
(one added test), and `.chain/template-chain-retry-branch/spec.md`.

## Verification run for this review

- `npm run typecheck -w @agentos/api` — pass.
- `npm run lint:biome` — pass, 379 files. (`biome.jsonc` and
  `scripts/merge-gate.sh:1093` state formatting is deliberately not checked, so
  no formatting finding is raised.)
- `npm run test:db -w @agentos/api -- src/chain-branch.dbtest.ts` on a scratch
  PostgreSQL (`AGENTOS_ALLOW_SCRATCH_DATABASES=1`, throwaway container, private
  `?schema=`, `RUNNER_WORKSPACE_ROOT=$(mktemp -d)`) — 29/29 pass.
- Same file with `packages/api/src/app.ts` reverted to the base blob — 28/29,
  the one failure being the added test. The added test is a genuine regression
  test, not a tautology.
- `npm run build` then `npm run test:db -w @agentos/api` (whole suite) —
  331/331 pass, 0 fail.
- `npm run test -w @agentos/api` — 409 tests, 408 pass, 0 fail (1 skipped).

Acceptance 1, 2 and 3 are therefore met by execution, not by inspection alone.
`T13`, `T14`, `T14a` (the non-template automatic-retry coverage acceptance 2
names) are green at head.

## Verdict

No P0 and no P1. The change is correct for every reachable state I could
construct, and the one behavioural side effect beyond the head fix
(OPUS-4) is what `spec.md` asked for. Eight P2 findings follow.

---

### OPUS-1 — P2 — standards (dispensables / mysterious name)

`packages/api/src/app.ts:4152-4154`

`resolveChain` is named as a predicate but is not one. `currentTask.repo &&
currentTask.chainId && (...)` evaluates to `{ defaultBranch: string } | string |
boolean | null`, so line 4154 has to re-test `currentTask.repo` a second time —
not for logic, only to give TypeScript a narrowing it cannot take from
`resolveChain`. The duplicated test reads like a defensive check and will invite
a future reader to "simplify" one of the two away.

Judgement call. Fix direction: bind the narrowed value instead of a pseudo-boolean.

```ts
const chainRepo = currentTask.chainId && currentTask.chainIndex !== null
  ? currentTask.repo
  : null;
const branches = chainRepo
  ? await resolveRunBranches(tx, { ...currentTask, repo: chainRepo }, currentTask.templateId ? run : null)
  : { ... };
```

### OPUS-2 — P2 — standards (speculative generality)

`packages/api/src/app.ts:4152-4153`

The guard was `chainId && chainIndex !== null && !templateId && repo`. The edit
needed to delete `!templateId`; it instead rewrote the index test as
`(currentTask.templateId || currentTask.chainIndex !== null)`, which additionally
admits a template row whose `chainIndex` is null.

No such row exists. Every writer of `Task.templateId` writes `chainIndex`
alongside it: `packages/api/src/templates.ts:152/161` (the only production path,
`chainIndex: step.stepIndex`) and `packages/api/src/merge-integrator-fixture.ts:74/79`
(`chainIndex: <step>.stepIndex`). So the new arm is unreachable, and it
reads as a deliberate exemption from the isolation rule documented at
`packages/db/src/workflow.ts:366-369` ("A chainId with no index … must remain
isolated from indexed siblings"). A reader has to walk two files to learn the
exemption is inert.

Judgement call. Fix direction: `currentTask.chainId && currentTask.chainIndex
!== null && currentTask.repo`, which is behaviourally identical for every
reachable row and matches the shape `packages/api/src/reconcile.ts:178` uses for
the same decision.

### OPUS-3 — P2 — standards (comment no longer describes the code, and the gap is load-bearing)

`packages/api/src/app.ts:4147-4151` vs `4158`

The surviving paragraph ends "`body.branch ?? run.branch` is that same effective
value, because `run` was read before the update." That sentence explains the
argument on line 4164 — the `resolveRequeueBase` arm. Line 4158 passes bare
`run` as `prior`, whose `.branch` is deliberately *not* that effective value, and
nothing says so. Sitting directly under a paragraph that defines the effective
value, it reads as though `run` carries it.

This is not cosmetic. The difference decides the incident's own follow-on case:

- A pre-fix retry exists with `branch: null`. `workspace.ts` gives it
  `agentos/<taskId>/run-2`, and the runner reports that as `body.branch`.
- It fails retryably. `run.branch` (read before the `updateMany`) is still
  `null`, so `resolveRunBranches` returns `prior?.branch ?? chainBranch`
  (`packages/db/src/workflow.ts:362`) — the chain branch. The stranded chain
  heals.
- Had the arm passed `body.branch ?? run.branch` for symmetry with the arm
  below, the retry would inherit `agentos/<taskId>/run-2` and the chain would
  stay stranded for the rest of its budget.

The correct behaviour depends on reading a stale field on purpose, and the only
comment nearby asserts the opposite convention.

Fix direction: state at line 4158 that the template arm wants the *pre-update*
`run.branch` and why; move the effective-value sentence down onto the
`resolveRequeueBase` arm it actually explains.

### OPUS-4 — P2 — spec / stale invariant

`packages/db/src/workflow.ts:310-316`

`resolveRequeueBase`'s docstring opens: "The base for a requeue that must
otherwise keep the failed run's *own* base rather than the task's current one:
the automatic retry inside the completion transaction and the lost-lease
requeue. Both deliberately snapshot the run they are replacing, so an operator
edit to `task.targetBranch` afterwards does not silently retarget them".

After this change a template chain step's automatic retry no longer reaches
`resolveRequeueBase`. With no publication evidence its base is now
`task.targetBranch ?? task.repo.defaultBranch`
(`packages/db/src/workflow.ts:363`) — the operator's *current* value, read at
retry time. The snapshot protection the docstring promises is gone for that
class of run.

The behaviour is what `spec.md` directs: "The automatic retry … resolves the new
run's `branch` and `targetBranch` through `resolveRunBranches` for template
chain steps as well". So this is a documentation defect, not a behaviour defect —
but the docstring is now a false statement in the file that owns the invariant.

Fix direction: narrow the docstring to the non-template automatic retry plus the
lost-lease requeue, and record at the `app.ts` call site that template chains
trade the snapshot for chain-branch continuity.

### OPUS-5 — P2 — standards (repository test convention)

`packages/api/src/chain-branch.dbtest.ts:674`

All 28 other tests in this file are `T1:` … `T21:`, and the section banners key
to work items (`// --- WI-6: …` at line 672). The added test carries no ID, so
it cannot be cited by a merge note or a later review the way its neighbours can,
and it sorts ahead of `T13` under a banner whose other members are numbered.

Fix direction: `T13b: a template chain automatic retry keeps its chain head
through publication`, placed beside `T13`.

### OPUS-6 — P2 — spec (an acceptance clause asserted against the test's own input)

`packages/api/src/chain-branch.dbtest.ts:703-706`

`spec.md` acceptance 1: "a template chain step whose run fails retryably gets an
automatic retry whose `branch` is the chain branch (not null), **and a subsequent
successful publication lands on the chain branch name**."

The second clause is exercised as `publishViaRoute(retryClaim, chainBranch)`
followed by `assert.equal(publishedRetry.pushedBranch, chainBranch)` — the test
hands the route the branch name and then asserts the route stored it. It would
pass with the fix reverted.

What actually makes a real runner push there is `claim.run.branch`: the claim
route answers `run: { ...run, pullRequestBase: … }` (`packages/api/src/app.ts:3537`)
and `workspace.ts` provisions from it. The file's own helper docstring
(`chain-branch.dbtest.ts:69-71`) says going through the real claim route is the
point, "because the claim payload is assembled from live rows".

The first clause (line 698) does carry the fix, so this is a strengthening, not
a hole. Fix direction: assert `retryClaim.run.branch === chainBranch` before
publishing.

### OPUS-7 — P2 — test coverage (the heal-forward case)

`packages/api/src/chain-branch.dbtest.ts:691-699`

The completion body passes `branch: chainBranch`, and the failed run's stored
`branch` was already `chainBranch`. Stale and effective agree, so the test
cannot distinguish them — and OPUS-3 shows the distinction is what fixes the
chains the 2026-08-21 incident already stranded. The realistic post-incident row
is a retry created with `branch: null` that completes reporting
`body.branch = agentos/<taskId>/run-2`; nothing covers a second automatic retry
from it.

Consequence: a later refactor that "unifies" line 4158 with line 4164 passes the
entire suite while leaving every already-stranded chain stranded.

Fix direction: extend the added test — after asserting the first retry, null its
`branch`, complete it retryably with `branch: agentos/<taskId>/run-2`, and
assert run 3's `branch` is still the chain branch.

### OPUS-8 — P2 — standards (stale assertion message)

`packages/api/src/chain-branch.dbtest.ts:783`

`assert.equal(retry.branch, null, "this path has never carried branch forward;
that asymmetry is preserved")`. The assertion is still correct — T14's task is
non-chain — but the message describes the *route*, and the route now does carry
`branch` forward, for template chains. `spec.md` names preserving non-chain
behaviour as change 2, so the sentence is exactly the kind of retired claim the
repository's comment discipline expects to be deleted with the path it
described.

Fix direction: reword to scope it to the case — "a non-chain retry still carries
no branch forward".

---

## Checked and cleared (recorded so adjudication does not re-open them)

- **Isolation level.** The completion transaction is `ReadCommitted`
  (`packages/api/src/app.ts:4341`), so the two added reads
  (`templateChainBranch`'s sibling `task.findFirst`, `inheritedBase`'s
  `run.findFirst`) cannot raise serialization failures. Both are non-locking
  reads taken while the task row is already locked, so no new deadlock edge.
- **Lost-lease requeue.** `packages/api/src/reconcile.ts:178-185` keeps the same
  `!task.templateId` guard, but its fallback arm is `branch: run.branch`, not
  `branch: null` — a template chain's lost-lease requeue already keeps its head.
  There is no sibling defect left unfixed there, which is why `spec.md` scopes
  the change to the completion transaction alone.
- **Single-step template chain.** `templateChainBranch` returns null when no
  sibling task carries a non-default `targetBranch`, so a one-step template
  chain's retry still gets `branch: null`. Pre-existing in `resolveRunBranches`
  and identical for the first run; a one-step chain has no successor to clone,
  so the spec's goal is unaffected. Not a finding against this diff.
- **Poisoned-shape guard.** `resolveRequeueBase`'s "`run.targetBranch ===
  run.branch`" fallthrough is now bypassed for template chains. Traced through:
  it fell through to `task.targetBranch ?? defaultBranch`, which is the same
  value `resolveRunBranches`'s template arm returns. No behaviour change beyond
  OPUS-4.
- **Behaviour the diff introduces that the spec did not ask for.** None found
  beyond OPUS-4, which `spec.md` change 1 does ask for.
