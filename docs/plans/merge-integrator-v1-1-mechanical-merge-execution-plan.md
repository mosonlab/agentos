# Merge Integrator v1.1 — Implementation Plan (Step 10, Mechanical Merge Execution)

Plan for GitHub issue #100, "Merge Integrator v1.1 after approval-policy
convergence". **Revision 2** — produced from the approved SPEC
`docs/specs/merge-integrator-v1-1-mechanical-merge-execution.md` revision 3
(commit `145731947eb7b9af460b2e48da8141f1c69dce27`), revising the failed plan
at `75a2802d28c3e90b2e0eae0ccac469b2c8a198f2` against its consolidated review.

**Base revised against:** master `485fb118db96e3977006a2edc866a38b751ff0e2`.
The prior plan was written against `a4a4ba36c116c775d5d1c28ed55b17600869d904`.
`git diff --stat a4a4ba36 485fb118` returns exactly six files, all under
`docs/` (the Goal 5a0 and Inbox 3a spec/plan/review documents merged as PRs
#94 and #95); no file under `packages/`, `apps/`, `scripts/`, `agents/`,
`deploy/`, or `.env.example` differs. Every `file:line` anchor the review
cited at `a4a4ba3` therefore holds byte-identically at master, and every
anchor in this document was re-read at `485fb118` before being written.

**This plan grants nothing.** It does not authorize implementation, merge,
migration, template activation, credential provisioning, service restart,
launchd operations, or any production action. Implementation authority for
this work arrives only with an approved revised Plan under the Planned
Critical route (`docs/governance/task-routing-v1.md`, "Human approval
placement"); production activation of the ten-step template is separately
authorized (SPEC §6.3); provisioning the dedicated merge identity, its OS
principal, and its secret store is a separately executed operator
prerequisite (SPEC §2, Dependencies); and no merge of any pull request is
authorized by any document — only by a step-9 human exact-head authorization
at execution time.

## Routing snapshot

```text
Routing Contract: v1.0
Route: Planned Critical
Implementation Agent: senior-dev
Reason: Merge execution is a production/release gate touching idempotency,
concurrency, control-plane ownership, and durable data correctness — Critical
by definition in task-routing-v1. A written Plan is required because
sequencing, recovery after partial execution, and coordination with the
template/seed/verifier contract cannot be implemented safely from the
contract alone.
```

## Product Contract (carried from the SPEC, unchanged)

- **Contract ID / version:** `PC-MERGE-INTEGRATOR-1.1`, version 1.2.
- **Objective:** extend the Full Assurance workflow from nine steps to ten so
  the merge of a chain's pull request is executed mechanically under a prior
  human exact-head authorization, with every safety precondition re-verified
  at execution time, and with every deviation stopping fail-closed into
  renewed human authorization.
- **In scope:** the step-10 behavioral contract (SPEC §3); stop conditions
  and control-plane stop/resume semantics (§4, §4.0); idempotency and replay
  (§5); merge-credential custody and the mechanical execution mode (§5.2);
  template change acceptance semantics (§6) with non-publication execution
  (§6.1); authorization production on both approval channels (§8.2); the
  narrowed chain-relative read path carrying the server-resolved chain target
  identity (§8.4).
- **Out of scope:** the step-9 human judgment itself; production migration or
  activation; AgentOS credential/auth-model changes; GitHub Actions/CI; other
  templates; TaskActivity schema changes; post-merge incident remediation
  beyond recording the human's decision; implementation/merge/activation
  authority (SPEC §10).
- **Acceptance criteria:** the five criteria of SPEC §2, verbatim.
- **Required evidence:** SPEC §7 directions N1–N24 demonstrated, with N1, N3,
  N17(b), N21 and the extended N23 run against real infrastructure, plus one
  positive end-to-end demonstration of criterion 1 (Step 10 of this plan).
- **Risks / authority boundaries / stopping conditions / dependencies:** as
  SPEC §2; this revision changes none of them. Step 9 (a human) remains the
  only merge-approving authority; the integrator holds execution authority
  only; the control plane owns task status transitions; any downshift of
  route, effort, or safeguards requires a new Product Contract version and
  product-owner approval.

**No Product Contract version bump is required by this revision.** Every
change below conforms the plan to the approved SPEC or strengthens a
mechanism the SPEC already requires. No objective, scope boundary, acceptance
criterion, required evidence item, authority boundary, or risk boundary
moves. Two additions deserve to be named explicitly so a reviewer can check
that judgment rather than take it: this plan adds a second control-plane
route (`POST /tasks/:taskId/merge-target`, §D-P8) and a second deployed
process (`@agentos/merge-executor`, §D-P1). Both fall inside boundaries the
SPEC already places in scope — "control-plane stop/resume semantics …
including the concrete re-authorization mechanism" (§2, §4.0) and "custody of
the merge credential and the mechanical execution mode … where merge
authority physically resides, which process holds the credential" (§2, §5.2)
— and neither adds a principal or token class (SPEC §10).

---

## 1. What this revision changes, and why

The prior plan received one Sol Medium review at head `75a2802d`, verdict
**FAIL**: nine must-fix findings, three should-fix, three contradictions,
`fitToAuthorizeImplementation false`. The review also re-verified the prior
plan's claim that all ten carried must-fix findings (X1–X10) closed and all
five should-fix (Y1–Y5) were adopted, and found six of the fifteen did not
hold: **X1, X4, X5, X10, Y2, Y4**.

Two rules govern this revision:

1. **Where the plan and the SPEC disagree, the SPEC governs.** All three
   contradictions are resolved by conforming the plan, not by weakening the
   contract. None of the three resolutions was found impossible; each has a
   named mechanism below.
2. **No closure is claimed that was not re-verified against real source at
   master.** §2 lists what was re-read and what was found. Where a fact could
   not be verified in this session, it is marked as unverified and carries a
   named mechanism that fails loudly rather than an assertion (§D-P6, §11).

### 1.1 Must-fix disposition ledger

| # | Finding | Resolution | Where |
|---|---|---|---|
| MF-1 | Credential custody does not hold at the OS boundary | Merge authority moves out of the runner process entirely into a separate package, process, and OS principal, with a hard startup isolation gate evaluated before the credential is read; N23 becomes a live cross-principal negative | §D-P1, Step 6, Step 9 |
| MF-2 | Decision binding is presence-only and forgeable through the operator activity route | Selection is anchored in server-only rows and validated server-side (decision row identity, gate-card identity, winning choice, immutable snapshot equality, no reuse); only server-validated records are returned; the PATCH channel gains a real `InboxDecision` row | §D-P2, Steps 2, 3 |
| MF-3 | Renewed authorization is temporally invalid and wired through the wrong process boundary | One two-phase evidence protocol for both the initial gate and every renewal: a bounded, cancellable server-side read outside any transaction fills an OPEN card the human sees; a later answer copies that exact stored snapshot in one pure-DB transaction, in either process | §D-P3, Steps 2, 4 |
| MF-4 | The "non-LLM Agent" sentinel remains dispatchable as a normal model Agent | A bidirectional binding invariant enforced at every creation, reassignment, template, scheduler, retry, and claim surface, failing closed before run creation and before any model spawn; hidden from ordinary agent selection | §D-P4, Steps 7, 6 |
| MF-5 | X5 does not prove only human re-authorization can exceed the run ceiling | Automatic ceiling compensation is disabled for integrator steps: no automatic path may raise `maxRunsPerTask`, so the answer transaction is the only writer of a ceiling above the task's original | §D-P5, Step 4 |
| MF-6 | X10 defers the load-bearing platform binding to implementation | The executor binds GitHub REST + GraphQL directly, with exact queries, fields, accepted values, bounded polling, the dequeue mutation, post-disarm readback, and behavior for every null/unknown/permission error — plus a schema-introspection gate that fails the build if any named field or enum drifts | §D-P6, §11, Step 6 |
| MF-7 | Stop exclusivity is bypassed after flag-incident | Answers carry an explicit **disposition**; the guard keys on a terminal disposition, not on answer existence; `flag-incident` creates a fresh OPEN follow-up question that actually offers the later exits | §D-P7, Steps 4, 5 |
| MF-8 | `target-unresolvable` has no executable repair path | `re-authorize` is removed from 4.14; a durable, authenticated target-correction record written through a dedicated operator route (constrained to PR numbers the chain's own runs recorded) is the repair, and it re-enables authorization through the same confirmation-card path | §D-P8, Steps 3, 4 |
| MF-9 | The required positive end-to-end acceptance demonstration is not planned | A new isolated scratch-repository system test drives card → real-channel approval → claim → guarded merge → completion → remote verification, and records base/head/merge SHAs and the absence of publication side effects | Step 10 |

### 1.2 Contradiction disposition

| # | Contradiction | Direction | Resolution |
|---|---|---|---|
| C1 | SPEC: the credential lives only in the executor's process and no agent session ever holds it. Plan: runner process config, executor in-process, same process spawns every model CLI | Plan conforms | §D-P1: separate package, process, OS user, and secret store; the runner never holds the credential and can never receive an integrator run |
| C2 | SPEC: re-authorize is a human judgment against fresh evidence *presented in the question*. Plan: the snapshot is read at answer time | Plan conforms | §D-P3: the refresh precedes the question; the answer copies a snapshot the human already saw and performs no network I/O |
| C3 | Plan: the stop answer is the only exit and the guard holds while no `stopAnswer` exists — but `flag-incident` writes a `stopAnswer`, stays REVIEW, and the original question offers no abandon | Plan conforms | §D-P7: dispositions replace answer-existence; `flag-incident` is nonterminal and spawns a follow-up question carrying `accept-foreign-merge` / `abandon` |

### 1.3 Should-fix disposition

All three are **adopted**; none declined.

| # | Finding | Adopted as |
|---|---|---|
| SF-1 | Stopped and incident runs read as green "Succeeded/Done" in every run-centric UI | Step 8: run/session DTOs expose a server-parsed merge outcome; `RunPill`, `sessionPill`/`lifecycleStat`, and the board card render **Stopped** / **Incident** while the protocol status stays `SUCCEEDED`; UI tests for a pre-merge stop and a post-merge incident |
| SF-2 | Live GitHub reads sit inside lock-holding transactions with no latency bound | Folded into §D-P3: every GitHub read is a strictly timed, cancellable prefetch outside any transaction; a nonce-versioned snapshot is persisted; the write transaction is a short CAS on that snapshot; timeout and concurrent-approval tests are named |
| SF-3 | The seed edit is left as "wherever" despite a known file and a field omission | Step 7: `packages/db/prisma/seed.ts:200-218` named exactly, the step tuple and its type gain `opensPullRequest`, both the `create` and `update` branches of the `taskTemplateStep.upsert` at `seed.ts:216-217` set it, and a fresh-seed negative asserts the seeded value **before** the verifier assertion is relied on |

### 1.4 Consequential edits these fixes force

Named here so a reviewer can see that nothing changed beyond what the
findings require:

1. **The executor's platform binding moves from the `gh` CLI to direct
   REST/GraphQL.** Forced by MF-1 (the custodial process spawns no child
   process, so a token can never reach a child environment or an argv) and by
   MF-6 (exact fields and values are unexpressible in `gh`'s output surface;
   `gh` 2.89.0 has no queue-removal command at all — verified below). `gh`
   survives only in the operator-run evidence harness, where N17(b) needs a
   real `gh pr merge --admin` refusal.
2. **The gate-card evidence snapshot moves from `InboxMessage.metadata` to
   the card body.** Forced by MF-2's server-only-anchor requirement *and* by
   fact: `model InboxMessage` (`packages/db/prisma/schema.prisma`) has **no
   `metadata` column**. The prior plan's Step 2 wrote to a field that does not
   exist, and adding one is a Prisma migration, which SPEC §3 forbids.
3. **`gateQuestion` performs no GitHub read at all; the initial gate uses the
   same two-phase protocol as renewal.** Forced by MF-3's topology finding,
   which applies to the *initial* gate too: `gateQuestion` is called from
   `activateChainSuccessor`, which runs inside `applyInboxDecisionTx` in the
   separate `@agentos/inbox` process — so an API-server-only GitHub reader was
   unreachable there as well. Also forced by SF-2.
4. **The PATCH approval channel gains a real `InboxDecision` row** for
   integrator gates only. Forced by MF-2/Y4: "the closed gate-card set plus a
   status-change activity id" is not a durable named decision row and is
   partly forgeable through `POST /tasks/:taskId/activity`.
5. **Automatic external-failure ceiling compensation is disabled for
   integrator steps.** Forced by MF-5.
6. **Step 6 splits into a new workspace package, a launchd unit, and a hard
   refusal added to the ordinary runner.** Forced by MF-1.
7. **A new operator route `POST /tasks/:taskId/merge-target`.** Forced by
   MF-8.
8. **A new UI step (Step 8) and a new system-test step (Step 10).** Forced by
   SF-1 and MF-9. The plan now has eleven steps.

---

## 2. Re-verification of the fifteen carried findings, at master

Re-read at `485fb118` in this session. "Closed at" names the section of *this*
revision that carries the obligation; nothing below restates a closure the
prior plan claimed without this session re-reading the source.

| Finding | What was re-read at master | Prior verdict | Verdict now | Closed at |
|---|---|---|---|---|
| X1 credential custody | `adapters.ts:52-62` (`buildChildEnvironment` spreads `claim.secrets`), `runner.ts:136-168` (same process spawns adapters), `.env.example:40-46` (`RUNNER_RUN_AS_PREFIX=` empty by default, with the shipped comment "model CLIs run as the runner's OS user"), `docs/wiki/batch-files-runtime-security-boundary.md:8-19` (same-uid shell can read any accessible file outside the workspace), `app.ts:2956` (reserved-variable check covers five names only) | claimed closed | **was FAIL; now closed** — the prior design proved non-inheritance, not unreachability | §D-P1, Step 6, Step 9 |
| X2 target independence | `app.ts:3193-3215` (session status returns task fields only, no PR fields), `app.ts:2977-2983` (claim `priorOutputs` selects `kind`/`body` only) | closed | **holds; strengthened** — the resolution rule now also has an executable repair for its failure mode | Step 3, §D-P8 |
| X3 fabricated output → DONE | `app.ts:3487-3494` creates a `TaskStepOutput` with `kind: run.task.templateStep?.outputKind` and body `Run N completed successfully.`; `app.ts:3496-3497` → `advanceTemplateTask` | closed | **holds** | Step 4 |
| X4 generic operator exits | `app.ts:2378-2440` retry (`app.ts:2402` "Run budget exhausted"), `app.ts:2282-2338` PATCH REVIEW→DONE with `activateChainSuccessor` at `app.ts:2337` | claimed closed | **was FAIL; now closed** — the guard predicate keyed on answer existence, which `flag-incident` satisfies | §D-P7, Step 5 |
| X5 run budget vs re-authorization | `workflow.ts:349` copies `task.maxSessionsPerTask`; `app.ts:2402`; `runner.ts:102` refuses at claim when `runNumber > maxRunsPerTask`; **and `app.ts:3370` `budgetCeiling = run.maxRunsPerTask + (external ? 1 : 0)` with `app.ts:3468` writing `maxRunsPerTask: budgetCeiling` onto the retry row** | claimed closed | **was FAIL; now closed** — the automatic path can raise the ceiling repeatedly on external failures | §D-P5, Step 4 |
| X6 replay laundering | design-level; `gh pr merge --help` at 2.89.0 offers `--match-head-commit` and no base equivalent (re-verified this session) | closed | **holds**; the parent check now also binds the REST binding | Step 6 |
| X7 publication path | `runner.ts:227-239` invokes delivery after success; `delivery.ts:112-117` "The push is unconditional"; `delivery.ts:147-161` adopts an existing open PR | closed | **holds; strengthened** — the executor is a different process that contains no delivery code at all | Step 6, Step 10 |
| X8 activity-browser read | `auth.ts:51` path scoping; the session surface is exactly `app.ts:3180, 3184, 3218, 3236, 3271+` | closed | **holds** | Step 3 |
| X9 undefined invalidation record | design-level | closed | **holds** — no invalidation concept anywhere below | Steps 1, 6 |
| X10 merge-queue deferral | `gh pr merge --help` at 2.89.0 (re-run this session): documents queue enqueue and auto-merge enablement, offers `--disable-auto`, and offers **no queue-removal flag of any kind** | claimed closed | **was FAIL; now closed** — the prior plan named no query, no values, and no removal operation, and `--disable-auto` cannot remove a queue entry | §D-P6, §11 |
| Y1 lost stop artifacts | `schema.prisma` `model TaskStepOutput` (`taskId @unique`); `app.ts:3229-3234` session output write is an upsert | adopted | **holds** | Step 6 |
| Y2 post-merge incident executability | `app.ts:2282-2338` PATCH can move REVIEW→DONE; SPEC 4.13's `flag-incident` is nonterminal; SPEC 4.14's resume names no mutation | claimed adopted | **was FAIL; now adopted** — both 4.13 and 4.14 had non-executable resume paths | §D-P7, §D-P8 |
| Y3 human sees the SHA | `workflow.ts:376-390`: the gate card body carries only the PR URL and a 1,000-char output preview | adopted | **holds; strengthened** — presented equals recorded *by identity*, because the card body block **is** the payload source | §D-P2, §D-P3 |
| Y4 PATCH-channel decision identity | `workflow.ts:838-844` is the only `inboxDecision.create` in the codebase; the PATCH channel's CAS is `app.ts:2313-2316` plus the status activity at `app.ts:2330-2332`; `app.ts:2717-2727` accepts arbitrary metadata under a server-stamped `actorType: "operator"` | claimed adopted | **was FAIL; now adopted** — the chosen binding was forgeable through the generic activity route | §D-P2, Step 2 |
| Y5 verifier bound | `verify-agent-template.ts:55` bounds the runner-inheritance check at `stepIndex <= 8`; no row's `opensPullRequest` is checked anywhere; `agent-contract.ts:15-25` holds nine rows; `assertCanonicalAgentSources` at `agent-contract.ts:37-57` requires exact name-set equality | adopted | **holds; extended** by SF-3's seed fix | Step 7 |

**Additional facts re-verified at master that the prior plan asserted
incorrectly or did not know:**

- `model InboxMessage` in `packages/db/prisma/schema.prisma` has **no
  `metadata` column** (fields are `id, from, agentId, sessionId, taskId,
  goalId, gateTaskId, threadId, replyToMessageId, kind, body, choices,
  selectedChoiceId, status, channel, dedupeKey, externalMessageId,
  externalActionId, deliveryStatus, deliveryAttempts, nextDeliveryAt,
  deliveredAt, lastDeliveryError, createdAt, answeredAt`). The prior plan's
  Step 2 wrote the evidence snapshot to a field that does not exist.
- **`gateTaskId` is written by exactly one code path**, `gateQuestion` at
  `packages/db/src/workflow.ts:382`. No API route creates an `InboxMessage`
  with a caller-supplied `gateTaskId`: the only other creators are
  `app.ts:2837` (runner preflight alert), `app.ts:3540` and `app.ts:3562`
  (budget-exhausted and circuit-open notices), `workflow.ts:821` (the decision
  reply), and `inbox/src/events.ts:65` (an inbound Feishu message). A gate
  card and its `body` are therefore a **server-only** surface — the anchor
  §D-P2 needs.
- **`actorType: "control-plane"` is not client-producible.** `POST
  /tasks/:taskId/activity` forces `actorType: "operator"`
  (`app.ts:2722`); `appendFencedActivity` stamps `principal.kind`
  (`app.ts:3172`), which for a session token is `"session"` (`auth.ts:44`).
  Control-plane activities are written only by server-internal code.
- `@agentos/db` depends on `@prisma/client` only, and `@agentos/inbox` depends
  on `@agentos/db` only (`packages/db/package.json:32-39`,
  `packages/inbox/package.json:14-18`) — so `@agentos/db` cannot import
  `@agentos/api`, confirming MF-3's topology finding.
- The API process already runs a background loop (`startScheduler(prisma)` at
  `packages/api/src/index.ts:142`, with `schedulerTick` in
  `packages/api/src/scheduler.ts`) and holds single-instance control-plane
  ownership. §D-P3's evidence worker attaches there rather than inventing a
  process.
- `deploy/` already ships a second long-lived launchd service
  (`com.agentos.inbox.plist`) alongside `com.agentos.runner.plist` and
  `com.agentos.api.plist`. §D-P1's third service follows an existing shape.
- `Run.agentId` is `String` (non-nullable) in `model Run`, and
  `activateChainSuccessor` turns any non-`AGENT`-assigned successor into a
  gate question (`workflow.ts:630-641`) — so the prior plan's reasoning that
  step 10 needs a real Agent row stands, and MF-4 must be closed by an
  invariant rather than by removing the row.
- `packages/api/src/templates.ts:118-134` copies `step.opensPullRequest` onto
  each materialized task row, so SF-3's seed omission is load-bearing for
  every instantiated chain, not only for the verifier.

---

## 3. Design decisions forced by the findings

### D-P1 — Merge authority lives in its own process, under its own OS principal (MF-1, C1, X1)

**The defect.** Omitting `MERGE_INTEGRATOR_GH_TOKEN` from
`buildChildEnvironment` proves it is not *inherited*. It does not prove it is
*unreachable*. On the shipped default the runner process holds the token,
spawns every model CLI (`runner.ts:136-168`), and `RUNNER_RUN_AS_PREFIX` is
empty (`.env.example:40-46`), so those CLIs run as the runner's own OS user —
which this repository's own `docs/wiki/batch-files-runtime-security-boundary.md:8-19`
states can read any same-uid-accessible file outside the workspace and can
open a shell to do it. An ordinary model task on the default deployment
therefore shares the credential-holding principal.

**The fix — at the boundary, not in the environment.**

1. **A separate workspace package and process.** `@agentos/merge-executor`
   (`packages/merge-executor/`) is a long-lived daemon, deployed as
   `deploy/com.agentos.merge-executor.plist`, running under a **dedicated OS
   user** (the runbook names `agentos-merge`; the account itself is an
   operator prerequisite, not this plan's work). It contains no adapter, no
   prompt builder, no CLI binary reference, and no workspace provisioning.
2. **It never spawns a child process.** All GitHub access is HTTPS from
   in-process code with an `Authorization` header (§11). The token therefore
   never appears in any child environment, in any argv, or in any
   `ps`-visible surface. A unit test stubs `node:child_process` and fails the
   suite if `spawn`, `exec`, `execFile`, or `fork` is called anywhere in the
   package's reachable graph.
3. **It claims its own runs through the existing runner principal — no new
   token class.** It calls `POST /runner/tasks/claim` (`app.ts:2849`) with
   `RUNNER_TOKEN` and a configured `runnerId`. The API adds one authorization
   rule, symmetric and fail-closed:
   - a claim whose `runnerId` is **not** in `MERGE_EXECUTOR_RUNNER_IDS` skips
     every candidate whose task's template step is the integrator step;
   - a claim whose `runnerId` **is** in that allowlist skips every candidate
     that is *not* an integrator step.
   This is an authorization-rule addition for the existing runner principal,
   exactly as SPEC §8.4's route is one for the existing session principal; it
   adds no principal and no token class (SPEC §10).
4. **The ordinary runner refuses mechanical runs, hard.** `runner.ts` gains a
   check immediately after the claim returns and **before**
   `provisionWorkspace`, `buildPrompt`, `buildChildEnvironment`,
   `adapter.preflight`, or `adapter.start`: if the claim's
   `executionMode === "mechanical"`, the run is completed FAILURE with
   `terminationReason: "mechanical run claimed by a model runner"` and
   `retryable: false`, and no adapter, workspace, prompt, or child
   environment is ever constructed. This is defense in depth behind rule 3.
5. **A hard startup isolation gate, evaluated before the credential is
   read.** `packages/merge-executor/src/preconditions.ts` runs at process
   start and **exits non-zero with a named message** unless all of the
   following hold. The token is not read until every one passes:
   1. `MERGE_EXECUTOR_OS_USER` is set and equals `os.userInfo().username`.
   2. `MERGE_EXECUTOR_PEER_USERS` is set and non-empty (the OS users the API
      and runner processes run as), and does not contain
      `MERGE_EXECUTOR_OS_USER`. A deployment that has not separated the
      principals cannot start the executor, which is the enforced
      run-as/sandbox separation the review asks for, expressed as a
      prerequisite rather than a hope.
   3. No environment variable named `MERGE_INTEGRATOR_GH_TOKEN`,
      `GH_TOKEN`, `GITHUB_TOKEN`, or `GH_ENTERPRISE_TOKEN` is present in
      `process.env`. The process environment is refused as a credential
      source, because a process environment is the surface a same-uid reader
      inspects.
   4. `MERGE_INTEGRATOR_TOKEN_FILE` is set; `fs.statSync` of that file
      reports `uid === process.getuid()` and `(mode & 0o077) === 0`; and
      every directory on the path from the file to the executor user's home
      reports `(mode & 0o022) === 0`.
   5. The token file's content matches `^gh[pousr]_[A-Za-z0-9]{20,}$` after
      trimming; a shape mismatch is a startup failure, not a runtime one.
   The token is then read into a module-private constant, the descriptor is
   closed, and the value is never written to `process.env`, to any log, to
   any activity, to any output, or to any error message. A redaction wrapper
   asserts this: every outbound log line and every recorded error string is
   passed through a filter that replaces the token value, and a test feeds the
   token through each recording path and asserts it never lands.
6. **The token cannot express a bypass** (SPEC §5.2 requirement 3, unchanged):
   the dedicated identity is repository-scoped with no administrative,
   branch-protection-override, or bypass permission. Verified live by N17(b).

**Evidence — N23 becomes a live cross-principal negative** (Step 9). On a
deployment in the supported configuration, a real BASH-enabled LLM task runs
and *attempts*, recording the exact command and the exact refusal for each:

- (a) read `MERGE_INTEGRATOR_TOKEN_FILE` directly;
- (b) inspect the merge-executor process's environment — `ps eww`, `ps -E`,
  `/proc/<pid>/environ`-equivalent, and `launchctl print gui/<uid>/com.agentos.merge-executor`;
- (c) inspect its own parent and sibling processes' environments (the runner,
  the API) for the token;
- (d) read **every configured secret source**: the token file, the executor's
  launchd plist, its `.env`, its keychain item, and the runner's own env and
  config files;
- (e) claim an integrator run using `RUNNER_TOKEN` with a spoofed `runnerId`
  (refused by rule 3's allowlist);
- (f) the in-repo half retained from the prior plan: the claim payload for a
  step-10 run carries no merge credential in `secrets`, and
  `buildChildEnvironment` is never invoked for it.

Each attempt must fail. The harness fails the direction if any attempt
succeeds *or* if it cannot be executed, so an unrun attempt is never
recorded as a pass. Startup-gate negatives run alongside: start the executor
as the runner's OS user → refused at precondition 2 with the token unread;
place the token file at mode `0644` → refused at 4; export
`MERGE_INTEGRATOR_GH_TOKEN` into its environment → refused at 3.

**Recorded residual, not solved here.** `RUNNER_TOKEN` is one shared token
class (`auth.ts:32`). A same-uid reader of the runner's environment can
obtain it and claim *ordinary* runs today; that is a pre-existing property of
the runner principal, unchanged by this plan. What this plan removes is the
consequence that mattered: such a holder still cannot obtain the merge
credential, cannot be handed an integrator run (rule 3), and therefore cannot
merge. The remaining exposure — reporting a false `merge-result` for a run it
should not have — is contained because rule 3 refuses the claim; it is
recorded here rather than silently inherited.

### D-P2 — Selection is anchored in server-only rows (MF-2, Y4)

**The defect.** `POST /tasks/:taskId/activity` server-stamps
`actorType: "operator"` but accepts arbitrary metadata
(`app.ts:2717-2727`), and `GET /inbox/messages` exposes decision rows and
their ids (`app.ts:2730-2745`). A holder of the shared operator token could
read a real winning decision id, post a later well-formed authorization
activity carrying that id but fresh head/base/check fields, and a
latest-wins selector that checks only that a binding is *present* would
accept it.

**The fix — the payload comes from a row no client can write, and the
activity is validated against it, server-side.**

1. **The evidence snapshot lives in the gate card's `body`.** `gateTaskId`
   and `body` on a gate card are written only by `gateQuestion`
   (`workflow.ts:382`); no route lets a client create or edit one (§2). The
   body carries a strictly delimited block:

       ```agentos-merge-evidence
       {"schemaVersion":1,"nonce":"<cuid>","repository":"owner/name",
        "prNumber":123,"headSha":"<40 hex>","baseRef":"master",
        "baseSha":"<40 hex>","mergeMethod":"merge",
        "requiredChecks":[{"name":"...","conclusion":"SUCCESS"}],
        "readAt":"<ISO>"}
       ```

   rendered above a human-readable restatement of the same five facts. This
   makes SPEC §8.2's "presented equals recorded" true **by identity** rather
   than by comparison: the payload's only source is the bytes the human saw.
2. **Both channels produce a real `InboxDecision` row.** The inbox channel
   already does (`workflow.ts:838-844`). The PATCH channel gains one, created
   inside its existing transaction and **only when the gate task's chain
   successor is an integrator step**, on the deterministic winning card (the
   earliest-`createdAt` card the CAS at `app.ts:2313-2316` closed), with
   `decision: "approve"` and
   `externalEventId: "patch:<gateTaskId>:<statusActivityId>"`. The row uses
   the existing model and requires no migration; its `runId` comes from the
   card's `session.run`, which `gateQuestion` always sets. The replay branch
   at `app.ts:2317-2323` (decided gate rows already present) creates none, and
   the no-gate-rows edge creates none — the SPEC's fail-closed resolution
   (missing-authorization, 4.5) is preserved exactly.
3. **The authorization activity is still written** in the same transaction on
   both channels, `actorType: "operator"`, carrying the parsed snapshot and
   `{ channel, inboxDecisionId, inboxMessageId, nonce }`. It is the
   human-visible audit record and satisfies SPEC §8.3 legs 1–4.
4. **Selection runs server-side, in the read route (Step 3), and returns only
   validated records.** For a candidate activity to be returned as an
   authorization, all of the following must hold, checked against durable rows
   in one query set:
   1. `actorType === "operator"` and the discriminator matches (SPEC legs 1–2);
   2. the referenced `inboxDecisionId` names an existing `InboxDecision`
      whose `inboxMessage.gateTaskId` equals **this chain's** step-9 task id
      — resolved from the caller's own chain, never from the payload;
   3. that `InboxMessage.status === ANSWERED` and its `selectedChoiceId` is
      the approve choice, and the `InboxDecision.decision` is likewise
      `"approve"` — the decision **won**, not merely exists;
   4. the card body's evidence block parses, and the activity payload is
      **field-by-field equal** to it, including the `nonce`;
   5. no other authorization activity in this chain references the same
      `inboxDecisionId` (no reuse across authorizations);
   6. the activity's `createdAt` lies within `[decision.createdAt,
      decision.createdAt + 5s]` — they are written in one transaction, so a
      later forgery is excluded by construction.
   A candidate failing 1, 2, 3, or 5 is **not an authorization**: it is
   excluded and reported in an `ignored` count. A candidate passing 1–3 but
   failing 4 or 6 is a **malformed near-match** and is reported in a
   `nearMatch` count, which the executor maps to SPEC 4.9 ambiguity. The
   response returns validated records only; the executor never sees raw
   activity metadata for selection.
5. **Attribution limits, unchanged and recorded** (SPEC §8.3): the operator
   token authenticates a principal class, not a person, and `actorId` stays
   self-asserted and is used by nothing. What this design removes is the
   forgery *of the authorized facts*: a forger cannot produce a card body, and
   the card body is the only source of head, base, and checks.

**Evidence — N14** posts a forged authorization activity through the real
`POST /tasks/:taskId/activity` route, carrying a **real winning
`InboxDecision` id** for this chain and new live head/base/check values for
the correct chain PR. The read route must not return it; the executor must
stop (missing-authorization if it is the only candidate, ambiguity if a valid
one also exists) and must issue zero merge calls. Second forgery: the same
real decision id reused for a second authorization → refused by rule 5.
Third: a decision id belonging to another chain's gate → refused by rule 2.

### D-P3 — One two-phase evidence protocol, for the gate and every renewal (MF-3, C2, SF-2)

**The defect.** The SPEC requires the human to re-judge "fresh evidence
presented in the question" (§4.0). The prior plan read the snapshot *at answer
time*, so the human necessarily answered before seeing what was authorized.
Worse, the topology could not run: the reader lived in `@agentos/api`, while
Feishu answers execute `applyInboxDecisionTx` in the separate `@agentos/inbox`
process, and `@agentos/db` cannot import `@agentos/api`. The same problem
applies to the initial gate, because `gateQuestion` also runs in the inbox
process. Separately, both reads sat inside lock-holding transactions with no
latency bound (SF-2).

**The fix — one protocol, three phases, used identically by the initial gate,
every re-authorization, and every target repair.**

- **Phase A — request (a pure DB write, any process).** The code that wants a
  card writes a `mergeIntegrator.evidenceRequest` activity with
  `actorType: "control-plane"` (not client-producible — §2) on the step-9
  task, carrying `{ nonce, gateTaskId, repositoryId, prNumber, cardId,
  requestedAt, attempt }`, and creates the `InboxMessage` gate card **OPEN**
  with a placeholder body ("评审证据读取中…" / "reading merge evidence"),
  `deliveryStatus: PENDING`, and `nextDeliveryAt = now + EVIDENCE_DEADLINE_MS`
  so the inbox outbox (`packages/inbox/src/delivery.ts:21-31`, which selects
  `nextDeliveryAt <= now`) does not ship a placeholder. No network I/O. The
  transaction is as short as today's.
- **Phase B — fill (the API process, outside every transaction).**
  `evidenceTick(db, github, now)` in
  `packages/api/src/merge-evidence-worker.ts` runs on its own interval beside
  `startScheduler` in `packages/api/src/index.ts:142`. It claims a pending
  request by CAS, performs the GitHub read (§11) under a **strict,
  cancellable deadline** — one `AbortController` with
  `MERGE_EVIDENCE_READ_TIMEOUT_MS` (default 8000) and a total budget across
  retries — **with no database transaction open**, and then in a short write
  transaction CASes the card:
  `inboxMessage.updateMany({ where: { id: cardId, status: OPEN, body: <placeholder> }, data: { body: <rendered block>, nextDeliveryAt: now } })`.
  The nonce inside the block ties the card to its request. Retries are bounded
  (`MERGE_EVIDENCE_ATTEMPTS`, default 3, with backoff); on exhaustion the
  worker CASes an `evidence-unavailable` body instead, and the card becomes
  deliverable but **not approvable**.
- **Phase C — answer (a pure DB transaction, either process).**
  `applyInboxDecisionTx` in `@agentos/db` — the one path both Web
  (`app.ts:2755+`) and Feishu (`packages/inbox/src/events.ts:30-95`) already
  share — parses the card body block it is holding and copies it verbatim into
  the authorization payload. **It performs no network I/O and reads no field
  that was not already persisted.** Approving a card whose body has no block,
  an unparseable block, or the `evidence-unavailable` marker is refused with a
  named 409 and the card stays OPEN; SPEC §8.2's "impossible by construction"
  is satisfied because the payload's only source is the row in hand. The
  PATCH channel takes the identical path through the same shared function.

**Renewal uses the same protocol, and this is what resolves C2.** Answering
`re-authorize` on a stop question does **not** authorize anything and does
**not** create a run. It writes a `mergeIntegrator.stopAnswer` with
disposition `refresh-requested` (§D-P7) and a Phase-A request for a **fresh
confirmation card** on the step-9 task (`gateTaskId` = the step-9 task, so it
is a real gate card travelling the identical production path). The worker
fills it with a snapshot read *now*. The human then sees that snapshot and
approves **that** card; that approval is the renewed judgment, it writes the
fresh authorization from the displayed bytes, and it queues the budget-exempt
step-10 run (§D-P5). Evidence precedes judgment, and the answer transaction
holds no lock across a network call.

**Evidence.** `merge-evidence-protocol.dbtest.ts`:

- Web and Feishu cross-process cases where the PR head advances **between**
  the stop, the refresh, and the answer: the authorization payload equals the
  displayed snapshot in every ordering; the un-displayed head is never
  authorized; the subsequent step-10 run stops `head-drift` against the moved
  head rather than merging it.
- Timeout: a GitHub read that stalls past `MERGE_EVIDENCE_READ_TIMEOUT_MS` is
  aborted; no transaction was open for its duration; a competing `PATCH
  /tasks/:taskId` and a competing inbox decision both complete while the read
  is in flight.
- Concurrency: two simultaneous approvals of the same card — one wins on the
  existing `OPEN → ANSWERED` CAS (`workflow.ts:806-809`), one is a duplicate;
  exactly one authorization and at most one run exist.
- Replay: the same Feishu `externalEventId` twice → the `InboxDecision`
  unique constraint holds; no second authorization, no second run.
- Worker: a filled card cannot be re-filled (the body CAS fails); an
  `evidence-unavailable` card refuses approval on both channels.

### D-P4 — The sentinel Agent may bind only step 10, and step 10 may bind only it (MF-4)

**The defect.** Adding `merge-integrator` to the canonical active Agent set
makes it selectable everywhere an Agent is selectable. `POST
/projects/:projectId/tasks` accepts any active agent and builds a real run
inline (`app.ts:2016-2081`); `deriveRunConfig` turns every Agent row into a
runner/model pair (`workflow.ts:34-52`); the adapter hands `Run.model` to a
model CLI (`adapters.ts:398-444`). Deriving `executionMode` from the *claimed
task's template binding* is therefore too late and too narrow: an ordinary
task bound to the sentinel claims as `agent` and spawns a CLI with
`mechanical/merge-executor-v1` as its model.

**The fix — one invariant, enforced at every binding surface, failing closed
before any run row is created.** A shared predicate in
`packages/db/src/merge-integrator.ts`:

```text
integratorBindingValid(agentName, templateStep) =
  (agentName === "merge-integrator") === isIntegratorStep(templateStep)
isIntegratorStep(step) = step != null
  && step.outputKind === "merge-result"
  && step.stepIndex === 10
  && step.taskTemplate.name === "compound-engineer-workflow"
```

Enforced, each with a named refusal and a named test:

| Surface | File:line at master | Enforcement |
|---|---|---|
| Task creation | `app.ts:2016-2081` | Refuse 400 if the assignee is the sentinel and the task has no integrator template step, or vice versa — inside the transaction, before `tx.task.create` and before the inline `tx.run.create` |
| Task PATCH (reassignment) | `app.ts:2282-2400` | Same predicate on any change to `assigneeAgentId`, `templateStepId`, or `assigneeType` |
| Template instantiation | `templates.ts:110-134` | Assert the predicate for every materialized step; a violating template fails instantiation before any task row exists |
| Scheduled tasks | `packages/api/src/scheduler.ts` (`fireCronTask`, `fireAtTask`) | The sentinel may not be the assignee of any scheduled or recurring definition; refused at validation and again at fire time |
| Operator retry | `app.ts:2378-2440` | Refuse if the predicate fails, before the inline run create |
| `enqueueTaskRun` | `workflow.ts:320-352` | Last-line assertion inside the shared enqueue path |
| Claim | `app.ts:2849-3000` | `executionMode` is computed here from the template step; a candidate whose binding violates the predicate is **skipped, not claimed**; combined with §D-P1 rule 3, an ordinary runner is never offered one |
| Model spawn | `runner.ts` post-claim | §D-P1 rule 4's hard refusal, so even a defective claim never reaches `adapter.start` |

Additionally the sentinel is **hidden from ordinary selection**: `GET
/projects/:projectId/agents` (`app.ts:992`) returns it with
`mechanical: true` and `assignable: false`, and the web agent pickers filter
on `assignable`.

**Evidence** (`merge-integrator-binding.dbtest.ts`): create a task with the
sentinel and no integrator step → 400, no task row, no run row; create an
integrator-step task bound to `senior-dev` → 400; PATCH an ordinary task's
assignee to the sentinel → 400; register a scheduled task with the sentinel →
refused at both validation and fire; retry a mis-bound task → refused;
instantiate a doctored template → refused; and a claim test asserting that for
a correctly bound step-10 run **no adapter function is called at all** (the
adapter module is stubbed and fails the test on any invocation) and that
`buildChildEnvironment` is never entered.

### D-P5 — Only a human answer may exceed the run ceiling (MF-5, X5)

**The defect.** The prior plan claimed the answer-created row's ceiling left
the automatic path untouched. It does not. At `app.ts:3370` completion
computes `budgetCeiling = run.maxRunsPerTask + (external ? 1 : 0)` and at
`app.ts:3468` writes that raised value onto the retry row. So an authorized
run 6 with ceiling 6 that hits a retryable external or preflight failure
yields run 7 at ceiling 7 with no human answer, and repeating external
failures extend it indefinitely.

**The decision: for an integrator step, no automatic path may raise the
ceiling.** In the completion transaction, when the completing run's task is an
integrator step, `budgetCeiling = run.maxRunsPerTask` unconditionally — the
external-failure `+1` compensation does not apply. The **only** writer of a
`maxRunsPerTask` above the task's original `maxSessionsPerTask` is the
confirmation-card approval transaction, which sets
`maxRunsPerTask: max(prior.maxRunsPerTask, prior.runNumber + 1)` on the run it
creates (still required, because `runner.ts:102` refuses the claim otherwise
— the X5 consequence the prior plan correctly identified and then undermined).

Rationale, recorded rather than assumed: a merge gate that quietly buys itself
extra automatic attempts is exactly the shape SPEC §4.0 forbids, and the cost
of the stricter rule is bounded — an integrator step that exhausts its budget
lands the stop state, whose answer always yields a fresh run (SPEC D9). The
answer transaction is idempotent per stop: it is gated on the `OPEN →
ANSWERED` CAS and creates at most one run per `stopAnswer`.

**Evidence — N20 covers all four interleavings** the review names:

1. Ordinary retryable failure at `runNumber == maxRunsPerTask` → no automatic
   retry; task lands the stop state; `POST /tasks/:taskId/retry` still refuses
   "Run budget exhausted".
2. **External/preflight failure** at the ceiling on an integrator step → still
   no automatic retry, and the created-run count is asserted to be zero (the
   direct regression for this finding).
3. Lost lease → reconciliation terminalizes the run; any resulting retry is
   bounded by the unraised ceiling.
4. Concurrent and replayed answer transactions at the ceiling → exactly one
   fresh run, claimable by the merge-executor (`runner.ts:102` passes because
   the run row's own ceiling was raised), while a non-integrator task's
   external-failure compensation is asserted unchanged.

### D-P6 — The platform binding is named exactly, and drift fails the build (MF-6, X10)

**The defect.** SPEC §3 precondition 10 requires the Plan to define the exact
queue/auto-merge detection fields and accepted values. The prior plan said
they would be "defined in the executor" and named no query, no value, no
removal operation, and no disarm proof. Re-verified this session: `gh` 2.89.0
`pr merge --help` documents that a queue-governed target enqueues rather than
merges, offers `--disable-auto`, and offers **no queue-removal flag of any
kind** — so `--disable-auto` cannot satisfy the SPEC's disarm obligation, and
the CLI cannot express the protocol at all.

**The fix.** The executor binds GitHub's REST and GraphQL APIs directly. §11
is the normative binding: one read query with every field named, the exact
accepted values for every enum, the bounded poll, the merge call and its full
status taxonomy, the two disarm mutations, the post-disarm readback, and the
behavior for every null, unknown, and permission error. Under SPEC §3.5's
rule, an undefined value is never a pass.

**Honesty about verification.** `gh` 2.89.0's behavior and flags were
re-verified live this session. The GraphQL type, field, and enum names in §11
are taken from GitHub's published schema and **were not verified against a
live schema in this session** — no authenticated GitHub access was available
in the planning environment. Rather than assert them, the plan makes them
mechanically checked: `packages/merge-executor/src/schema-gate.test.ts` runs a
GraphQL introspection query with the read token and fails if any named type,
field, or enum value is absent or renamed, **or if any bound enum has gained a
value not classified in §11's table**. The gate runs in the package's test
suite and is a prerequisite of the Step 9 evidence harness. A wrong name in
this plan therefore surfaces as a failing test before any merge path runs,
never as a wrong merge.

### D-P7 — Answers carry dispositions; the guard keys on terminality (MF-7, C3, X4, Y2)

**The defect.** The prior guard held "while no corresponding `stopAnswer`
exists", but `flag-incident` writes a `stopAnswer` and deliberately leaves the
task REVIEW. The generic `PATCH /tasks/:taskId` can then move REVIEW → DONE
and call `activateChainSuccessor` (`app.ts:2282-2338`), so the chain exits an
open incident with neither acceptance nor abandonment. The original 4.13
question also declared no `abandon` choice, so the "exits only through a later
accept or abandon" promise had no surface offering it.

**The fix — an explicit state machine over dispositions.** Every
`mergeIntegrator.stopAnswer` records
`{ stopId, condition, choice, disposition }` where `disposition` is one of:

| Disposition | Choices that produce it | Effect |
|---|---|---|
| `terminal-done` | `accept` (4.10), `revert` (4.10), `accept-foreign-merge` (4.13) | Task lands DONE with the incident and the decision recorded; guard released |
| `terminal-abandoned` | `abandon` | Task lands DONE with the abandonment explicit in the output body and in the completion activity; guard released |
| `refresh-requested` | `re-authorize` (all resumable stops) | Nonterminal. Writes a Phase-A evidence request for a fresh confirmation card. **No run is created and no authorization is written.** Guard stays in force |
| `repair-requested` | `open-repair` (4.14 only) | Nonterminal. Guard stays in force until a valid target correction lands and its confirmation card is approved (§D-P8) |
| `nonterminal` | `flag-incident` (4.13) | Guard stays in force, **and the answer transaction creates a fresh OPEN follow-up question** on the step-10 task with choices `accept-foreign-merge` / `abandon` — the later exits the SPEC promises, now actually offered |

**The guard predicate** (Step 5), shared by every route:

```text
inStopState(task) =
  isIntegratorStep(task.templateStep)
  && latestRecordedStop(task) != null
  && no mergeIntegrator.stopAnswer for that stop has a terminal disposition
```

`latestRecordedStop` reads the append-only `mergeIntegrator.result` history
(not the replaceable output), so a re-authorized run that replaces the output
cannot erase the stop the guard is keyed on. While `inStopState` holds:
`POST /tasks/:taskId/retry` refuses 409; `PATCH /tasks/:taskId` refuses any
status change out of REVIEW with 409; and every run-creating path
(`enqueueTaskRun`, the scheduler, the inline creates at `app.ts:2060` and
`app.ts:3453`) refuses. Because the predicate is a function of the task row
and its template step rather than of a route name, a future route composes it
by construction; the N19 tests pin the present ones.

**Evidence — N19 extended:** with a 4.13 stop, choose `flag-incident`, then
attempt in turn `PATCH` to DONE, `POST /tasks/:taskId/retry`, a scheduler
fire, and a replayed identical answer — each refused, no successor activated,
no run created, exactly one follow-up question in existence. Then answer the
follow-up `accept-foreign-merge` → DONE with the acceptance recorded, and
assert `PATCH` succeeds only after that. Repeat the whole sequence for
`refresh-requested` and for `repair-requested`, and assert that a
`refresh-requested` answer creates zero runs.

### D-P8 — `target-unresolvable` gets a real, authenticated repair (MF-8, Y2)

**The defect.** The target is derived from immutable historical
`Run.pullRequestNumber` values, and 4.14 stops on zero or on more than one.
`re-authorize` changes only the authorization, so every re-authorized run
returns the identical `target-unresolvable` — the choice was a dead end
presented as a resume path, and the prior plan's "resolution outside contract"
named no mutation capable of changing the inputs.

**The fix.**

1. **`re-authorize` is removed from 4.14's choices.** They become
   `open-repair` and `abandon`.
2. **A durable, authenticated target-correction record**, written **only** by
   a dedicated operator route — never by the generic activity route:
   `POST /tasks/:taskId/merge-target`, body `{ prNumber }`. The handler:
   - requires the operator principal and the task to be an integrator step
     currently in the stop state with condition `target-unresolvable`;
   - recomputes the chain's observed candidate set (the distinct non-null
     `Run.pullRequestNumber` values across the chain's tasks' runs) **inside
     the transaction**, and refuses 409 unless `prNumber` is a member of it —
     so a correction can select among what the chain actually delivered and
     can **never** introduce a foreign PR;
   - refuses 409 when the observed set is empty, with a named message: a chain
     that delivered no PR has nothing to merge, and the only answers are
     `abandon` or delivering the PR by re-running the delivering step outside
     this contract, after which resolution succeeds with no correction at all;
   - writes `mergeIntegrator.targetCorrection` on the step-10 task with
     `actorType: "operator"`, carrying `{ chainId, prNumber, observedSet,
     supersedesActivityId }`;
   - and, in the same transaction, writes a Phase-A evidence request for a
     fresh confirmation card on the step-9 task (§D-P3), so the operator's
     next action is the ordinary "see the evidence, approve" path.
3. **The resolution rule (Step 3) becomes:** exactly one distinct observed
   value → that value. Otherwise, if a latest valid `targetCorrection` exists
   for this chain **and** its `prNumber` is in the currently observed set →
   that value, with the correction's activity id in the envelope so the
   executor records what it acted on. Otherwise `unresolvable: "none" |
   "ambiguous"`. Latest-wins across corrections; a correction whose `prNumber`
   has since left the observed set is ignored, not honored.
4. The `repair-requested` disposition keeps the stop guard in force until the
   confirmation card is approved, so no run executes against an uncorrected
   target.

**Evidence — N22 executes the repair end to end:** (i) two distinct
`pullRequestNumber` values across chain runs → `target-unresolvable`, zero
merges; (ii) `POST /tasks/:taskId/merge-target` with a PR number **not** in
the observed set → 409, no record; (iii) with a member value → record written,
confirmation card requested; (iv) the worker fills the card, the human
approves it, a fresh authorization and run are produced, and the run reaches
the happy path and merges the corrected PR; (v) the zero-observed-PR case →
correction refused with the named message, `abandon` lands DONE. The existing
N22 legs are retained: a foreign-PR authorization whose payload matches that
other PR's live state still stops `payload-mismatch`.

---

## 4. Every record: producer, authenticated authority, consumer and read route

Any implementation step that adds a record extends this table in the same
change.

| Record | Producer (writer) | Authenticated authority | Consumer and read route |
|---|---|---|---|
| Gate / confirmation card (`InboxMessage` with `gateTaskId`, body carrying the evidence block) | `gateQuestion` (`workflow.ts:365-393`) for Phase A; the evidence worker for Phase B's body CAS | Control plane only — **no route lets a client write `gateTaskId` or a card body** (§2) | The human (rendered card); the approval transaction (parses the block); the read route's validator |
| `mergeIntegrator.evidenceRequest` (activity on the step-9 task) | Phase A, in whichever process opened the card | `actorType: "control-plane"`, not client-producible (§2) | The evidence worker (Step 2b) |
| `InboxDecision` (winning decision, both channels) | `applyInboxDecisionTx` (`workflow.ts:838-844`); the PATCH path's new create (Step 2c) | Inbox/operator decision channels; created only inside the decision transaction | The read route's server-side validator (§D-P2 rule 4) |
| `mergeIntegrator.authorization` (activity on the step-9 task) | The approval transaction, both channels | Operator principal (`actorType` server-forced, `app.ts:2722`) **plus** the server-only anchors it is validated against | Merge executor, via `GET /session/runs/:runId/chain/steps/:chainIndex/activity` at `chainIndex - 1`, **already validated** |
| `mergeIntegrator.stopAnswer` (activity on the step-10 task, with `disposition`) | The stop-question answer transaction (Step 4) | Operator principal + the answered `InboxDecision` | The stop guard (Step 5); the follow-up question logic; humans |
| `mergeIntegrator.targetCorrection` (activity on the step-10 task) | `POST /tasks/:taskId/merge-target` only (Step 4b) | Operator principal; `prNumber` validated server-side against the chain's own run rows | The chain-target resolver (Step 3) |
| `mergeIntegrator.intent` (activity on the step-10 task) | Merge executor, pre-merge, via the fenced session activity write (`app.ts:3154-3177`) | Session principal (fencing token + live lease; `actorType` stamped at `app.ts:3172`) | A later step-10 run, via the same chain read route at its own `chainIndex` |
| `mergeIntegrator.result` (append-only history on the step-10 task) | Merge executor, every terminal outcome | Session principal, fenced | Later runs (replay context); the stop guard's `latestRecordedStop`; humans (`app.ts:2700`) |
| `merge-result` task output (latest view) | Merge executor via `PUT /session/runs/:runId/output` (`app.ts:3218-3233`) | Session principal, fenced | The control plane's completion branching (Step 4); the run/session DTOs (Step 8); humans |
| Chain target identity (computed, not stored) | API server, per request, from the chain's `Run.pullRequestNumber` rows plus any valid `targetCorrection` | Server-side computation; no client input | Merge executor, in the read route's response envelope |

Discriminator namespace: `mergeIntegrator.*`, envelope
`{ kind, schemaVersion: 1, ... }` — disjoint from the `goal5a0.*` namespace
PR #94 defines (§13).

---

## 5. Implementation sequence

Ordering rationale: shared record definitions first; then the producers; then
the consumers; then the control-plane semantics that branch on their outputs;
the executor and its deployment next; the template cutover after that so the
verifier flips exactly once; then the UI, the evidence harness, the system
test, and documentation. Tests live inside every step. Steps 1–5 and 8 are
control-plane and web work; step 6 is the executor and its deployment; step 7
is the template contract; steps 9–11 are evidence and documentation.

### Step 1 — Record convention, selection predicate, disposition state machine (shared module)

**Files:** `packages/db/src/merge-integrator.ts` (new);
`packages/db/src/index.ts` (export);
`packages/db/src/merge-integrator.test.ts` (new).

Typed constants and pure functions, no I/O:

- **Discriminators:** `mergeIntegrator.evidenceRequest`,
  `mergeIntegrator.authorization`, `mergeIntegrator.stopAnswer`,
  `mergeIntegrator.targetCorrection`, `mergeIntegrator.intent`,
  `mergeIntegrator.result`, each `schemaVersion: 1`.
- **The evidence block:** its exact JSON schema (§D-P2), a strict serializer,
  and a strict parser that returns `ok | absent | unparseable | unavailable`.
  The parser is the only reader of a card body anywhere in the codebase.
- **The authorization payload shape** (SPEC §8.1): repository, PR number,
  head SHA, base ref, base SHA, merge method (v1.1: the literal `"merge"`
  only), required-check identities and conclusions, issued-at, the winning
  decision binding `{ channel: "inbox" | "patch", inboxDecisionId,
  inboxMessageId }`, and the evidence nonce.
- **The selection validator** as one pure function over
  `(candidateActivities, decisionRows, cardRows, chainStep9TaskId)`,
  implementing §D-P2 rules 1–6 and returning
  `{ authorization | null, nearMatchCount, ignoredCount, refusal }` with
  refusals `missing | ambiguous-tie | malformed-near-match`. The read route
  and the tests share this one function, so the tested predicate is the
  shipped predicate.
- **`isIntegratorStep` and `integratorBindingValid`** (§D-P4), used by every
  binding surface.
- **The disposition state machine** (§D-P7): the choice→disposition map per
  stop condition, `isTerminal(disposition)`, and the follow-up-question
  specification for `flag-incident`.
- **The `merge-result` outcome shape:** `{ outcome: "merged", mergeCommitSha }`
  | `{ outcome: "stopped", condition, evidence }` over the fifteen §4
  condition literals plus `missing-or-malformed-result`, with a parser
  returning `malformed` for anything else — the same parser the control-plane
  branching (Step 4) and the DTO projection (Step 8) use.

**Verification:** unit tests for the validator (each rule failing
individually; a forged activity bearing a real decision id; decision reuse; a
cross-chain decision id; a tie at identical `createdAt`; near-match versus
non-match; supersession latest-wins), the block parser (well-formed, absent,
truncated, wrong nonce, `evidence-unavailable`), the binding predicate (both
directions), the disposition machine (every choice for every condition,
terminality), and the outcome parser (all sixteen conditions; malformed
inputs). No behavior change elsewhere; `npm test` green.

### Step 2 — Evidence protocol and authorization production on both channels

Three sub-parts, one protocol (§D-P3).

#### 2a — Phase A: request and placeholder card

**Files:** `packages/db/src/workflow.ts` (`gateQuestion` at `:365-393`;
`activateChainSuccessor` at `:630-641`).

For a gate task whose chain successor is an integrator step, `gateQuestion`
creates the card with the placeholder body, `deliveryStatus: PENDING`,
`nextDeliveryAt = now + EVIDENCE_DEADLINE_MS`, and writes the
`mergeIntegrator.evidenceRequest` activity with a fresh nonce. It performs
**no GitHub read**. Non-integrator gates and nine-step chains are
byte-for-byte unchanged — the new branch is entered only when the successor's
template step satisfies `isIntegratorStep`.

#### 2b — Phase B: the bounded evidence worker

**Files:** `packages/api/src/merge-evidence-worker.ts` (new);
`packages/api/src/github-read.ts` (new — the read-only GitHub client, §11
read query, `GITHUB_READ_TOKEN`); `packages/api/src/index.ts:142` (start the
tick beside `startScheduler`); `packages/api/src/merge-evidence-worker.test.ts`
(new).

`evidenceTick(db, github, now)` claims one pending request by CAS, reads under
`MERGE_EVIDENCE_READ_TIMEOUT_MS` with an `AbortController` and **no open
transaction**, then CASes the card body (§D-P3 Phase B). Bounded retries with
backoff; on exhaustion it writes the `evidence-unavailable` body. The read
token is read-only and is a different credential from the merge token; the
runbook (Step 11) states the separation and neither token is ever exchanged.

#### 2c — Phase C: the approval writes the record, atomically, on both channels

**Files:** `packages/db/src/workflow.ts` (`applyInboxDecisionTx` at
`:743-860`, in the approve branch after `inboxDecision.create` at `:838-844`);
`packages/api/src/app.ts` (PATCH DONE path at `:2282-2338`, after the gate CAS
at `:2313-2316` and the status activity at `:2330-2332`);
`packages/api/src/merge-authorization-production.dbtest.ts` (new).

One shared function in `workflow.ts` performs the whole write on both
channels: parse the held card's block, refuse 409 if it is absent,
unparseable, or `evidence-unavailable`; create the `InboxDecision` (the PATCH
channel's is new, integrator gates only, §D-P2 rule 2); write the
`mergeIntegrator.authorization` activity bound to it; and, when the answered
card is a **confirmation card** produced by a `refresh-requested` or
`repair-requested` disposition, also create the budget-exempt step-10 run and
move the step-10 task REVIEW → TODO (§D-P5). No network I/O anywhere in the
transaction. The PATCH-with-no-gate-rows edge (`app.ts:2317-2323`) is left
exactly as SPEC §8.2 resolves it: it produces no authorization and step 10
later stops `missing-authorization` — fail closed, tested, not "fixed".

**Verification:** `merge-authorization-production.dbtest.ts` and
`merge-evidence-protocol.dbtest.ts` — N13 on both channels (exactly one record
atomically with the winning decision; reject produces none;
**presented-equals-recorded asserted by byte equality between the card body
block and the written payload**), N5's no-gate-rows and evidence-unavailable
refusals, N14's forgery legs (§D-P2), and every case listed under §D-P3
Evidence: cross-process Web and Feishu refresh-then-answer with the PR moving
in between, the read timeout with concurrent PATCH and inbox decisions, the
concurrent-approval CAS, and the Feishu replay.

### Step 3 — Chain-relative read route, server-side validation, chain target identity

**Files:** `packages/api/src/app.ts` (new route
`GET /session/runs/:runId/chain/steps/:chainIndex/activity`, placed with the
session routes at `:3180+`);
`packages/api/src/merge-chain-read-route.dbtest.ts` (new).

Exactly the SPEC §8.4 shape, all three narrowing axes server-side, plus the
§D-P2 validation:

- **Authentication:** existing session path scoping (`auth.ts:51`) confines
  the caller to its own `runId`; the handler resolves run → task → `chainId`
  and serves only that chain. No chain, or no task at the index: 404.
- **Eligibility:** the caller's own task must satisfy `isIntegratorStep`;
  every other session receives 403.
- **Addressable indices:** exactly the caller's own `chainIndex` and
  `chainIndex - 1`; anything else 403.
- **Record and field filtering:** at `chainIndex - 1`, authorization records
  **that pass the §D-P2 validator**, projected to `id`, `createdAt`,
  `actorType`, and the convention's payload fields; the envelope also carries
  `nearMatchCount` and `ignoredCount` so the executor can raise SPEC 4.9
  ambiguity without ever seeing raw metadata. At the caller's own index, only
  `mergeIntegrator.intent` and `mergeIntegrator.result` rows, same projection.
  Bodies, operator notes, and non-contractual metadata never leave the server.
- **Chain target identity in the envelope:** resolved per request by §D-P8
  rule 3 — the distinct non-null `Run.pullRequestNumber` values across the
  chain's tasks' runs, then any valid latest `targetCorrection`, else
  `{ unresolvable: "none" | "ambiguous", observed: [...] }`. Repository comes
  from the chain's repo row. The server never guesses.
- **No MCP tool is added.** The executor is a separate non-model process that
  calls the route directly with its session token; the model-reachable MCP
  surface (`packages/runner/src/mcp-server.ts`) is unchanged.

**Verification:** `merge-chain-read-route.dbtest.ts` — N15 (positive read of
both classes; a foreign run id is 403 by path scoping; a same-project
other-chain index is 404; earlier-index refusal; non-integrator eligibility
refusal; the sensitive-field negative, in which an operator note on the step-9
task never appears in any response), N14's forgery legs asserted through the
real route, and N22's read legs (one, zero, and two distinct PR numbers; a
valid correction; a correction whose `prNumber` left the observed set).

### Step 4 — Control-plane outcome branching, stop state, dispositions, and the answer transaction

**Files:** `packages/api/src/app.ts` (run-completion path `:3350-3500`);
`packages/db/src/workflow.ts` (`advanceTemplateTask`, successor activation,
stop-question and follow-up-question creation beside `gateQuestion`, and the
answer branch of `applyInboxDecisionTx`);
`packages/api/src/merge-stop-state.dbtest.ts` (new).

- **Branch on the structured outcome.** In the completion transaction, when
  the completed run's task satisfies `isIntegratorStep` and the run succeeded,
  parse the persisted output with Step 1's parser: `merged` → the existing
  advance path (DONE; the only route to "Chain complete"); `stopped` → task
  **REVIEW**, successor not activated, no "Chain complete", and a stop
  question opened on the step-10 task carrying the condition, the recorded
  evidence, and the §D-P7 choices for that condition. Absent output, wrong
  kind, or unparseable outcome → the same stop state with condition
  `missing-or-malformed-result`.
- **Synthesis disabled.** The fabrication path (`app.ts:3487-3494`) and the
  metadata-update path (`app.ts:3477-3485`) are both skipped for integrator
  steps: the executor's own fenced write is the only writer of a step-10
  output.
- **Ceiling compensation disabled** for integrator steps at `app.ts:3370`
  (§D-P5).
- **Run FAILURE unchanged:** crashes keep today's automatic retry
  (`app.ts:3431-3472`), now bounded by the unraised ceiling; a recorded stop
  is run SUCCESS and is never auto-retried.
- **The stop question** reuses the inbox `MULTIPLE_CHOICE` machinery but is
  **not** a `gateTaskId` gate card, so it cannot trip the gate CAS at
  `app.ts:2313-2316`. Choices per condition are in the §12 matrix.
- **The answer transaction** writes the `mergeIntegrator.stopAnswer` with its
  disposition (§D-P7) and then, by disposition: `refresh-requested` → a
  Phase-A evidence request for a confirmation card, no run, no authorization;
  `repair-requested` → nothing further until the correction route runs;
  `nonterminal` → a fresh OPEN follow-up question with
  `accept-foreign-merge` / `abandon`; `terminal-abandoned` → DONE with the
  abandonment explicit in the output body and named in the completion
  activity, so "Chain complete" cannot read as delivery; `terminal-done` →
  DONE with the incident and decision recorded.

#### Step 4b — the target-correction route

**Files:** `packages/api/src/app.ts` (new `POST /tasks/:taskId/merge-target`,
placed with the operator task routes at `:2700+`); covered by
`merge-stop-state.dbtest.ts` and `merge-chain-read-route.dbtest.ts`.

Exactly §D-P8 rule 2. Named 409s for: not an integrator step; not in the
stop state; the stop condition is not `target-unresolvable`; `prNumber` not in
the observed set; the observed set is empty.

**Verification:** `merge-stop-state.dbtest.ts` — N16 (run SUCCESS, task
REVIEW, question open, no "Chain complete", no auto-retry; the append-only
history survives an output replacement — Y1), N18 (all three
malformed-outcome cases land `missing-or-malformed-result` with nothing
synthesized, including the 409 stale-fencing lost-write realization in which
the run still exits 0), N20's four interleavings (§D-P5), N19's extended
sequence (§D-P7), and N22's repair sequence (§D-P8).

### Step 5 — Stop-state exclusivity guards on every generic route

**Files:** `packages/api/src/app.ts` (`POST /tasks/:taskId/retry` at
`:2378-2440`; `PATCH /tasks/:taskId` at `:2282-2338`; the inline run create at
`:2060`); `packages/db/src/workflow.ts` (`enqueueTaskRun` at `:320-352`);
`packages/api/src/scheduler.ts` (fire paths); covered by
`merge-stop-state.dbtest.ts`.

The shared `inStopState` predicate of §D-P7, composed by every route rather
than duplicated. Retry refuses 409; PATCH refuses any status change out of
REVIEW with 409 unless a terminal disposition exists; every run-creating path
refuses. The guard is a function of the task row and its template step, so a
future route composes it by construction.

**Verification:** N19 in `merge-stop-state.dbtest.ts` — the full extended
sequence of §D-P7, plus the assertion that after a terminal disposition each
route behaves exactly as it does today.

### Step 6 — The merge executor: its own package, process, and OS principal

**Files (new package):** `packages/merge-executor/package.json`;
`src/index.ts` (daemon loop: claim → execute → complete);
`src/preconditions.ts` (the §D-P1 rule-5 startup gate);
`src/config.ts`; `src/github.ts` (the §11 REST/GraphQL binding);
`src/decision-table.ts` (SPEC §3, implemented exactly);
`src/redaction.ts`; `src/*.test.ts` (unit tests plus the PR-surface fake);
`src/schema-gate.test.ts` (§D-P6's introspection gate).
**Files (existing, changed):** `packages/api/src/app.ts` (claim: the
`executionMode` field, the §D-P1 rule-3 runnerId allowlist, and the §D-P4
binding check); `packages/runner/src/runner.ts` (the §D-P1 rule-4 hard
refusal, before workspace, prompt, child environment, preflight, adapter, and
delivery); `deploy/com.agentos.merge-executor.plist` (new); `.env.example`
(the new configuration surface, documented and empty by default);
`package.json` workspaces list.

- **Dispatch.** The claim transaction computes
  `executionMode: "mechanical" | "agent"` from the claimed task's template
  step and enforces §D-P4's binding predicate and §D-P1 rule 3's runnerId
  allowlist, both fail-closed **before** the run is handed out.
- **Custody.** Exactly §D-P1: separate process, separate OS user, file-backed
  credential with a mode and ownership gate, no child process ever, no
  workspace, no prompt, no adapter, no delivery module in the package's
  dependency graph (asserted by an import-graph test), and a redaction wrapper
  on every log and error path.
- **The decision table** (SPEC §3, in order):
  1. Read the chain target identity and records through Step 3's route;
     `unresolvable` → stop 4.14.
  2. Take the **already-validated** authorization from the envelope; none →
     4.5; `nearMatchCount > 0` → 4.9; a later valid record supersedes,
     latest-wins → 4.6; `createdAt` after execution start → 4.7; repository or
     PR number disagreeing with the chain target identity → 4.12.
  3. Verify the world field by field against the live PR (§11's read query):
     exact head → 4.1; exact base ref and base SHA → 4.2; ancestry and
     merge-base → 4.4 family; mergeability exactly `MERGEABLE`/`CLEAN` with
     the bounded `UNKNOWN` poll → 4.4 / 4.11; every required check successful
     **for the authorized head SHA specifically**, absence being a stop →
     4.3; method exactly the authorized literal `merge` → else 4.9 / 4.12.
  4. Positively determine synchronous execution — `repository.mergeQueue`,
     `pullRequest.mergeQueueEntry`, and `pullRequest.autoMergeRequest` all
     `null` (§11) — else 4.15 with the disarm obligation and the post-disarm
     readback.
  5. Replay determination (SPEC §5.1) whenever the PR is already merged: all
     three durable facts (merged head == authorized head; `mergedBy.login` ==
     the dedicated identity; a prior intent record with the same idempotency
     key) **plus** the landed merge commit's parent verification → `merged`
     as a no-op replay; first parent differs → 4.10; anything else → 4.13.
  6. Write the intent activity (idempotency key: PR number, authorized head
     SHA, authorization activity id) through the fenced session write; then,
     in one uninterrupted pass, re-read the base SHA as the last read and
     issue the guarded merge (§11): 409 → 4.1; 405 → re-read and classify;
     403 / other error / timeout → single re-read to classify → 4.8 or the
     replay determination; then the post-merge parent verification — first
     parent == authorized base, second parent == authorized head — else 4.10.
  7. Persist the `merge-result` output (fenced) and append the
     `mergeIntegrator.result` history activity; end the run SUCCESS for every
     executed contract, stop or merge alike; FAILURE only for crashes.
- **What it never does, structurally:** the package contains no code path
  emitting an admin, bypass, auto-merge-enable, or enqueue request; the only
  mutating requests it can construct are the guarded merge, the two disarm
  mutations, and the fenced AgentOS session writes — asserted by a test that
  enumerates every outbound request builder in the module.

**Verification:** `merge-executor.test.ts` against the PR-surface fake, which
records every outbound request (method, URL, body) — N1(a), N2(a–c), N3's
simulated legs, N4, N5–N9, N10, N11(a–d), N12, N17(a,c,d), N24's
no-remote-write assertion (the only mutating call ever observed is the guarded
merge), X6's replay parent check, and N21's detection and disarm legs with the
call trace asserted. Plus: the startup-gate negatives (§D-P1 rule 5), the
no-child-process test, the import-graph test, the redaction test, the
schema-introspection gate (§D-P6), and the runner's hard-refusal test (a
mechanical claim reaches no adapter, no workspace, no child environment, no
delivery).

### Step 7 — Template contract, seed, and verifier (the ten-row cutover)

**Files:** `packages/db/prisma/agent-contract.ts`
(`CANONICAL_TEMPLATE_STEPS` at `:15-25`, `CANONICAL_AGENT_DEFAULTS` at
`:3-13`); `packages/db/prisma/verify-agent-template.ts`;
**`packages/db/prisma/seed.ts:183-222`** — specifically the `steps` tuple
literal at `:200-209` and the `taskTemplateStep.upsert` at `:212-218`;
`agents/` (new `merge-integrator` role file); template instantiation tests.

- **D7 representation (unchanged from the prior plan, now with MF-4's
  invariant behind it):** a dedicated non-LLM Agent row `merge-integrator`.
  Verified at master: `Run.agentId` is non-nullable, and
  `activateChainSuccessor` turns a non-`AGENT` successor into a gate question
  (`workflow.ts:630-641`), so a null-assignee step 10 would present a second
  human gate, which SPEC §6.1 forbids; a new `AssigneeType` or `RunnerKind`
  enum value would be a Prisma migration, which SPEC §3 forbids. The row
  carries the sentinel model `mechanical/merge-executor-v1`
  (`catalogRunnerForModel` returns `null` for it — `agent-contract.ts:29-35`
  — so no runner/model mismatch assertion fires) with an inert
  `RunnerPreference`. Its runner and model are never used to spawn anything,
  and §D-P4's invariant plus §D-P1 rules 3–4 are what make that true rather
  than hoped.
- **The tenth row:** `{ stepIndex: 10, agentName: "merge-integrator",
  outputKind: "merge-result", approvalGate: false }` appended to
  `CANONICAL_TEMPLATE_STEPS`; steps 1–9 byte-for-byte unchanged.
- **The seed (SF-3, exactly).** `seed.ts:200-209` defines the step tuples as
  `[stepIndex, name, agentName, assigneeType, runner, approvalGate,
  outputKind, prompt, spawnPolicy]` and carries **no `opensPullRequest`
  element at all**; the upsert at `seed.ts:212-218` therefore sets it in
  neither branch, so every seeded row takes `schema.prisma`'s default `true`.
  The change: extend the tuple and its `as const` type with a tenth element
  `opensPullRequest`, set it `true` for steps 1–9 (preserving today's
  behavior exactly) and `false` for step 10, and add `opensPullRequest` to
  **both** the `update` and the `create` branch of the upsert. The template's
  own description string at `seed.ts:185` and `:191` ("Nine-step Full
  Assurance workflow…") is updated to ten in the same commit.
- **Verifier extensions** (`verify-agent-template.ts`), closing Y5: the
  generic per-row loop at `:43-58` covers count, assignee, outputKind,
  approvalGate, and spawnPolicy for all ten rows once the array grows; the
  runner-inheritance bound at `:55` stays `<= 8`; and a new explicit step-10
  block asserts assignee `merge-integrator`, that agent's model equal to the
  mechanical sentinel (no LLM identifier), `opensPullRequest === false`,
  `outputKind === "merge-result"`, `approvalGate === false`, and
  `spawnPolicy === null`. This enforces for step 10 the invariant the `<= 8`
  bound protects for steps 1–8, since under D7 there is no Agent runner to
  inherit. Note recorded: the verifier checks `opensPullRequest` on **no** row
  today, so this assertion is new surface, not a tightened one.
- **Same-commit rule (A5):** `CANONICAL_AGENT_DEFAULTS`, the `agents/`
  contract file, `CANONICAL_TEMPLATE_STEPS`, the seed, and the verifier change
  in one commit — `assertCanonicalAgentSources`
  (`agent-contract.ts:37-57`) and `verify-agent-template.ts:19-24` both
  require exact name-set equality against the active agent set, so a split
  commit fails.
- **In-flight chains (A4):** `templates.ts:110-134` materializes task rows at
  creation time and the task row is the runtime authority; nine-step chains
  keep their nine tasks and their manual merge. A test instantiates a chain
  before the change and asserts it is untouched after seeding the ten-step
  template.
- **Cutover expectations (SPEC §6.3), recorded, not scheduled:** before
  cutover the production verifier at pre-change code passes; during an
  authorized cutover the verifier is a post-condition of that single
  operation, not an invariant; after, the verifier at post-change code passes.
  Acceptance for this contract is demonstrated on a freshly seeded
  non-production database only. **This plan schedules no activation and
  performs no migration.**

**Verification:** seed a fresh database from the change commit; assert
directly that the seeded step-10 row has `opensPullRequest === false`
(**the SF-3 fresh-seed negative, asserted before the verifier assertion is
relied on**); then run `verify-agent-template.ts` and see it pass with ten
rows including the step-10 block. Negative verifier tests: a row with
`opensPullRequest: true`, an LLM model on the integrator agent, a non-null
`spawnPolicy`, and a nine- or eleven-row template each fail with the named
error. Plus §D-P4's binding tests (`merge-integrator-binding.dbtest.ts`).

### Step 8 — Operator-visible outcome in run-centric surfaces (SF-1)

**Files:** `packages/api/src/app.ts` (run and session list/detail DTOs);
`apps/web/src/pages/TaskDetail.tsx:57-65` (`RunRow`'s `RunPill`);
`apps/web/src/pages/Sessions.tsx:39-57` (`sessionPill`, `lifecycleStat`);
`apps/web/src/components/task-card.tsx:46-60` (`runLabel`);
`apps/web/src/pages/Sessions.test.ts` and a new
`apps/web/src/components/task-card.test.tsx` / `TaskDetail.test.tsx`.

The DTOs gain `mergeOutcome: { outcome: "merged" | "stopped" | "malformed",
condition } | null`, parsed **server-side** with Step 1's parser from the
task's latest `merge-result` output and null for every non-integrator run. The
three renderers then show, for a run whose `mergeOutcome.outcome` is
`stopped`: **Stopped** (amber) for pre-merge conditions and **Incident** (red)
for `base-drift-post-merge` and `changed-underneath-me`; the protocol-level
`SUCCEEDED` is retained in the underlying status and in the enum label, so
nothing about run semantics changes — only what an operator reads.

**Verification:** UI tests for a pre-merge stop (amber "Stopped" in run row,
sessions pill, lifecycle stat, and board card) and a post-merge incident (red
"Incident" in all four), plus a regression asserting ordinary successful runs
still render green Done.

### Step 9 — Real-infrastructure evidence harness and the custody demonstration

**Files:** `scripts/merge-integrator-evidence.md` (procedure);
`scripts/merge-integrator-real-checks.mjs` (new — drives the `[real]`
directions against a dedicated scratch repository); evidence recorded under
`docs/reviews/` when executed.

The directions that test GitHub's own behavior or the deployment's own
boundary run against real infrastructure — a dedicated scratch repository with
real branch protection, so no production branch is touched:

- **N1 [real]** — the expected-head compare-and-swap rejection: pass
  verification, move the head, and observe the platform's 409.
- **N3 [real]** — a required check that never ran for the authorized head →
  stop, not pass.
- **N17(b) [real]** — with the actual provisioned credential, invoke
  `gh pr merge --admin` against a PR with a failing required check and observe
  GitHub's own refusal. The harness fails with a named message if the
  credential is absent rather than simulating the refusal.
- **N21 [real]** — a queue-governed base branch, a pre-armed auto-merge PR,
  and a forced realization in which a mutating call leaves an armed state; for
  each, both the **API call trace** and the **final remote state read back
  independently** are asserted, and a forced disarm failure is surfaced as an
  armed-state incident.
- **N23 [live, cross-principal]** — the full attempt list of §D-P1, run as a
  real BASH-enabled LLM task in the supported deployment configuration, plus
  the three startup-gate negatives. Every attempt records its exact command
  and its exact refusal; an attempt that cannot be executed fails the
  direction.
- **The §D-P6 schema gate** runs first; a drifted field fails the harness
  before any merge direction executes.

The harness only ever merges scratch-repository PRs it created for the test,
and it never touches this repository's branches. **Scope note:** running the
harness against production infrastructure, provisioning credentials, and any
launchd or service operation are out of scope for the implementation chain
this plan authorizes; the harness is written and exercised against the scratch
repository and a non-production deployment.

**Verification:** the harness's own output is the evidence; each direction
records the exact command, the observed refusal or rejection, and the final
un-enqueued and un-armed state.

### Step 10 — The positive end-to-end system demonstration (MF-9, AC1)

**Files:** `scripts/merge-integrator-system-test.mjs` (new);
`scripts/merge-integrator-evidence.md` (procedure section); evidence recorded
under `docs/reviews/`.

One isolated system test, against a scratch repository and a non-production
AgentOS deployment with the ten-step template seeded, that composes what the
component suites cannot:

1. Instantiate a chain; drive steps 1–8 with stub outputs so step 9 activates
   with a **real delivered PR** on the scratch repository.
2. Assert the step-9 card is created in the placeholder state, that the
   evidence worker fills it with the real head SHA, base SHA, and required
   check conclusions, and that it is then delivered.
3. **Approve through a real channel** — the Web decision route
   (`POST /inbox/messages/:messageId/decision`), and a second pass driving the
   Feishu path through `processFeishuEvent` in the actual `@agentos/inbox`
   process, proving the cross-process protocol.
4. Assert the authorization activity and the `InboxDecision` landed
   atomically, that the payload equals the displayed block byte for byte, and
   that the step-10 successor activated with `executionMode: "mechanical"`.
5. Start the **merge-executor process as its dedicated OS user**; it claims
   the run, executes the guarded merge, and persists the fenced `merge-result`
   output and the `mergeIntegrator.result` history activity.
6. Assert the control plane lands the task DONE and logs "Chain complete".
7. Verify on the remote: the merge commit's **first parent equals the
   authorized base SHA and its second parent the authorized head SHA**,
   `mergedBy` is the dedicated identity, and there are **no publication side
   effects** — no new branch, no new or adopted PR, no force-push, the PR
   branch head SHA unchanged, and exactly one merge commit (N24, live).
8. Record the exact base SHA, head SHA, merge commit SHA, the full API call
   trace, and the evidence file path.

This is acceptance criterion 1's required positive demonstration; it is the
evidence AC1 is accepted on, and neither component suite substitutes for it.

### Step 11 — Documentation

**Files:** `docs/governance/task-routing-v1.md` is **not** edited (its lines
107–111 already authorize the nine-to-ten split); new runbook
`docs/runbooks/merge-integrator-v1-1.md`; `docs/wiki/` cross-reference from
`batch-files-runtime-security-boundary.md` to the new isolation prerequisite.

The runbook records: the provisioning procedure and contractual bounds of the
dedicated merge identity (single repository, no admin or bypass — verified by
N17(b), not by inspection); the **deployment isolation prerequisite** — the
dedicated OS user, the file-backed token with its required ownership and
mode, the `MERGE_EXECUTOR_PEER_USERS` separation, and the statement that the
executor refuses to start without them; the three configuration surfaces
(`MERGE_INTEGRATOR_TOKEN_FILE`, `GITHUB_READ_TOKEN`, `MERGE_EXECUTOR_*`) and
their separation; the stop-question operator guide, one section per condition
per the §12 matrix, including what `flag-incident` and `open-repair` do and
what they do not do; the target-correction procedure; and SPEC §6.3's cutover
expectations verbatim with the explicit statement that the runbook grants no
activation authority.

**Verification:** docs lint per repository conventions; every cross-reference
resolves; the runbook's configuration names match `.env.example` exactly.

---

## 6. Data contracts and API additions, each with its authorization rule

| Surface | Change | Authorization rule |
|---|---|---|
| `TaskActivity` metadata convention | `mergeIntegrator.evidenceRequest` / `.authorization` / `.stopAnswer` / `.targetCorrection` / `.intent` / `.result`, envelope `{kind, schemaVersion: 1}` — no schema change, no migration | `evidenceRequest`: `actorType: "control-plane"`, not client-producible. `authorization`: written only inside the two approval transactions; **selected only after server-side validation against the gate card and its `InboxDecision`** (§D-P2). `stopAnswer`: written only inside the answer transaction. `targetCorrection`: written only by `POST /tasks/:taskId/merge-target`, never by the generic activity route. `intent` / `result`: fenced session writes only (`app.ts:3154-3177` — fencing token, live lease, lease generation) |
| Gate / confirmation card | Evidence block inside the server-written card `body`; placeholder-then-CAS fill | `gateTaskId` and card `body` are written only by `gateQuestion` (`workflow.ts:382`) and the evidence worker's CAS; no client route can create or edit either (§2) |
| `InboxDecision` on the PATCH channel | A real decision row created inside the PATCH transaction for integrator gates only | Operator principal inside the existing gate CAS; `externalEventId: "patch:<gateTaskId>:<statusActivityId>"`; not created on the replay branch or the no-gate-rows edge |
| `merge-result` task output kind | New output kind with the contractual `merged` / `stopped` outcome field | Written only via the fenced session output route (`app.ts:3218-3233`); control-plane synthesis disabled for integrator steps (Step 4) |
| `GET /session/runs/:runId/chain/steps/:chainIndex/activity` | New read-only session route | Session principal path-scoped to its own run (`auth.ts:51`); server resolves chain membership; integrator-step eligibility; two indices; discriminator and field projection server-side; **authorization records validated server-side before return**; chain target identity computed server-side |
| `POST /tasks/:taskId/merge-target` | New operator route (§D-P8) | Operator principal; task must be an integrator step in the `target-unresolvable` stop state; `prNumber` must be a member of the chain's own observed `Run.pullRequestNumber` set, recomputed inside the transaction |
| Run claim payload | Server-computed `executionMode`; runnerId allowlist; binding predicate | All computed in the claim transaction; none client-suppliable. A candidate violating the binding predicate is skipped; an integrator candidate is offered only to an allowlisted merge-executor `runnerId`, and an allowlisted `runnerId` is offered nothing else |
| Run / session DTOs | `mergeOutcome` projection (§SF-1) | Parsed server-side from the task's latest `merge-result` output; read-only |
| Generic routes (`/tasks/:taskId/retry`, `PATCH /tasks/:taskId`, `enqueueTaskRun`, scheduler fires, the inline creates at `app.ts:2060` and `app.ts:3453`) | Stop-state refusals | The shared `inStopState` predicate: integrator step + a latest recorded stop with no terminal-disposition answer; refusal is a named 409 |
| Deployed processes | New `@agentos/merge-executor` daemon and `deploy/com.agentos.merge-executor.plist` | Runs as a dedicated OS user; refuses to start unless the §D-P1 rule-5 isolation gate passes; holds the merge credential; claims only integrator runs |
| Ordinary runner | Hard refusal of any `executionMode: "mechanical"` claim before workspace, prompt, child environment, preflight, adapter, or delivery | Defense in depth behind the claim-side allowlist |

## 7. Configuration surface

| Variable | Process | Purpose | Default |
|---|---|---|---|
| `MERGE_INTEGRATOR_TOKEN_FILE` | merge-executor only | Path to the file holding the merge credential; must be owner-only (`mode & 0o077 === 0`) and owned by the executor's uid | unset (executor refuses to start) |
| `MERGE_EXECUTOR_OS_USER` | merge-executor only | Must equal the process's effective username | unset (refuses to start) |
| `MERGE_EXECUTOR_PEER_USERS` | merge-executor only | Comma-separated OS users the API and runner run as; must not contain `MERGE_EXECUTOR_OS_USER` | unset (refuses to start) |
| `MERGE_EXECUTOR_RUNNER_IDS` | API | Allowlist of `runnerId` values permitted to claim integrator runs, and permitted to claim nothing else | empty (no integrator run is ever claimable) |
| `MERGE_EXECUTOR_MERGEABILITY_POLL_ATTEMPTS` / `_MS` | merge-executor | Bounded `UNKNOWN` poll (§11) | `5` / `2000` |
| `GITHUB_READ_TOKEN` | API only | Read-only snapshot credential for the evidence worker; never merges | unset (evidence requests land `evidence-unavailable`) |
| `MERGE_EVIDENCE_READ_TIMEOUT_MS` / `MERGE_EVIDENCE_ATTEMPTS` / `EVIDENCE_DEADLINE_MS` | API | Bounded, cancellable evidence read (§D-P3) | `8000` / `3` / `60000` |

Every default is fail-closed: an unconfigured deployment produces no
authorization and claims no integrator run, rather than merging with weaker
guarantees. `.env.example` documents all of them, empty.

## 8. Coverage: every SPEC requirement has a numbered step, files, and verification

| SPEC section | Requirement | Step | Verification |
|---|---|---|---|
| §3 Inputs / precondition 8 | Chain-derived target identity, compared independently | 3, 4b, 6 | N22 (T3, T5, T7-real) |
| §3 Output | `merge-result` output plus the append-only result history | 6 | N16, N18 (T4) |
| §3 preconditions 1–7 | Head, base, race window, ancestry, mergeability, method, required checks | 6, §11 | N1–N4, N12 (T5, T7-real) |
| §3 precondition 10 | Synchronous execution positively determined; disarm; readback | 6, §11 | N21 (T5, T7-real) |
| §4.0 outcome branching | `merged` → DONE; `stopped` → stop state; absent/malformed → stop state; synthesis disabled | 4 | N16, N18 (T4) |
| §4.0 exclusivity | No generic exit except the answer transaction, keyed on terminal disposition | 4, 5 | N19 (T4) |
| §4.0 renewed authorization | Two-phase: evidence precedes judgment; same transaction on both channels | 2, 4 | N16, N13, §D-P3 evidence (T2, T4) |
| §4.0 run budget | Only a human answer may exceed the ceiling | 4 | N20 (T4) |
| §4.1–4.15 | Every stop condition, its landing state, and its executable resume | 4, 6, §12 | N1–N12, N21, N22 (T4, T5, T7-real) |
| §5.1 replay | Three durable facts plus the landed-commit parent check on every `merged` path | 6 | N10, N11(a–d) (T5) |
| §5.2 custody | Deterministic non-model executor; credential only in its process; no bypass expressible | 6, 9, 11 | N17(b), N23 (T5, T7-real) |
| §6.1 shape and non-publication | Ten-row template; step-10 shape asserted; no push, PR, or branch mutation on any path | 6, 7, 10 | N24, AC4 (T5, T6, T7-real) |
| §6.2 acceptance | Fresh-seed verifier passes with ten rows | 7 | AC4 (T6) |
| §6.3 activation | Cutover expectations recorded; nothing scheduled | 7, 11 | documented, not executed |
| §6.4 in-flight chains | Nine-step chains untouched | 7 | template instantiation test (T6) |
| §8.2 production | Approval writes the record atomically on both channels; presented equals recorded | 2 | N13, N5 (T2) |
| §8.3 selection | Conjunctive predicate, server-validated, non-forgeable | 1, 3 | N14 (T1, T2, T3) |
| §8.4 read path | Chain-relative, eligibility, two indices, record and field filtering, target identity | 3 | N15, N22 (T3) |
| §2 criterion 1 | One positive end-to-end demonstration | 10 | `merge-happy-path` (T8-system) |

## 9. Test plan: every direction and every finding mapped to a named executable test

Named test homes: `packages/db/src/merge-integrator.test.ts` (**T1**);
`packages/api/src/merge-authorization-production.dbtest.ts` and
`packages/api/src/merge-evidence-protocol.dbtest.ts` (**T2**);
`packages/api/src/merge-chain-read-route.dbtest.ts` (**T3**);
`packages/api/src/merge-stop-state.dbtest.ts` (**T4**);
`packages/merge-executor/src/*.test.ts` (**T5**);
`packages/db/prisma/verify-agent-template.ts` runs, `merge-integrator-binding.dbtest.ts`,
and template tests (**T6**); `scripts/merge-integrator-real-checks.mjs` plus
recorded evidence (**T7-real**);
`scripts/merge-integrator-system-test.mjs` plus recorded evidence
(**T8-system**); `apps/web` component tests (**T9-ui**).

| SPEC direction / finding | Test | Home |
|---|---|---|
| N1 head drift (+ `[real]` CAS rejection) | `stop-on-head-drift` | T5; T7-real |
| N2 base drift a/b/c | `stop-on-base-drift` | T5 |
| N3 check failure/absence (+ `[real]`) | `stop-on-check-failure-and-absence` | T5; T7-real |
| N4 non-clean mergeability | `stop-on-non-clean-mergeability` | T5 |
| N5 missing authorization (deletion, no-gate PATCH, evidence-unavailable) | `stop-on-missing-authorization` | T5 + T2 |
| N6 superseded (no invalidation records — X9) | `stop-on-superseded-authorization` | T5 + T1 |
| N7 retroactive | `stop-on-retroactive-authorization` | T5 |
| N8 API error | `stop-on-api-error` | T5 |
| N9 ambiguity / malformed / wrong method | `stop-on-ambiguity` | T5 + T1 |
| N10 replay idempotency (X6) | `replay-idempotency` | T5 |
| N11 foreign merge a–d | `stop-on-foreign-merge` | T5 |
| N12 unresolved mergeability | `stop-on-unresolved-mergeability` | T5 |
| N13 production + presentation (AC1, Y3, Y4) | `authorization-production` | T2 |
| **N14 forged / non-operator / unbound / reused-decision record (MF-2)** | `stop-on-forged-authorization` | T1 + T2 + T3 |
| N15 read scope, three axes (X2, X8) | `authorization-read-scope` | T3 |
| N16 stop-state semantics + append-only history (AC2, Y1, Y2) | `stop-state-semantics` | T4 |
| N17 never approves/bypasses (AC5; b is `[real]`) | `never-approves-or-bypasses` | T5 (a,c,d); T7-real (b) |
| N18 fail-closed outcome default (X3) | `fail-closed-outcome-default` | T4 |
| **N19 no generic exit from stop, incl. flag-incident sequence (X4, MF-7)** | `no-generic-exit-from-stop` | T4 |
| **N20 re-authorization vs run budget, four interleavings (X5, MF-5)** | `re-authorization-vs-run-budget` | T4 |
| **N21 no queue / auto-merge armed, call trace + remote state (X10, MF-6)** | `no-queue-or-auto-merge-armed` | T5; T7-real |
| **N22 target identity + executable repair (X2, MF-8)** | `target-identity-and-repair` | T3 + T4 + T5 |
| **N23 credential custody, live cross-principal (X1, MF-1)** | `credential-custody` | T5 (in-repo half); T7-real (live half + startup gate) |
| N24 no publication (X7) | `no-publication` | T5 + T6 (row flag) + T8-system (live) |
| **AC1 positive end-to-end (MF-9)** | `merge-happy-path` | T8-system |
| AC2 | N16 + N18 + N19 + the §12 matrix | T4 |
| AC3 | N10 + N11 | T5 |
| AC4 fresh-seed verifier, ten rows, step-10 shape (Y5, SF-3) | fresh-seed `opensPullRequest` negative + verifier run + negative verifier tests + in-flight nine-step chain untouched (A4) | T6 |
| AC5 | N17 + N23 + N24 | T5, T7-real, T8-system |
| §D-P3 evidence protocol (MF-3, C2, SF-2) | `evidence-precedes-judgment`, `evidence-read-timeout`, `concurrent-approval`, `feishu-replay` | T2 |
| §D-P4 binding invariant (MF-4) | `integrator-binding-invariant` | T6 |
| §D-P6 schema drift | `graphql-schema-gate` | T5 |
| SF-1 operator-visible outcome | `stopped-and-incident-render` | T9-ui |

## 10. Deployment topology (specified, not performed)

| Process | OS principal | Holds | Claims |
|---|---|---|---|
| `@agentos/api` (`com.agentos.api.plist`) | API user | `GITHUB_READ_TOKEN` (read-only), `OPERATOR_TOKEN`, `RUNNER_TOKEN` | — |
| `@agentos/inbox` (`com.agentos.inbox.plist`) | inbox user | Feishu credentials | — |
| `@agentos/runner` (`com.agentos.runner.plist`) | runner user; spawns model CLIs | No GitHub merge credential of any kind | Every non-integrator run; refuses mechanical claims |
| **`@agentos/merge-executor`** (`com.agentos.merge-executor.plist`, new) | **dedicated merge user, distinct from all of the above** | The merge credential, file-backed, owner-only | Integrator runs only |

Provisioning the OS user, the credential file, the launchd unit, and any
service load, restart, or activation is an **operator prerequisite executed
under its own authority and is out of scope for the implementation chain this
plan authorizes**. This plan specifies what must be true of them and verifies
it afterward by N17(b), N23, and the startup gate.

## 11. Normative platform binding (SPEC §3.5's "exact accepted values" rule)

The executor speaks GitHub's GraphQL API for reads and disarms and its REST
API for the merge. `gh` is used by no executor code path; it survives only in
the Step 9 evidence harness for N17(b). **Undefined is never a pass:** any
value not classified below, any `null` where a value is required, any omitted
field, and any GraphQL `errors` entry is a stop, never a pass.

**Verification status.** `gh` 2.89.0's behavior was re-verified live this
session (`gh pr merge --help`: queue enqueue and auto-merge deferral
documented, `--match-head-commit` and `--disable-auto` present, **no
queue-removal flag**). The GraphQL and REST names below are taken from
GitHub's published schema and were **not** verified against a live schema in
this session. `packages/merge-executor/src/schema-gate.test.ts` introspects
the live schema and fails if any named type, field, or enum value is absent,
renamed, or has gained an unclassified enum value; it is a prerequisite of
every merge path and of the Step 9 harness. A wrong name here therefore fails
a test, never a merge.

### 11.1 The single read query (one round trip per verification pass)

    query($owner:String!,$name:String!,$number:Int!,$base:String!) {
      repository(owner:$owner,name:$name) {
        mergeQueue(branch:$base) { id }
        branchProtectionRules(first:100) { nodes {
          pattern requiresStatusChecks requiresStrictStatusChecks
          requiredStatusCheckContexts } }
        ref(qualifiedName:$base) { target { oid } }
        pullRequest(number:$number) {
          number state isDraft merged mergedAt
          mergeable mergeStateStatus
          baseRefName headRefOid
          autoMergeRequest { enabledAt mergeMethod }
          mergeQueueEntry { id state position }
          mergedBy { login }
          mergeCommit { oid parents(first:5) { nodes { oid } } }
          commits(last:1) { nodes { commit { oid statusCheckRollup {
            state contexts(first:100) { nodes {
              __typename
              ... on CheckRun { name conclusion status }
              ... on StatusContext { context state } } } } } } }
        }
      }
    }

### 11.2 Accepted values, exhaustively

| Field | Pass | Bounded poll | Stop |
|---|---|---|---|
| `pullRequest.mergeable` | `"MERGEABLE"` | `"UNKNOWN"` | `"CONFLICTING"`, any other value, `null`, absent → 4.4 |
| `pullRequest.mergeStateStatus` | `"CLEAN"` | `"UNKNOWN"` | `"BEHIND"`, `"BLOCKED"`, `"DIRTY"`, `"DRAFT"`, `"HAS_HOOKS"`, `"UNSTABLE"`, any other value, `null`, absent → 4.4 |
| `repository.mergeQueue(branch: base)` | `null` | — | non-`null` → 4.15 |
| `pullRequest.mergeQueueEntry` | `null` | — | non-`null` → 4.15 |
| `pullRequest.autoMergeRequest` | `null` | — | non-`null` → 4.15 |
| `pullRequest.headRefOid` | `=== authorizedHead` | — | anything else → 4.1 |
| `pullRequest.baseRefName` | `=== authorizedBaseRef` | — | anything else → 4.2 |
| `repository.ref(base).target.oid` | `=== authorizedBaseSha` | — | anything else → 4.2; `null` → 4.8 |
| `pullRequest.isDraft` | `false` | — | `true` → 4.4 |
| `pullRequest.state` | `"OPEN"` (pre-merge) or `"MERGED"` (replay determination) | — | `"CLOSED"` → 4.4 |
| Required-check context (per name in `requiredStatusCheckContexts` of the rule whose `pattern` matches the authorized base ref and whose `requiresStatusChecks` is `true`) | `CheckRun.conclusion === "SUCCESS"` or `StatusContext.state === "SUCCESS"`, **for the authorized head oid only** | `CheckRun.status !== "COMPLETED"` counts as not-yet, inside the same bounded poll | context absent from the rollup → 4.3 (absence, never a pass); any other conclusion or state, or `null` → 4.3 |
| Any GraphQL `errors` entry with `type` `"FORBIDDEN"` or `"INSUFFICIENT_SCOPES"`, or HTTP 401/403 | — | — | 4.8 `api-error`. **A permission error is never read as "no queue" or "no auto-merge".** |
| `repository` or `pullRequest` resolving to `null`, or any listed field omitted from the response | — | — | 4.15 when it is a synchronous-execution field, 4.8 otherwise |

**Bounded poll:** at most `MERGE_EXECUTOR_MERGEABILITY_POLL_ATTEMPTS` (default
5) additional reads at `MERGE_EXECUTOR_MERGEABILITY_POLL_MS` (default 2000),
under one total wall-clock cap. On exhaustion with either field still
`"UNKNOWN"` → 4.11 `unresolved-mergeability`, recording the observed values
and the poll count.

### 11.3 The merge call

`PUT /repos/{owner}/{repo}/pulls/{number}/merge`, body
`{ "sha": "<authorizedHead>", "merge_method": "merge" }`. `sha` is the
platform's expected-head compare-and-swap; `merge_method` is the pinned method
(SPEC D4). No other body field is ever sent, and the GraphQL
`mergePullRequest` mutation is **not** used, so implementers cannot diverge.

| Response | Meaning | Action |
|---|---|---|
| `200` with `{"merged":true,"sha":...}` | The merge landed | Re-read §11.1 and apply the post-merge parent check: `mergeCommit.parents.nodes[0].oid === authorizedBaseSha` and `[1].oid === authorizedHead`; a differing first parent → 4.10 `base-drift-post-merge` (incident, never success); fewer than two parents → 4.10 with the shape recorded |
| `409` | The head moved (CAS rejection) | 4.1 `head-drift` |
| `405` | Not mergeable | One classifying re-read → 4.3 / 4.4 / 4.15 as the read dictates |
| `403` | Permission | 4.8 |
| `404` | PR or repository unreachable with this credential | 4.8 |
| `422` | Malformed request or unsupported method | 4.12 |
| `5xx`, timeout, or an unparseable body | Unknown | **One** classifying re-read; merged → the §5.1 replay determination; unmerged → 4.8. Never a second merge attempt |

### 11.4 Disarm and readback (SPEC §3 precondition 10)

If, despite §11.2's positive determination, a mutating call returns with the
PR unmerged and an armed state observed:

- `autoMergeRequest` non-`null` → mutation
  `disablePullRequestAutoMerge(input:{pullRequestId:$prId}) { pullRequest { id } }`;
- `mergeQueueEntry` non-`null` → mutation
  `dequeuePullRequest(input:{id:$mergeQueueEntryId}) { mergeQueueEntry { id } }`;
- after each, a **post-disarm readback** re-runs §11.1 and requires
  `autoMergeRequest === null` **and** `mergeQueueEntry === null`.

A readback that still shows an armed state, a mutation returning `errors`, or
a mutation whose field the schema gate did not confirm is recorded **inside**
the 4.15 stop as an armed-state incident demanding immediate human action, and
the stop question presents it first. The executor never enqueues, never arms
auto-merge, and never sends `--admin`-equivalent parameters — there is no code
path that constructs one (Step 6).

## 12. Stop and recovery matrix (control-plane states and dispositions)

"Stop state" means: run SUCCESS, task **REVIEW**, successor not activated, no
"Chain complete", stop question open, and every generic retry, status, and
run-creating route refused (§D-P7). All stops leave the PR unmerged except
4.10 and 4.13, which say so.

| # | Condition | Landing | Choices → disposition → transition |
|---|---|---|---|
| 4.1 | `head-drift` | Stop state | `re-authorize` → `refresh-requested` → confirmation card; approving it writes a fresh record and the budget-exempt run, REVIEW→TODO. `abandon` → `terminal-abandoned` → DONE |
| 4.2 | `base-drift` (pre-merge) | Stop state | as 4.1 |
| 4.3 | `check-failure-or-absence` | Stop state; failing or missing check named | fix outside the contract, then `re-authorize` (a fresh record is required even at an unchanged head, because the evidence changed) / `abandon` |
| 4.4 | `non-clean-mergeability` | Stop state; observed values recorded | resolve outside the contract (a conflict resolution changes the head), then `re-authorize` / `abandon` |
| 4.5 | `missing-authorization` | Stop state; nothing consumed | `re-authorize` (produces the missing record) / `abandon` |
| 4.6 | `superseded-authorization` | Stop state | `re-authorize` / `abandon` |
| 4.7 | `retroactive-authorization` | Stop state; the retroactive record refused and recorded | `re-authorize` / `abandon` |
| 4.8 | `api-error` | Stop state after one classifying re-read (and the §11.4 disarm if armed) | `re-authorize` / `abandon` |
| 4.9 | `ambiguity` | Stop state; the ambiguity described, including forged near-matches counted by the read route | `re-authorize` (one fresh record supersedes) / `abandon` |
| 4.10 | `base-drift-post-merge` — **merged on an unauthorized base; incident** | REVIEW until answered | `accept` → `terminal-done` → DONE with explicit acceptance recorded; `revert` → `terminal-done` → DONE with the decision recorded (the revert itself is new, separately authorized work; this contract grants no revert authority) |
| 4.11 | `unresolved-mergeability` | Stop state; values and poll count recorded | `re-authorize` when settled / `abandon` |
| 4.12 | `payload-mismatch` | Stop state | `re-authorize` / `abandon` |
| 4.13 | `changed-underneath-me` — **merged by someone else** | REVIEW until answered | `accept-foreign-merge` → `terminal-done` → DONE with responsibility recorded; `flag-incident` → `nonterminal` → stays REVIEW, **a fresh OPEN follow-up question is created with `accept-foreign-merge` / `abandon`**, and every generic route stays refused until one of those is answered |
| 4.14 | `target-unresolvable` | Stop state; the observed run records described | `open-repair` → `repair-requested` → `POST /tasks/:taskId/merge-target` with a PR number from the chain's own observed set writes the correction and requests a confirmation card; approving it yields a fresh authorization and run. `abandon` → DONE. **`re-authorize` is not offered** — it could not change the inputs |
| 4.15 | `deferred-merge-machinery` | Stop state; §11.4 disarm performed and read back before the stop is recorded; a disarm failure escalated inside the stop as an armed-state incident presented first | remove queue governance outside the contract, then `re-authorize` / `abandon` |
| — | `missing-or-malformed-result` (fail-closed default) | Stop state, control-plane-landed, nothing synthesized | `re-authorize` (the fresh run re-executes from scratch) / `abandon` |

Crash (run FAILURE): today's automatic retry, now bounded by the unraised
ceiling (§D-P5); the retry re-enters full verification and replay from scratch
and lands whatever the world calls for. A recorded stop is never auto-retried.

## 13. Cross-work dependency: PR #94 (Goal 5a0) — re-checked at master

The prior plan carried a standing obligation to re-check this plan against
merged master. Done, this session:

- **PR #94 is now MERGED**, as commit `8e66e202237347df37059ed4967bd99250c4ad69`
  ("Merge pull request #94"). `git diff --stat 8e66e202^1 8e66e202` shows
  **exactly three files, all under `docs/`**: the Goal 5a0 spec, its plan, and
  its plan review. **No source, no schema, no migration, no seed, and no
  script landed.** PR #95 (Inbox 3a) merged the same way, three documents.
- **Consequence for this plan:** there is no landed typed-record implementation
  to re-target. Goal 5a0's four `metadata.kind` literals
  (`goal5a0.implementation_identity`, `goal5a0.merge_authorization`,
  `goal5a0.merge_handoff`, `goal5a0.merge_invalidated`, `schemaVersion: 1`)
  exist only as specification text; this plan's `mergeIntegrator.*` namespace
  is disjoint by construction and no collision is possible. The
  `{ kind, schemaVersion }` envelope shape is deliberately shared, so if a
  generalized typed authorization record carrying SPEC §8.2/§8.3's properties
  is later implemented, Step 1's module re-targets it with no change to
  Steps 4–6's behavior.
- **Precedence, per SPEC §9, unchanged:** on the *shape* of the
  authorization record, PR #94 wins; on *integrator behavior* — execution-time
  re-verification, fail-closed stops, idempotency from durable platform state,
  custody per §5.2 — this contract wins, and no authorization-surface redesign
  may weaken it without a new Product Contract version and product-owner
  approval.
- **Merge-method policy.** Goal 5a0's merged plan requires this repository's
  settings to reach `{ allowMergeCommit: true, allowSquashMerge: false,
  allowRebaseMerge: false }` before its own dependency gate. #100 pins method
  `merge` per authorization (SPEC D4). These are compatible: if that settings
  change lands first, #100's precondition 6 simply never sees an alternative
  method live. Neither design depends on the other's change, and this plan
  changes no repository setting.
- **Server-bound identity.** Goal 5a0 records that AgentOS cannot attribute an
  operator write to a named human (`auth.ts:18-45`, `app.ts:2717-2728`) and
  names dependency D1 as unimplemented. #100's §8.3 accepts the same gap;
  §D-P2 narrows its consequence by removing the forgeable surface rather than
  by adding attribution. Consistent; neither implements D1.
- **Standing obligation, carried forward:** re-check again immediately before
  any implementation step is authorized, and re-verify that the namespace
  separation and the record-shape precedence still hold against whatever has
  landed by then. Nothing in this plan waits on #94, and nothing in it edits
  #94's files or issue #100.

## 14. Out of scope and ungranted (explicit)

Everything in SPEC §10, restated as this plan's own boundary: the step-9 human
judgment; production migration or activation of the ten-step template (§6.3's
cutover expectations are recorded in Step 7 and the runbook; the cutover
itself is separately authorized and this plan schedules none); AgentOS
credential and auth-model changes (the shared operator token, `actorId`
self-assertion, and the principal and token model are untouched — the Step 3
route and the §D-P1 rule-3 claim rule are authorization-rule additions for the
existing session and runner principals); GitHub Actions or CI work; every
template other than `compound-engineer-workflow`; TaskActivity schema changes;
post-merge incident remediation beyond recording the human's decision; and the
`fs-ext` source/runtime misalignment debt, which this plan does not touch.

**Additionally out of scope for the implementation chain this plan
authorizes,** and specified here only so the runbook can be written:
production migration, service restart, activation, credential provisioning,
OS-user creation, and every launchd operation. Read-only checks and API health
verification are permitted. The repository is never made public.

**Grants:** none. This plan authorizes no implementation, no merge, no
migration, no activation, no provisioning, and no production action; each
remains separately authorized. The provisioning of the dedicated merge
identity, its OS principal, its token file, and the two configuration tokens
is a named prerequisite executed by an operator under its own authority and
verified afterward by the startup gate, N17(b), and N23; this plan only
specifies what must be true of them.

## 15. Evidence discipline notes

- **Base:** master `485fb118db96e3977006a2edc866a38b751ff0e2`. Every
  `file:line` in this document was re-read at that commit during this
  revision. `git diff --stat a4a4ba36 485fb118` returns six documentation
  files and nothing else, so the review's `@a4a4ba3` anchors hold unchanged.
- **No closure is claimed on trust.** §2 records what was re-read and what was
  found, including two facts the prior plan asserted incorrectly
  (`InboxMessage.metadata` does not exist; the external-failure path raises
  `maxRunsPerTask` at `app.ts:3370`).
- **Verified live this session:** `gh` is 2.89.0; `gh pr merge --help`
  documents merge-queue enqueue and auto-merge deferral, offers
  `--match-head-commit`, `--admin`, and `--disable-auto`, and offers no
  queue-removal flag.
- **Not verified this session, and mechanically gated instead:** the GraphQL
  type, field, and enum names in §11 (no authenticated GitHub access was
  available in the planning environment). §D-P6's introspection gate is the
  mechanism that turns a wrong name into a failing test rather than a wrong
  merge. This is stated rather than papered over.
- **Not runnable this session:** the repository's unit suites, because this
  throwaway clone has no installed `tsx` (`node --import tsx --test …` fails
  `ERR_MODULE_NOT_FOUND`). No dependency was installed and no source,
  schema, migration, script, or `package.json` was changed by this revision:
  it adds exactly one revised document.
- **No AgentOS task ID is cited as evidence** anywhere in this plan. The
  SPEC's approval is referenced by its repository-reachable commit
  (`145731947eb7b9af460b2e48da8141f1c69dce27`), the prior plan by
  `75a2802d28c3e90b2e0eae0ccac469b2c8a198f2`, and PR #94 by its merge commit
  (`8e66e202237347df37059ed4967bd99250c4ad69`).
