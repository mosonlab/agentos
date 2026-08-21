# Opus blind review — blind review base pinning

Reviewer: review-coordinator-opus (AgentOS run cmt2e86p404l6mp456086dqy7)
Base: 2b64c33be4fa82226cc604a09cb210190cd8a4fa — resolved in tree as `2b64c33`
      "chore(snapshot): register the v0.2.0 README screenshots and release notes"
Head: 3ec72af3925d93be5e44951e1d53719e25bf2f11
      "chore(release): re-mint authority for blind review migration"
Range: `2b64c33..3ec72af` (4 commits: 40297df, edfc593, 132dfc5, 3ec72af)
Authority: `.chain/blind-review-base-pinning/spec.md` (the feature brief, copied verbatim by step 1)
Slices: none — direct chain.

Range caveat: `.chain/blind-review-base-pinning/sessions.md` does not exist on this
branch, so the labelled `implementation_range` entry my role names is unavailable.
The range above was reconstructed from git history — 2b64c33 is the last commit
preceding any chain work — and cross-checked against the spec's change list: every
one of changes 1-5 is present in `2b64c33..3ec72af` and nothing in that range is
unrelated to them. This gap is itself finding SPEC-1 below.

Written and committed before any predecessor review was opened.

## Verification run

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` (biome + eslint) | PASS |
| `npm test` (all workspaces) | PASS after `npm run build -w @agentos/web`; the two `apps/web` failures on a cold checkout are the suite's own "build apps/web first" guards, not the diff |
| `npm run test:db -w @agentos/api` | migration `20260821020000_blind_review_base_pinning` applies cleanly on a throwaway PostgreSQL; suite result recorded in the task output |
| `packages/runner` suite | 154/154 PASS, including the new pinned-workspace isolation test |

Not re-run: anything `scripts/merge-gate.sh` already owns.

---

## Standards axis

### STD-1 (P1) — the pin decision was added as three new copies outside `resolveRunBranches`, and the operator retry route was missed; it falls back to chain-branch HEAD

**Location** `packages/api/src/app.ts:2771-2784` (the miss), against
`packages/db/src/workflow.ts:504,514`, `packages/api/src/app.ts:4163-4172`,
`packages/api/src/reconcile.ts:177-185` (the three copies).

**Evidence** `resolveRunBranches`' own docstring, `packages/db/src/workflow.ts:359-364`:

> Decides a new Run's head (`branch`) and base (`targetBranch`). The only place
> that decision is made; `enqueueTaskRun`, `POST /tasks`, the operator retry
> route, the automatic retry in the completion transaction and the lost-lease
> requeue all call this, because five copies of the expression is how step ①
> ended up on a different branch from steps ②–⑨.

The pin is a base decision. It was implemented as a fourth, fifth and sixth copy
*outside* that function, and the route the docstring names by hand — the operator
retry — did not get one.

**Failure scenario** An operator retries a pinned blind-adjudication step.

1. `app.ts:2770-2771` calls `resolveRunBranches(tx, task, last)`. The task carries
   `templateId`, so `workflow.ts:376-387` returns
   `targetBranch = (await inheritedBase(...)) ?? ...`.
2. `inheritedBase` (`workflow.ts:294-327`) scopes to the whole chain for template
   steps and finds a run with `pushedBranch = <chain branch>` — step 1 published it —
   so it returns the chain branch name.
3. The new `Run` is written with `targetBranch = <chain branch name>`. Spec item 5's
   "No fallback to branch HEAD, ever" is already violated, at the row level.
4. The claim route, `app.ts:3511`, computes
   `pinnedBaseSha = templateStep.baseFromStepIndex == null ? null : run.targetBranch`
   — it trusts `targetBranch` to hold a SHA — so `pinnedBaseSha` is now a branch name.
5. `provisionWorkspace` (`workspace.ts:163-180`) runs
   `git fetch --no-tags origin <chain branch name>`. This **succeeds**, and pulls the
   entire chain branch history — every successor artifact — into the workspace object
   database. `git checkout --detach <chain branch name>` also succeeds.
6. `baseSha !== pinnedBaseSha` (a SHA versus a branch name) throws
   `Pinned workspace resolved …, expected agentos/…`. The run fails at provisioning.
7. The automatic retry at `app.ts:4163` then copies the poisoned value forward: its
   guard is `if (pinnedRetry && !run.targetBranch)`, and a branch name is truthy. Every
   remaining retry repeats steps 4-6 until `maxRunsPerTask` is exhausted.

Net effect: a pinned step can never be operator-retried, and each attempt defeats the
fetch-level isolation before failing. Two of the three symptoms — the DB-level fallback
to branch HEAD, and the chain branch's objects landing in a pinned workspace — are the
exact two things spec items 3 and 5 exist to prevent.

**Smell family** Change preventer (divergent change / shotgun surgery). The
classification is a judgement call; the retry defect is not.

**Fix direction** Move the pin into `resolveRunBranches` — it already receives the task
and the transaction, so it can take the `templateStep.baseFromStepIndex` +
`taskStepOutput.commitSha` lookup — and delete the three call-site copies. If the pin
must stay outside it, at minimum validate the SHA shape at the claim route
(`app.ts:3511`) so the fail-loud happens in the control plane instead of after the
runner has already fetched the branch.

### STD-2 (P2) — `pushStatus: "SUCCEEDED"` is fabricated for a pinned run that never pushed

**Location** `packages/runner/src/runner.ts:328-332`.

**Evidence** The same function already carries the honest value at
`runner.ts:365`: `delivery ?? { pushStatus: "NOT_REQUESTED" as const }`. The only
consumer, `const succeeded = executionSucceeded && delivery?.pushStatus !== "FAILED"`
(`runner.ts:358`), treats `NOT_REQUESTED` and `SUCCEEDED` identically, so nothing is
gained by the lie. And `packages/db/src/workflow.ts:400-420` spends twenty lines
documenting that `pushStatus` "lies in both directions" and is precisely why
`pushedBranch` is the only publication evidence the chain resolver will read.

**Failure scenario** An operator (or any future consumer that does read
`pushStatus === "SUCCEEDED"` as "a ref exists on the remote") reads a pinned review
run's record and concludes a push happened. None did; there is no `pushedBranch`.

**Fix direction** `pushStatus: "NOT_REQUESTED"`, keeping `pushRemote` and
`deliveryInstructions` as they are.

### STD-3 (P2) — the base-reference rule is implemented four times, in three wordings

**Location** `packages/api/src/templates.ts:52-64`;
`packages/db/src/template-sources.ts:147-153`; `packages/api/src/app.ts:1778-1787`;
`packages/api/src/app.ts:1812-1821`.

**Evidence** All four enforce the same two rules — "must exist in this template" and
"must be strictly earlier" — with three different message texts
("does not reference the same template" / "must reference a strictly earlier stepIndex"
/ "must reference an earlier step of the same template"). `template-base-pinning.dbtest.ts`
and `templates.test.ts` each pin a different wording, so the wordings are now load-bearing
in two suites.

**Failure scenario** A sixth call site is added (a template-step delete route, a bulk
import) and enforces zero or one of the two rules; the divergence is invisible because
no single place owns the rule.

**Smell family** Duplicated code / shotgun surgery. Judgement call.

**Fix direction** One exported predicate in `@agentos/db` beside `templateStepStructureDifferences`,
returning a typed error, called from all four sites.

### STD-4 (P2) — the commit-SHA shape is copied into four files, in an obscure spelling

**Location** `packages/api/src/app.ts:553`; `packages/db/src/workflow.ts:143`;
`packages/runner/src/mcp-server.ts:76`; `packages/runner/assets/pi-agentos-extension.ts:33`.

**Evidence** `/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u` in all four. The
`{40}(?:…{24})?` construction spells "40 or 64 hex" by arithmetic; a reader has to add
40+24 to see that the second alternative is a SHA-256 object id.

**Failure scenario** SHA-256 repositories, or a future abbreviated-SHA allowance,
change three of the four and miss one; the surviving copy rejects a SHA the other three
accept, at a different layer.

**Fix direction** One exported constant shared by `app.ts`, `workflow.ts` and
`mcp-server.ts`, spelled `(?:[0-9a-f]{40}|[0-9a-f]{64})`.
`pi-agentos-extension.ts` is required to stay dependency-free (its own file header
says so), so its copy is legitimate — but it should carry a comment saying which
constant it mirrors.

### STD-5 (P2) — `workspaceHead` blocks the MCP server's event loop

**Location** `packages/runner/src/mcp-server.ts:75-83`, called from the async
`invokeTool` at `mcp-server.ts:238`.

**Evidence** `execFileSync` inside the request path of a JSON-RPC server. The runner
package ships with no runtime dependencies, but `node:util.promisify(execFile)` is a
built-in and needs none.

**Failure scenario** A slow or hung `git rev-parse` (a large repository, a stalled
filesystem) stalls every concurrent MCP request, not just `task_output`.

**Smell family** Judgement call — the surface is eight tools and the call is short.
The `pi-agentos-extension.ts` copy is more defensible: that file is loaded by pi's own
loader and is explicitly self-contained.

**Fix direction** `promisify(execFile)` in `mcp-server.ts`; leave the extension alone.

### STD-6 (P2) — the pinned guard was applied to the success delivery path but not the failure one

**Location** `packages/runner/src/runner.ts:334-347` (the `else` branch), against
`runner.ts:324-332` (the guarded branch).

**Evidence** The guarded branch carries the reason:

> A pinned review started from an object-id-only detached checkout. It produces a
> platform output, not a branch artifact, so publishing it would either create a
> forbidden local chain ref or overwrite the chain from an intentionally stale base.

Every word of that applies to `deliverFailedWorkspace`, which `git add -A`, commits and
pushes `agentos/<taskId>/run-<n>` (`packages/runner/src/delivery.ts:410-448`).

**Failure scenario** A pinned blind review fails after writing a scratch file. Salvage
commits it on top of the pinned base and publishes a branch. `delivery.ts:435`
(`if (head === workspace.baseSha) return null`) makes this a no-op in the common case
where the reviewer wrote nothing tracked, which is why this is P2 and not higher — but
the case it does not cover is exactly a reviewer who wrote a report file, which the old
protocol told it to do and which a resumed or stale prompt may still tell it to do.

**Fix direction** Hoist the `workspace.pinnedBaseSha` check above the
success/failure split so both delivery paths short-circuit.

### STD-7 (P2) — a pinned step records its *base* as its `commitSha`

**Location** `packages/api/src/app.ts:4259-4266` and
`packages/runner/src/workspace.ts:275-284`.

**Evidence** `captureWorkspaceResult` returns `headSha` from `git rev-parse HEAD`, which
for a pinned detached workspace that publishes nothing is the pinned base itself.
Completion then writes `commitSha: body.headSha`. Spec item 1 calls this field "the head
SHA when persisting a step's output", and `pinnedBaseCommitSha` reads it as "the recorded
end commit of that earlier step" (`workflow.ts:113-146`).

**Failure scenario** A future template pins step N to a step that is itself pinned. The
resolved base is silently the *first* pinned step's base — two hops back — rather than
that step's end commit. Nothing does this today, which is why it is P2.

**Fix direction** Either refuse `baseFromStepIndex` pointing at a step that itself
carries `baseFromStepIndex` (one line in the shared predicate of STD-3), or state in the
schema comment that `commitSha` is "the commit this step's work was based on and ended
at", which is the honest description of what the field now holds.

---

## Spec axis

### SPEC-1 (P1) — the pinned blind reviewer has no way to establish the implementation base

**Governing specification text** (`.chain/blind-review-base-pinning/spec.md`):

> 3. Runner checkout for a pinned step is fetch-level isolated: fetch only that commit
>    (git fetch origin <sha>, detached checkout); the chain branch ref is never fetched
>    into the workspace.

> 4. Review-step reports come off the chain branch — one cut, all review steps: reports
>    persist only via the TaskStepOutput endpoint; adjudication and fix steps read
>    predecessor reports from step outputs, not from files on the branch.

**Evidence**

- The pinned workspace holds zero refs. The change's own test asserts it:
  `packages/runner/src/workspace.test.ts:107`,
  `assert.equal(git(workspace.path, "for-each-ref", "--format=%(refname)"), "")`.
- The pinned step's claim carries no prior outputs:
  `attachmentsFromPrevious: false` at
  `agents/templates/direct-engineer-workflow/03-code-review-and-adjudication-opus.md:7`
  and `agents/templates/compound-engineer-workflow/07-code-review-and-adjudication-opus.md:7`,
  which `packages/api/src/app.ts:3483-3490` honours by returning `priorOutputs: []`, and
  `packages/runner/src/adapters.ts:45-49` therefore omits the section from the prompt.
- Predecessor outputs are revealed only *after* the blind write:
  `packages/api/src/app.ts:3843-3860`.
- The base's previous carrier was deleted in this same diff.
  `agents/roles/review-coordinator-sol.md` lost
  "Write them as a labelled `implementation_range` entry in
  `.chain/<chain branch>/sessions.md`, committed with your report, so the blind reviewer
  reads the range without opening your findings", and
  `agents/roles/review-coordinator-opus.md` lost the matching read. Its replacement
  defers the range to after the blind review: "then read the implementation range and
  first review from those platform outputs".

So between claim and blind write the reviewer knows exactly one commit: `HEAD`. It
cannot compute `base...head`. Meanwhile the unchanged half of its own role prompt still
requires "Review that complete integrated diff and resulting tree", and
`review-coordinator-sol.md:14` still requires refusing "an ambiguous or drifting range".
The change made the mandated range unobtainable at the moment it is mandated.

**Failure scenario** This session. The step-1 workspace was not pinned (the platform
predates the change), yet `sessions.md` was absent and the range had to be reconstructed
from `git log` — the very "ambiguous or drifting range" the role forbids. On a platform
that *has* shipped this change the reviewer's position is strictly worse: no chain-branch
ref, no `origin/*`, no prior outputs, no `sessions.md`, and history it cannot anchor.
The blind review either proceeds against an invented base or degrades to a tree read.

**Fix direction** Carry the implementation base into the pinned claim. The claim route
already computes the chain's durable base at `packages/api/src/app.ts:3510`
(`pullRequestBase`); expose it to a pinned claim as an explicit `implementationBaseSha`
and add it to the fetch — `git fetch --no-tags origin <base> <pinned>`. Fetching one
extra commit by object id creates no ref and makes nothing on the chain branch
reachable, so spec item 3 is preserved exactly. Alternatively record the implementation
step's base next to its `commitSha` and interpolate it into the pinned step's prompt.

### SPEC-2 (P1) — the active governance contract still mandates the artifact route this change removes

**Governing specification text** (`.chain/blind-review-base-pinning/spec.md`):

> 4. Review-step reports come off the chain branch — one cut, all review steps: reports
>    persist only via the TaskStepOutput endpoint … Update the direct-engineer-workflow
>    and compound-engineer-workflow review/adjudication/fix step prompts accordingly

**Evidence** `docs/governance/task-routing-v1.md` declares itself
`Version: 1.0` / `Status: Active` and calls itself "the authoritative chain table for
this contract". It still says, at line 62:

> ⑥a 代码评审（Sol 路） … findings 按正典 finding 结构落 docs/reviews/<chain>/sol-findings.md 并推链分支

and at line 63:

> ⑥b 代码评审+终裁（Opus 路） … 盲审：先独立完成两轴评审（Standards/Spec）并落盘，再读⑥a … session-id 落链分支文件

and at line 65:

> ⑥c 回归核销 … 优先 resume ⑥b（显式 session-id）

All three describe the branch-artifact route the change physically forbids. The diff
updated `agents/roles/*` and `agents/templates/**`, which are the *implementations* of
this contract, and left the contract itself contradicting them.

`AGENTS.md`'s "Records that do not change" freeze covers `docs/reviews/`,
`docs/merge-notes/`, `docs/briefs/` and `docs/plans/archive/` — not `docs/governance/`.
This document is live, editable authority, so leaving it stale is a choice, not a
constraint. `AGENTS.md` also notes that the gate cannot decide "whether a document that
*should* carry a supersession marker does: that half stays human" — which is why this
belongs in a review finding rather than in CI.

**Failure scenario** The next chain author, or the next operator debugging a review
step, reads the Active contract and re-introduces `docs/reviews/<chain>/sol-findings.md`
on the chain branch — reinstating the exact root cause the spec's Background section
identifies ("Review reports living on the branch is the root cause"). The out-of-scope
note in the brief says a separate backlog task *depends on this change having removed
review artifacts from the branch"*; a contract that still mandates them is a live path
back.

**Fix direction** Update rows ⑥a/⑥b/⑥c and the "Review structure" paragraph of
`docs/governance/task-routing-v1.md` to name the TaskStepOutput route and the pinned
base, in this change.

### SPEC-3 (P2) — the exact-resume handle was removed and replaced with something the agent cannot obtain

**Governing specification text** — the unchanged half of
`agents/roles/review-coordinator-opus.md`, which this diff kept verbatim:

> When resuming the blind-review session for regression verification, use its explicit
> persisted session ID. Never select a session by recency.

**Evidence** The diff replaced
"Record this session's id under the label `opus_blind_review` in
`.chain/<chain branch>/sessions.md`" with
"Include this review session's provider id in the platform output when it is available".
No tool exposes that id: the MCP surface is the eight tools in
`packages/runner/src/mcp-server.ts`, and `/session/runs/:runId/status`
(`packages/api/src/app.ts:3775-3807`) returns run and task fields only. The platform does
hold it — `session.providerConversationId` is read at `packages/api/src/app.ts:3423` for
the runner's own resume — but never hands it to the agent. So "when it is available"
resolves to "never", and every regression-verification step silently takes the documented
new-session fallback.

**Repository standard** `AGENTS.md`'s companion rule set: "Let real failures surface:
never silently fall back to a degraded path, default value, or swallowed exception for
errors that can actually occur". The hedge makes a permanent degradation look conditional.

**Failure scenario** Nothing breaks — which is the point. Step ⑤/⑨ never resumes the
adjudicator's session, permanently, and no signal says so.

**Fix direction** Return `providerConversationId` from `/session/runs/:runId/status` (one
field; the row is already loaded), or delete the exact-resume requirement from the role
prompt in the same change rather than leaving a requirement no path satisfies.

### SPEC-4 (P2) — item 3's isolation is proved only against a transport that cannot reject it

**Governing specification text**

> 3. … fetch only that commit (git fetch origin <sha>, detached checkout)

**Evidence** `packages/runner/src/workspace.test.ts:66-118` builds a local bare
repository and fetches by object id. Local transport allows any object id
unconditionally. Over smart HTTP or SSH — what `Repo.remoteUrl` actually points at —
`git fetch origin <sha>` requires the server to advertise
`allow-reachable-sha1-in-want` or `allow-tip-sha1-in-want`. GitHub.com does. A
self-hosted or mirrored remote may not, and the failure mode is every pinned step failing
at provisioning with a bare `git fetch` error and no explanation of the requirement.

**Failure scenario** An installation pointed at a self-hosted Git server with default
`uploadpack` settings: the whole review phase of every chain fails at provisioning.

**Fix direction** Not necessarily code. Name the assumption where the operator will meet
it — the migration note or the runbook — or catch the fetch failure in
`provisionWorkspace` and re-raise it as "the remote does not allow fetching by object
id, which pinned review steps require". Judgement call on whether it is worth code.

### SPEC-5 (P2) — the required-`commitSha` half of item 5 has no test

**Governing specification text**

> 1. Record each step's end commit: add `commitSha String?` to TaskStepOutput; the
>    runner reports the head SHA when persisting a step's output.
> 5. Fail loud: if a pinned step activates and the referenced step has no recorded
>    commitSha, activation fails with an explicit error.

**Evidence** `packages/api/src/app.ts:3840-3842` rejects a non-mechanical step output
that carries no `commitSha` with a 400. That guard is what makes item 5's activation
check reachable at all — without it, steps record `null` and every pin fails. It has no
test. `chain.dbtest.ts:824-856` covers the activation side; `run-output.dbtest.ts` and
`blind-claim.dbtest.ts` were only edited to *supply* `commitSha`, so they would still
pass if the guard were deleted.

**Failure scenario** The guard is removed or its `executionMode !== "mechanical"`
condition drifts; steps silently record `commitSha: null`; the defect surfaces one step
later as `referenced step has no recorded commitSha` on a chain that ran fine yesterday.

**Fix direction** One dbtest: a non-mechanical step's output without `commitSha` is 400,
and the mechanical merge step's output without one is 200.

---

## Confirmed correct

Recorded because a later reviewer should not re-litigate them.

- `chainIndex` equals `stepIndex` for instantiated templates
  (`packages/api/src/templates.ts:175`), so `pinnedBaseCommitSha`'s
  `chainIndex: baseFromStepIndex` lookup (`workflow.ts:126-135`) is sound despite
  validation being expressed in `stepIndex`.
- `pullRequestBase` cannot be poisoned by a pinned run: the strictly-earlier rule makes
  step 1 unpinnable, and `chainFirstRun` (`app.ts:3470-3482`) orders by
  `chainIndex asc`.
- Publication evidence cannot be poisoned either: the pinned success path emits no
  `pushedBranch`, and `resolveRunBranches` reads only that field
  (`workflow.ts:426-435`).
- `.agentos/session.json` is still excluded from a pinned workspace:
  `writeSessionCredentials` appends `/.agentos/` to `.git/info/exclude`
  (`workspace.ts:264,269`) for every workspace, and `git init` creates that file.
- A repo-less run can never reach `workspaceHead`: the claim route skips candidates
  with no repo (`app.ts:3354`).
- The merge executor is exempt correctly: it sends no `commitSha`
  (`packages/merge-executor/src/agentos.ts:127-133`) and the server exempts mechanical
  steps (`app.ts:3840`).
- Every template step markdown carries the new required `baseFromStepIndex` frontmatter;
  there is no third template directory that `loadTemplateStepSources` would now reject.
