# Adjudicated review — template chain retry branch

Closed. Every finding from both reports has a disposition below; nothing here is
an open-ended instruction to review further. The one contradiction was put to
Leo with both bodies of evidence and ruled on — see "Human ruling" below.

## Range and identities

- implementation base: `00b94f9861861d19c5bdc78b57cb5949d82bd730`
- delivered head: `482e0b1aaa217539c3492e6bdea8c3ece60f43aa`
  (one commit, `fix(api): keep template retries on chain branch`)
- both resolve in the tree; `implementation_range` in
  `.chain/template-chain-retry-branch/sessions.md` names exactly this pair
- authority: `.chain/template-chain-retry-branch/spec.md` at head. No `slices/`
  directory — direct chain, the spec is the sole authority.
- Report A (first reviewer): `.chain/template-chain-retry-branch/reviews/sol-findings.md`,
  Sol / `codex exec review -m gpt-5.6-sol`, committed `2315131`.
  0 P0, 1 P1, 0 P2.
- Report B (blind, independent): `.chain/template-chain-retry-branch/reviews/opus-blind-findings.md`,
  review-coordinator-opus, session `cmt2gjd0909m8mp457g13y243`, committed
  `34ef65e` **before** `sol-findings.md` was opened. 0 P0, 0 P1, 8 P2.

## Merge matrix applied

| Final ID | Report A | Report B | Rule | Severity |
| --- | --- | --- | --- | --- |
| MFX-01 | SOL-001 (P1) | explicitly rejected in B's "checked and cleared" | contradiction → verified against the code, escalated, **ruled by Leo**: adopted for the multi-step / upgrade-state case | **P1** |
| REC-08 | SOL-001 (P1), single-step half | explicitly rejected in B | same contradiction, **ruled by Leo**: recorded, not blocking | P2 |
| REC-01 | — | OPUS-1 (P2) | B retained by default | P2 |
| REC-02 | — | OPUS-2 (P2) | B retained by default | P2 |
| REC-03 | — | OPUS-3 (P2) | B retained, **rationale corrected** (see below) | P2 |
| REC-04 | — | OPUS-4 (P2) | B retained by default; A's STD-002 rejection concerns the behaviour, not the stale docstring | P2 |
| REC-05 | — | OPUS-5 (P2) | B retained by default | P2 |
| REC-06 | — | OPUS-6 (P2) | B retained by default | P2 |
| —      | — | OPUS-7 (P2) | **folded into MFX-01** — same code, same missing regression | — |
| REC-07 | — | OPUS-8 (P2) | B retained by default | P2 |

Report A raised no P2 and no separate smell judgement, so no B-only finding is
displaced. Report A's own harness item `STD-002` was rejected inside A; it maps
to B's OPUS-4, which survives on the narrower documentation ground (REC-04).

---

## Human ruling on the contradiction

Asked through the Inbox with both reports' positions, the reproduction below,
and three options. Leo chose **`adopt-p1-case-b`**:

> P1 must-fix for the multi-step / upgrade-state case only; single-step recorded
> as P2; chain returns to the fix phase.

Applied: **MFX-01** (P1, must-fix) is the multi-step / upgrade-state case.
**REC-08** (P2, recorded, non-blocking) is the single-step case. The blind
report's rejection of SOL-001 is withdrawn in both halves — it was refuted on
the facts before the ruling; the ruling settles severity and scope, not the
mechanism.

## The contradiction as it stood — MFX-01 / REC-08 / SOL-001

### What A says

`SOL-001` — P1 — "A per-run fallback can remain the template chain head."
`packages/api/src/app.ts:4158` passes the failed `run` as `prior`;
`packages/db/src/workflow.ts:362` returns `prior?.branch ?? chainBranch`, so a
failed run whose `branch` is a per-run fallback hands that fallback to the
retry. A cites the single-step template (no sibling → `templateChainBranch`
returns null → `branch: null` → `workspace.ts:160` fallback →
`app.ts:3573` persists it) and the pre-fix upgrade state as the two ways in.
Consequence A claims: the retry publishes to a per-run branch while a successor
still clones the chain branch, "preserving the stranded-chain failure the feature
is required to remove."

### What B says

B's report closes with, under "Checked and cleared (recorded so adjudication does
not re-open them)":

> **Single-step template chain.** `templateChainBranch` returns null when no
> sibling task carries a non-default `targetBranch`, so a one-step template
> chain's retry still gets `branch: null`. Pre-existing in `resolveRunBranches`
> and identical for the first run; a one-step chain has no successor to clone,
> so the spec's goal is unaffected. Not a finding against this diff.

B also built OPUS-3 and OPUS-7 on the premise that `run.branch` is still `null`
when the completion transaction reads it, and therefore that the change *heals*
an already-stranded chain back onto the chain branch.

### Verification the coordinator ran on the contradiction

Both sides were tested, not argued. A throwaway `*.dbtest.ts` was added, run
against a scratch PostgreSQL (`AGENTOS_ALLOW_SCRATCH_DATABASES=1`, disposable
container, private `?schema=`, `RUNNER_WORKSPACE_ROOT=$(mktemp -d)`), and
deleted; the tree is clean at `34ef65e` plus this file.

Case A — single-step template chain, driven through the real claim / start /
complete routes:

```
A: chainId=af89bbb4-…  branchName=agentos/af89bbb4-…  task.targetBranch=main
A: run1.branch=null    run1.targetBranch="main"
A: claim.run.branch=null
A: after start,  run1.branch="agentos/cmt2h5zdq000cmpjsiqsz4qaz/run-1"
A: RETRY branch="agentos/cmt2h5zdq000cmpjsiqsz4qaz/run-1"  targetBranch="main"
```

Case B — two-step template chain in the pre-fix upgrade state (a retry created by
the old code path, i.e. `branch: null`, then started and failed after the fix
ships):

```
B: claim.run.branch=null -> runner falls back to agentos/cmt2h602u0011mpjsr2w21722/run-1
B: after start,  run1.branch="agentos/cmt2h602u0011mpjsr2w21722/run-1"
B: RETRY branch="agentos/cmt2h602u0011mpjsr2w21722/run-1"
         targetBranch="agentos/cmt2h602u0011mpjsr2w21722/run-1"
B: chain branch is agentos/a3c7ecc4-…; the successor step will clone that
```

**A's mechanism is confirmed and B's premise is refuted.** The link B missed is
`POST /runner/runs/:runId/start` (`packages/api/src/app.ts:3553-3573`), which
writes `branch: body.branch ?? null` at start time. By the time the completion
transaction reads `run`, `Run.branch` is no longer null — it is the per-run
fallback `workspace.ts:160` invented. So:

- B's "checked and cleared" entry for the single-step chain is **withdrawn**.
- B's OPUS-3 claim that the pre-update read *heals* a stranded chain is
  **withdrawn**; the opposite is true, and that is SOL-001.
- B's OPUS-7 proposed a regression asserting run 3 lands on the chain branch.
  Case B above shows it does not. OPUS-7 is folded into MFX-01 as the test half
  of the same defect, with the expectation corrected.

Case B additionally shows something neither report stated: the retry is created
with `branch === targetBranch === agentos/<taskId>/run-1`. That is precisely the
"poisoned shape" `resolveRequeueBase` documents at
`packages/db/src/workflow.ts:320-324` and guards against — and the template arm
of `resolveRunBranches` has no such guard, so template chains now bypass it.

### The scope question that was put to Leo

The evidence settled the mechanism. It did not settle scope, and the two
plausible readings produced different work:

1. `spec.md`'s headline sentence is unconditional — "An automatic retry of a
   template chain step runs on the chain branch" — and the incident that
   justifies the batch created exactly the population Case B describes. On that
   reading MFX-01 is a P1 must-fix and the chain returns to the fix phase.
2. `spec.md` also says `resolveRunBranches` "already handles template tasks
   correctly", puts "workspace.ts fallback naming" out of scope, and its
   acceptance clauses are both satisfied at head (verified: see below). On that
   reading SOL-001 describes a *second, pre-existing* defect one route further
   along, the delivered change is a correct partial step, and MFX-01 should be
   recorded as a follow-up rather than block this head.

The coordinator recommended reading 1 for Case B and P2 for Case A: a
single-step template chain has no chain branch and no successor, so the
consequence there is cosmetic, whereas Case B is the incident's own population
and the feature does not repair it. Leo ruled that way.

---

## Must-fix (P1) — the fix phase closes this one item

### MFX-01 — P1 — a multi-step template chain retry keeps the failed run's workspace branch, so an already-stranded chain stays stranded

Sources: `SOL-001` (P1, Report A) and `OPUS-7` (P2, Report B, test half),
adopted at P1 by Leo's ruling.

Location: trigger `packages/api/src/app.ts:4158` (`currentTask.templateId ? run
: null`); head selection `packages/db/src/workflow.ts:362`
(`branch: prior?.branch ?? chainBranch`); the value that gets inherited is
written by `packages/api/src/app.ts:3573` (`branch: body.branch ?? null` in
`POST /runner/runs/:runId/start`) from `packages/runner/src/workspace.ts:160`.

Governing specification, `.chain/template-chain-retry-branch/spec.md`:

> An automatic retry of a template chain step runs on the chain branch, so a
> step that succeeds on retry publishes where its successor will clone.

and, from Changes 1:

> the retry keeps the chain branch as its head while base resolution still
> honors publication evidence

Defect: `resolveRunBranches`'s template arm prefers `prior.branch` over the
resolved chain head, and `prior.branch` is the failed run's *workspace* branch,
not a chain head. For a multi-step template chain that value is the chain branch
in the ordinary case — but not for a run that started with `branch: null`, which
is exactly what the pre-fix automatic retry produced. Reproduced at head (Case B
above): the retry is created with
`branch = targetBranch = agentos/<taskId>/run-1` while the chain branch is
`agentos/<chainId>`, so the step publishes where its successor will not look and
the 2026-08-21 incident's own chains are not repaired by the change that exists
to repair them. `branch === targetBranch` is additionally the poisoned shape
`resolveRequeueBase` guards against at `packages/db/src/workflow.ts:320-324`;
the template arm has no equivalent guard, and template chains now bypass the one
that existed.

Fix direction: in the template arm, let a resolved chain head win over the prior
run's workspace branch, and keep `prior` for base evidence only — i.e. the head
becomes the chain branch whenever `templateChainBranch` yields one, falling back
to `prior?.branch` only when it does not (which is REC-08's case and stays as it
is today). The change may land in `packages/db/src/workflow.ts`'s template arm or
at the `app.ts` call site, whichever preserves the other four callers.
`packages/runner/src/workspace.ts` stays untouched — `spec.md` puts its fallback
naming out of scope, and this defect is fixable entirely in branch resolution.

Behaviours the fix must not regress (all green at head, so a break is
attributable): `T6` (a template chain still uses `agentos/<chainId>`, and a
`branchName` override still wins), `T6b` (a deferred template start preserves its
custom head and successor base), `T10` (an operator retry lands on the shared
branch), `T13`/`T14`/`T14a` (the non-template automatic-retry behaviour
`spec.md` acceptance 2 protects), and the test added by this batch.

Required regression: instantiate a multi-step template chain, put a run into the
upgrade state (`branch: null`), drive it through the real claim → start →
complete routes so the per-run fallback is persisted the way production
persists it, fail it retryably, and assert the next run's `branch` is the chain
branch — plus that its `targetBranch` still answers to the salvage the same
transaction recorded. Case B above is the exact scenario, and it currently
produces the wrong value, so the test falsifies the head as it stands.

## Recorded, non-blocking (P2)

Verbatim in `.chain/template-chain-retry-branch/reviews/opus-blind-findings.md`;
summarised here with their dispositions.

- **REC-01 / OPUS-1** — `packages/api/src/app.ts:4152-4154`. `resolveChain` is
  named as a predicate but evaluates to `{defaultBranch}|string|boolean|null`,
  forcing a duplicated `currentTask.repo` test on the next line purely for
  TypeScript narrowing. Fix: bind the narrowed repo instead of a pseudo-boolean.
- **REC-02 / OPUS-2** — `packages/api/src/app.ts:4152-4153`. The
  `currentTask.templateId ||` arm is unreachable: every writer of
  `Task.templateId` writes `chainIndex` beside it. It reads as a deliberate
  exemption from the isolation rule at `packages/db/src/workflow.ts:366-369`.
  Fix: `chainId && chainIndex !== null && repo`, matching `reconcile.ts:178`.
- **REC-03 / OPUS-3** — `packages/api/src/app.ts:4147-4151` vs `4158`. The
  surviving paragraph explains the argument on line 4164, not the `prior` on
  line 4158, and nothing documents what `prior` carries. **Rationale corrected:**
  B originally justified this as protecting a healing path; verification shows
  `run.branch` is the started workspace branch, not null, so the correct
  statement is that line 4158 hands `resolveRunBranches` the failed run's
  *workspace* branch — which is MFX-01. Fix: say what `prior` is and is not.
- **REC-04 / OPUS-4** — `packages/db/src/workflow.ts:310-316`.
  `resolveRequeueBase`'s docstring still claims the automatic retry in the
  completion transaction snapshots the failed run's base; template chains no
  longer reach it. A rejected the *behaviour* complaint (correctly — the spec
  directs it); the stale docstring is a separate, uncontested documentation
  defect. Fix: narrow the docstring, and record the trade at the call site.
- **REC-05 / OPUS-5** — `packages/api/src/chain-branch.dbtest.ts:674`. The added
  test carries no `T##` ID; all 28 others do. Fix: `T13b: …`, beside `T13`.
- **REC-06 / OPUS-6** — `chain-branch.dbtest.ts:703-706`. Acceptance 1's second
  clause is asserted against the test's own input: the publication route stores
  `body.pushedBranch` verbatim (`packages/api/src/app.ts:3624-3640`) with
  no reference to `run.branch`, so those two lines would pass with the fix
  reverted. Fix: assert `retryClaim.run.branch === chainBranch` before
  publishing.
- **REC-07 / OPUS-8** — `chain-branch.dbtest.ts:783`. The message "this path has
  never carried branch forward; that asymmetry is preserved" now describes a
  route that does carry `branch` forward. The assertion is still right; the
  sentence is not. Fix: scope it to the non-chain case.
- **REC-08 / SOL-001, single-step half** — `packages/db/src/workflow.ts:241-255,
  362`. A single-step template chain has no sibling task carrying a non-default
  `targetBranch`, so `templateChainBranch` yields no chain head and the retry
  inherits the per-run fallback (Case A above). Ruled P2 by Leo: such a chain has
  no chain branch to run on and no successor to clone, so the consequence is
  cosmetic. Recorded so it is not rediscovered as new. No fix required on this
  head; MFX-01's fix direction deliberately leaves this case as it is.

---

## Evidence common to both phases

Run by the coordinator at head `482e0b1`, fresh checkout (`npm install`,
`npm run db:generate`, `npm run build`):

- `npm run typecheck -w @agentos/api` — pass.
- `npm run lint:biome` — pass, 379 files. (`biome.jsonc:41` disables the
  formatter and `scripts/merge-gate.sh:1093` says formatting is deliberately not
  checked, so no formatting finding is raised by either report.)
- `npm run test:db -w @agentos/api` — **331/331 pass, 0 fail.**
- `npm run test -w @agentos/api` — 409 tests, 408 pass, 0 fail, 1 skipped.
- `npm run test:db -w @agentos/api -- src/chain-branch.dbtest.ts` with
  `packages/api/src/app.ts` reverted to the base blob — 28/29, the single failure
  being the added test. The added test is a genuine regression test.
- Report A independently records `MERGE GATE: PASS 482e0b1…` for the exact head.

So `spec.md` acceptance 1, 2 and 3 are all satisfied at head by execution. MFX-01
is a gap in the acceptance criteria, not a failure of them — which is why the
scope ruling above is a judgement and not a test result.
