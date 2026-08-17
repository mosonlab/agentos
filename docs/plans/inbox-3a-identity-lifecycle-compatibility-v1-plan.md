# Inbox 3a v1.0 implementation plan

Branch: `agentos/chain/w2-2026-08-17-inbox-3a-p-38f03953`

Contract: `Inbox 3a` v1.0 / wire version `inbox.question.v1`

Route: Routing Contract v1.0 · Planned Critical · future implementation agent `senior-dev` at high effort

This plan adds a normalized Question/Answer/ResumeRequest control model beside the current Inbox tables and makes one database transaction module the only lifecycle writer. It preserves current `InboxMessage`, `InboxDecision`, `Session.resumeInput`, and message routes as one-way compatibility projections while API, runner, Feishu, and web consumers move behind explicit rollout modes. It cuts over only through reviewed preflight, shadow, canary, invariant, and rollback gates, and it fails closed whenever actor, correlation, or provider-start identity is ambiguous.

## Authority, prerequisites, and stop conditions

- The approved authority is [`docs/specs/inbox-3a-durable-question-resume-contract-v1.md`](../specs/inbox-3a-durable-question-resume-contract-v1.md) plus [`docs/governance/task-routing-v1.md`](../governance/task-routing-v1.md). A change to scope, acceptance, evidence, assumptions A1-A9, route, or safeguards requires a new Product Contract version and product-owner approval.
- This planning branch is grounded at commit `eff140346133d3f3efd98256775a95ece2c9a5ad`; it contains no local `master` ref. The implementation branch must start with step 1 against a freshly fetched current master and must not reuse this snapshot as current authority.
- Goal 5a1 implementation remains blocked until Inbox 3a and Goal 5a0 are complete. Inbox 3a implementation may proceed independently only after step 1 records a safe write-surface result.
- Stop rather than infer if current master changes the Inbox, workflow, runner claim/start, reconcile, notification, web, schema, migration, or authentication ownership described below.
- Stop for product-owner approval before expanding the answer shape, allowing more than one active question per Run/Session, retrying automatically after an ambiguous provider start, weakening external actor mapping, inferring a question from chat membership/text, or changing omitted-expiry seven-day / explicit-null indefinite behavior.
- No step in this plan authorizes a production migration, service restart, Goal-router change, automatic waiver, public-repository action, destructive contraction, or Goal 5a1 integration.

## Fixed implementation decisions

1. **Single deep transaction module.** Add `packages/db/src/inbox-v1.ts` as the only writer of Question, Answer, ResumeRequest, lifecycle-event, and Run/Session compatibility state. Rejected option: separate API and Feishu mutations would recreate two state machines and make cross-channel CAS behavior unprovable.
2. **Additive sidecar schema.** Keep `InboxMessage`, `InboxDecision`, and legacy Session columns through the rollback window; normalized v1 rows become authoritative after the write flag flips. Rejected option: in-place reinterpretation of `InboxMessage` cannot preserve distinct immutable identities or safe rollback.
3. **Configured single-operator mapping.** `OPERATOR_ACTOR_ID` identifies the web operator; `(FEISHU, FEISHU_APP_ID, FEISHU_OPERATOR_OPEN_ID)` maps the sole authorized notification actor, and every accepted/rejected attempt stores authorization evidence. Rejected option: adding actor-management CRUD is an unrelated Inbox redesign; chat membership remains non-authoritative.
4. **Stable source identity, never prompt identity.** MCP uses the JSON-RPC tool-call request id and Pi uses `_toolCallId` as the create idempotency key. Rejected option: hashing/truncating prompt text aliases distinct questions and violates the approved contract.
5. **Legacy runner safety over liveness.** While `INBOX_V1_LEGACY_RUNNER_COMPAT=1`, a runner without resume-grant capability moves its claimed ResumeRequest to `STARTING` before the claim response exposes legacy `resumeInput`; loss after claim is therefore ambiguous and never automatically retried. Rejected option: letting an old runner invoke first and report `/start` later preserves liveness but loses the durable pre-provider boundary.
6. **One-way rollout modes.** API writes, reads, runner hand-off, notification ingestion, and legacy projection have explicit environment-controlled modes parsed by one shared config module; no dual business-logic writer exists. Rejected option: a big-bang switch gives no shadow comparison, controlled canary, or safe code rollback.
7. **Durable, database-derived observability.** Append-only events and delivery attempts supply counters/ages/invariant metrics through an operator-only endpoint, while a shared structured logger emits redacted JSON. Rejected option: process-memory-only counters lose evidence on the control-plane restart that this contract must survive.

## Ordered implementation steps

### 1. Revalidate current master and approve the write surface

**Requirements:** dependency and authority gates; spec §§3, 16.1(1), 18.

**Change:** Create `docs/reviews/inbox-3a-write-surface-review.md`. Fetch `origin/master`, record its exact SHA and the implementation base SHA, then compare these current symbols and all new intervening migrations: `suspendForInbox` in `packages/api/src/inbox.ts`; Inbox schemas and routes in `packages/api/src/app.ts`; `gateQuestion`, `applyInboxDecisionTx`, and `applyInboxDecision` in `packages/db/src/workflow.ts`; `reconcileDatabaseRuns` in `packages/api/src/reconcile.ts`; `processFeishuEvent` in `packages/inbox/src/events.ts`; `deliverPending` in `packages/inbox/src/delivery.ts`; `executeClaim` in `packages/runner/src/runner.ts`; `ClaimedTask`, `claimTask`, and `startRun` in `packages/runner/src/api.ts`; `InboxPage`/`InboxThreadPage` in `apps/web/src/pages/Inbox.tsx`; `packages/db/prisma/schema.prisma`; and every migration after `20260817020000_chain_branch_and_pr`. Record Goal 5a0's current branch/status and identify any overlapping write surface; conclude exactly `SAFE_TO_IMPLEMENT` or `STOPPED_FOR_REROUTE`, with owners for every overlap. Do not edit runtime code until this review says `SAFE_TO_IMPLEMENT`.

**Depends on:** none.

**Verify:** `git fetch origin master && git diff --name-status origin/master...HEAD -- packages/api/src/inbox.ts packages/api/src/app.ts packages/api/src/reconcile.ts packages/db/src/workflow.ts packages/db/prisma packages/inbox/src packages/runner/src apps/web/src/pages/Inbox.tsx > /tmp/inbox-3a-surface.diff && test -s docs/reviews/inbox-3a-write-surface-review.md && rg -n 'current master SHA|Goal 5a0|SAFE_TO_IMPLEMENT|STOPPED_FOR_REROUTE' docs/reviews/inbox-3a-write-surface-review.md`

### 2. Land the additive v1 schema and database-enforced invariants

**Requirements:** distinct identities, ownership, correlation, immutability, constraints, append-only evidence, active-question uniqueness; spec §§4-6, 10.3, 13.3, 17 identity/correlation rows.

**Change:** Extend `packages/db/prisma/schema.prisma` and add `packages/db/prisma/migrations/20260817040000_inbox_question_v1_expand/migration.sql`. Add enums for Question state/purpose/response mode, Answer kind/source, ResumeRequest state, event type/outcome, and delivery-attempt outcome. Add normalized models `InboxQuestion`, `InboxQuestionChoice`, `InboxAnswer`, `InboxResumeRequest`, `InboxQuestionEvent`, `InboxAuthorizationEvidence`, `InboxNotificationDelivery`, and `InboxNotificationDeliveryAttempt`; extend `InboxExternalEvent` with channel-account scoping, canonical payload hash, result linkage, and redacted processing outcome; add `Session.waitingOnQuestionId` while retaining `waitingOnMessageId`, `resumeInput`, and `resumeAttempt`. Use composite Project-scoped foreign keys to the correlated Goal/Task/Run/Session/Agent snapshots, `RESTRICT` for audit-bearing links, unique prompt/answer/resume/source identities, check constraints for typed answers and required resumable correlations, and raw partial unique indexes for one active `RESUME_EXECUTION` Question and one nonterminal ResumeRequest per Run and Session. Add SQL triggers that reject Answer mutation, mutation of Question creation/correlation/prompt/response/expiry fields, and UPDATE/DELETE of Question events, authorization evidence, and delivery attempts; lifecycle writers may update only the enumerated state/version/link/timestamp/reason columns. Retain the existing globally unique legacy external ids during expansion and add the authoritative `(channel, accountId, externalId)` indexes; remove over-restrictive legacy indexes only in a separately approved contraction migration.

Add schema assertions to `packages/api/src/inbox-v1-migration.dbtest.ts` for every enum, table, FK, check, and partial index, including negative cross-project inserts and duplicate active Run/Session inserts. Do not backfill or change an existing row in this migration.

**Depends on:** step 1.

**Verify:** `npm run db:validate && npm run db:generate && npm run typecheck -w @agentos/db && npm run test:db -w @agentos/api -- --test-name-pattern='Inbox v1 schema'`

### 3. Define canonical contract, hashing, grants, errors, and rollout configuration

**Requirements:** wire version, validation bounds, canonical hashes, idempotency, secret handling, configured actor identity, rollout flags; spec §§5.1(6-7), 6.1-6.4, 9, 10, 16.

**Change:** Add `packages/db/src/inbox-contract.ts` and export it from `packages/db/src/index.ts`. Define `INBOX_QUESTION_CONTRACT_VERSION`, wire/domain input and result types, case-sensitive enum parsing, Unicode-NFC sorted-key JSON canonicalization with array order preserved, SHA-256 lowercase hashes, `InboxContractError` with the approved HTTP/error-code mapping, and helpers that generate random resume grants but persist/compare only their SHA-256 hashes and expiries. Add `packages/db/src/inbox-config.ts` with a fail-closed parser for `INBOX_V1_WRITE_MODE=off|canary|on`, `INBOX_V1_READ_MODE=legacy|shadow|v1`, `INBOX_V1_RUNNER_MODE=off|canary|on`, `INBOX_V1_NOTIFICATION_MODE=off|canary|on`, `INBOX_V1_CANARY_RUN_IDS`, `INBOX_V1_LEGACY_PROJECTION`, `INBOX_V1_LEGACY_RUNNER_COMPAT`, `OPERATOR_ACTOR_ID`, `FEISHU_OPERATOR_OPEN_ID`, and `INBOX_ACTION_SIGNING_KEY`; require actor/signing configuration before the corresponding v1 mode can activate.

Add `packages/db/src/inbox-contract.test.ts`, a `test` script in `packages/db/package.json`, and root script passthroughs where needed. Update `.env.example` and `README.md` with names and safe defaults only—never real tokens, actor ids, chat ids, or signing keys.

**Depends on:** step 2.

**Verify:** `npm run test -w @agentos/db && npm run typecheck -w @agentos/db && rg -n 'INBOX_V1_WRITE_MODE|OPERATOR_ACTOR_ID|FEISHU_OPERATOR_OPEN_ID|INBOX_ACTION_SIGNING_KEY' .env.example README.md`

### 4. Implement the authoritative Question lifecycle transaction module

**Requirements:** atomic suspension, typed answers, immutable winner, harmless duplicates, lifecycle edges, supersede/cancel/expiry races, audit events, same Run/Session; spec §§5, 6.2-6.4, 7, 8 S1-S5/S10-S12.

**Change:** Add `packages/db/src/inbox-v1.ts`, export it from `packages/db/src/index.ts`, and add focused tests in `packages/db/src/inbox-v1.test.ts`. Implement these explicit entry points: `createInboxQuestionV1`, `answerInboxQuestionV1`, `supersedeInboxQuestionV1`, `cancelInboxQuestionV1`, `expireInboxQuestionV1`, `recordRejectedInboxMutation`, `getInboxQuestionV1`, and `listInboxQuestionsV1`. Creation derives Project/Goal/Task/Run/Session/Agent from the fenced Session, requires the provider conversation id, writes prompt Message + Question + choices + initial event + optional delivery row, fences/releases the lease, revokes the Session token, retains the workspace, and sets Run/Session waiting in one serializable transaction. Answering validates the immutable response mode without trimming stored free text, CASes `WAITING`, writes Answer + answer Message + authorization evidence + ResumeRequest + events, queues the same Run, requests the same Session, and writes legacy projections in one transaction; an identical source/idempotency replay returns the original result and a conflicting reuse returns `IDEMPOTENCY_KEY_REUSED` without writes. If a later authorized source submits the same canonical answer for the same Question/actor after the CAS winner, record that source event and return the immutable original with `duplicate: true`; if its canonical answer differs, return `QUESTION_ALREADY_ANSWERED` and never alter the winner.

Implement every legal and illegal edge from spec §7 with state/stateVersion CAS and ordered per-question event sequence. Supersede atomically terminalizes only `WAITING`, creates the replacement, moves `Session.waitingOnQuestionId`, invalidates old deliveries, and leaves the Run waiting; cancellation/expiry share the same mutex as answer and never coerce `STARTING` ambiguity to cancelled. All rejected transitions append redacted evidence without prompt/answer/token/grant/provider-id content.

**Depends on:** steps 2-3.

**Verify:** `npm run test -w @agentos/db -- --test-name-pattern='Inbox v1' && npm run typecheck -w @agentos/db`

### 5. Expose the authenticated v1 HTTP API and exact wire projections

**Requirements:** create/read/answer/supersede/cancel API, principal isolation, exact correlations, stable errors, cursor/filter/count behavior; spec §§6.1, 8, 9.1-9.4, 10.1, 11.2-11.3.

**Change:** Refactor `packages/api/src/inbox.ts` into the HTTP-facing parser/projector over step 4 and update `packages/api/src/app.ts`, `packages/api/src/auth.ts`, `packages/api/src/app.test.ts`, and `packages/api/src/inbox.test.ts`. Make operator principals carry the configured stable `operatorActorId`; keep Session and runner access path-bound and return 404 without existence disclosure for cross-principal reads. Replace the create body with the exact `inbox.question.v1` contract, derive all correlations server-side, default omitted expiry to seven days and preserve explicit `null`, reject duplicate choice ids/unknown versions/enums, and return 201/200 duplicate/409/422 codes exactly as specified.

Add `GET /inbox/questions`, `GET /inbox/questions/:questionId`, `POST /inbox/questions/:questionId/answers`, `/supersede`, `/cancel`, and `POST /inbox/questions/:questionId/resume/retry-safe`. Define `state` as a comma-separated set of exact states, return `{items,nextCursor,counts}` with opaque `(createdAt,id)` cursor pagination, and return prompt/accepted answer/history/delivery/redacted ResumeRequest on detail. The safe-retry endpoint is operator-only, accepts an idempotency key/reason, and may requeue the same Run/ResumeRequest only from `BLOCKED_SAFE`; it rejects `STARTING`/`BLOCKED_AMBIGUOUS` and never creates a Run.

**Depends on:** step 4.

**Verify:** `npm run test -w @agentos/api -- --test-name-pattern='Inbox v1|principal' && npm run typecheck -w @agentos/api`

### 6. Route approval gates and every legacy Inbox path through v1

**Requirements:** approval-gate semantics retained, legacy API compatibility, one-way projections, deprecation, no dual writer; spec §§2.2, 5.4, 9.6, 13.1, 13.3, 19(6).

**Change:** Update `gateQuestion`, `applyInboxDecisionTx`, and `applyInboxDecision` in `packages/db/src/workflow.ts`; the gate close paths around Task PATCH/completion in `packages/api/src/app.ts`; and their tests in `packages/api/src/workflow.test.ts` and `packages/api/src/app.test.ts`. `gateQuestion` creates purpose `APPROVAL_GATE` through `createInboxQuestionV1`; `answerInboxQuestionV1` invokes the existing Task-row lock order and approve/reject chain effects but creates no ResumeRequest unless its exact correlated Run is `WAITING_INBOX`. Preserve sibling-card exclusion by one gate-question identity, not by multiple v1 Questions.

Make `POST /inbox/messages/:id/decision` and `/reply` resolve `:id` only through an exact `promptMessageId` mapping and call the v1 answer service; add deprecation/sunset headers and remove independent legacy mutation logic. Make `GET /inbox/messages` a v1-derived legacy projection when `INBOX_V1_READ_MODE` is `shadow|v1`; in `shadow`, compare legacy and v1 projections and record a discrepancy event without changing the response. Write `InboxMessage.status`, `selectedChoiceId`, message delivery fields, `Session.waitingOnMessageId`, `resumeInput`, and `resumeAttempt` only as same-transaction projections while `INBOX_V1_LEGACY_PROJECTION=1`.

**Depends on:** steps 4-5.

**Verify:** `npm run test -w @agentos/api -- --test-name-pattern='approval gate|legacy Inbox|projection' && npm run typecheck -w @agentos/api`

### 7. Add the fenced ResumeRequest claim/start/confirm control-plane protocol

**Requirements:** exactly one logical resume, current fence/grant on every callback, ACKNOWLEDGED/STARTING/RESUMED semantics, safe/ambiguous blocking, legacy mixed-fleet safety; spec §§5.3, 5.4(6), 6.1, 7.1, 7.4, 9.5, 13.3(5), 14.2.

**Change:** Extend `packages/db/src/inbox-v1.ts` with `claimInboxResumeRequest`, `markInboxResumeStarting`, `confirmInboxResumeStarted`, `blockInboxResumeSafe`, `blockInboxResumeAmbiguous`, and `requeueBlockedSafeResume`. A winning Run claim atomically CASes `PENDING|BLOCKED_SAFE -> CLAIMED`, increments claim generation, stores runner/lease generation and grant hash/expiry, transitions Question `ANSWERED -> ACKNOWLEDGED`, and returns the plaintext grant once; stale claims receive no answer/provider identity. A same-fence/grant replay returns the existing state, a different/stale credential returns `STALE_RESUME_GRANT`, and a re-claim is allowed only before `STARTING` with a new generation/grant.

Update `claimInput`, the `/runner/tasks/claim` transaction, add `POST /runner/runs/:runId/resume/starting` and `/resume/failure`, and extend `/runner/runs/:runId/start` in `packages/api/src/app.ts`. Bind every operation to runner id, Run fence/lease generation, question/answer/resume ids, grant, workspace, provider-conversation hash, and runtime handle; `start` atomically persists the handle and moves ResumeRequest `STARTING -> STARTED`, Question `ACKNOWLEDGED -> RESUMED`, and Run/Session to running. Under the explicit legacy compatibility flag, detect missing `resumeGrantV1` capability from claim telemetry and set `STARTING` inside the claim transaction before returning the legacy resume projection; otherwise never accept a resume callback without ids/grant.

**Depends on:** steps 4-6.

**Verify:** `npm run test -w @agentos/api -- --test-name-pattern='resume grant|resume starting|legacy runner' && npm run typecheck -w @agentos/api`

### 8. Move all three runners onto the durable pre-provider boundary

**Requirements:** provider invocation boundary, one existing Run/Session, safe pre-start recovery, three runner kinds, stable MCP/Pi source identity; spec §§5.3(5-9), 7.4, 8 S7-S9, 9.1, 9.5, 14.2.

**Change:** Update `ClaimedTask`, `claimRequestBody`, `claimTask`, and `startRun` in `packages/runner/src/api.ts`; add `markResumeStarting` and `reportResumeFailure`; update `executeClaim` in `packages/runner/src/runner.ts`; and extend `packages/runner/src/adapters.ts`, `packages/runner/src/adapters.test.ts`, and new `packages/runner/src/resume.test.ts`. The claim resume envelope carries question/answer/resume ids, grant, provider conversation id, and typed answer; convert a CHOICE to its immutable choice id and FREE_TEXT to exact stored text only at the adapter boundary. Workspace reuse and preflight happen before `markResumeStarting`; their proven failures call `reportResumeFailure(BLOCKED_SAFE)` and stop without `completeRun` or a replacement Run. After `starting` succeeds, invoke `adapter.resume` exactly once in that process; only adapter evidence that definitively proves the provider rejected before accepting a continuation may report `BLOCKED_SAFE`, while every unknown exception/loss without a confirmed handle reports or reconciles `BLOCKED_AMBIGUOUS`, kills the local child if present, and never enters ordinary automatic retry.

Update `invokeTool`/`handleRequest` in `packages/runner/src/mcp-server.ts` and tests in `packages/runner/src/mcp-server.test.ts` so `inbox_ask` uses the non-null JSON-RPC `tools/call` request id as `idempotencyKey`. Update `packages/runner/assets/pi-agentos-extension.ts` to use Pi's `_toolCallId`; both send the v1 contract and never derive identity from prompt bytes. Table-drive deterministic fake resumes for CLAUDE, CODEX, and PI and assert `starting` precedes adapter invocation and `start` confirmation follows a runtime handle.

**Depends on:** step 7.

**Verify:** `npm run test -w @agentos/runner -- --test-name-pattern='resume|inbox_ask' && npm run typecheck -w @agentos/runner`

### 9. Reconcile expiry, claims, start ambiguity, and restart recovery from the database

**Requirements:** expiry/cancel races, safe/ambiguous recovery, control-plane restart reconstruction, no automatic retry/new Run; spec §§7.3-7.4, 8 S8-S11, 14.2, 15.3.

**Change:** Update `reconcileDatabaseRuns` and startup tests in `packages/api/src/reconcile.ts` and `packages/api/src/reconcile.test.ts`. Replace `Session.resumableUntil`/message-status expiry authority with `InboxQuestion.expiresAt` plus `expireInboxQuestionV1`; preserve legacy columns only as projections. Reconcile expired `CLAIMED` ResumeRequests that never reached `STARTING` back to safely claimable state under a rotated generation; reconcile unresolved `STARTING` to `BLOCKED_AMBIGUOUS`, make the existing Run non-retryable/lease-less, revoke tokens, retain the workspace, and move its Task to `REVIEW` with ids/reason code. Keep `ANSWERED` waiting for a runner and `ACKNOWLEDGED` before `STARTING` recoverable on the same Run/ResumeRequest; exclude v1 resume Runs from the existing orphan logic that creates a new Run.

Add fault points around each create/suspend and answer/queue write and after `STARTING`, exposed only to tests through injected callbacks, so rollback/ambiguity behavior is deterministic without production flags.

**Depends on:** steps 7-8.

**Verify:** `npm run test -w @agentos/api -- --test-name-pattern='Inbox|STARTING|BLOCKED_AMBIGUOUS|response window' && npm run typecheck -w @agentos/api`

### 10. Extract the notification adapter and enforce Feishu actor/action/reply identity

**Requirements:** adapter contract, authorized external actor mapping, explicit signed binding, scoped source ids, inert unmatched text, harmless duplicate events; spec §§5.1(7), 5.5, 8 S3/S5/S6/S10, 10.1-10.2, 12.

**Change:** Add `packages/inbox/src/adapter.ts` with the exact `NotificationAdapter` boundary and `packages/inbox/src/feishu.ts` implementing verification/parsing; update `packages/inbox/src/cards.ts`, `packages/inbox/src/events.ts`, `packages/inbox/src/index.ts`, and `packages/inbox/src/events.test.ts`. Scope every event/message identity by `FEISHU_APP_ID`, verify Feishu's envelope before parsing, and map only `FEISHU_OPERATOR_OPEN_ID` to `OPERATOR_ACTOR_ID`; unknown/missing/mismatched actors return `ACTOR_NOT_AUTHORIZED` and append authorization/rejection evidence. Sign action bindings with version, question id, delivery id, choice id, rendering version, and expiry using `INBOX_ACTION_SIGNING_KEY`; require text to explicitly reply to the recorded external prompt message and its matching chat/account/delivery. Delete the “only open question in chat” query entirely.

Preserve unmatched text as an inert human `InboxMessage` plus processed source event. Duplicate external events return the original processing result; stale superseded/cancelled actions return their exact conflict and replacement link; Feishu toasts say only “answer received,” never “resumed.” Keep Feishu the sole adapter.

**Depends on:** steps 4-6.

**Verify:** `npm run test -w @agentos/inbox -- --test-name-pattern='event|actor|binding|unmatched|duplicate' && npm run typecheck -w @agentos/inbox`

### 11. Move delivery to durable per-destination claims and attempt evidence

**Requirements:** Question persistence independent of send, delivery idempotency, CAS/lease/restart recovery, duplicate card harmlessness, bounded backoff/alerts; spec §§5.4(2), 6.3 delivery rows, 12.2, 14.1(10), 14.2.

**Change:** Rewrite `deliverPending` in `packages/inbox/src/delivery.ts`, update startup recovery in `packages/inbox/src/index.ts`, and extend `packages/inbox/src/delivery.test.ts`. Claim `InboxNotificationDelivery` by state/version/lease, append an `InboxNotificationDeliveryAttempt` for every try, render from the immutable Question snapshot, and use `deliveryId` as the adapter idempotency key. Persist all returned scoped external message identities; tolerate duplicate cards because the Question CAS remains authoritative. On restart, expire only abandoned delivery leases; on timeout/failure, apply bounded exponential backoff and record a redacted Task activity/metric at threshold without cancelling the Question or disabling web answers.

Keep legacy message-level delivery fields as step 6 projections from the primary Feishu delivery row. Add a two-worker race, timeout-after-send duplicate, restart, threshold, and web-path-independence tests.

**Depends on:** steps 2, 4, and 10.

**Verify:** `npm run test -w @agentos/inbox -- --test-name-pattern='delivery|worker|restart' && npm run typecheck -w @agentos/inbox`

### 12. Replace the message-centric web Inbox with Question lifecycle UI

**Requirements:** actionable question identity, three filter groups/all six states, typed answers, stable retries, correlations, duplicate/conflict/blocked displays, delivery independence; spec §§9.2-9.4, 11, 17 UI row.

**Change:** Update wire types in `apps/web/src/lib/types.ts`, preserve machine `code`/current-state fields in `ApiError` in `apps/web/src/lib/api.ts`, and replace `InboxPage`/`InboxThreadPage` in `apps/web/src/pages/Inbox.tsx`. Update routes in `apps/web/src/App.tsx` to `/inbox/questions/:questionId`; retain `/inbox/:messageId` as `LegacyInboxRedirectPage`, which resolves once through the legacy detail endpoint and redirects only on an exact mapping. Query server filters/counts for Waiting, In progress (`ANSWERED`,`ACKNOWLEDGED`), and Finished (`RESUMED`,`SUPERSEDED`,`CANCELLED`); show purpose, lifecycle, timestamps, actor/source, delivery, and Goal/Task/Run/Session links.

Render immutable choice ids and free text according to response mode, and keep mixed mode as two real answer kinds. Generate one `crypto.randomUUID()` when a submission begins, retain it in component state through network retries, clear it only after a definitive server result, and wait for that result before showing acceptance. Render duplicate success, already-answered current state, replacement links, cancellation reason, ACKNOWLEDGED wording, RESUMED links, and BLOCKED_SAFE/BLOCKED_AMBIGUOUS actions exactly; keep unmatched Message rows non-actionable and delivery failure independent.

Update `apps/web/src/locales/en.ts` and `apps/web/src/locales/zh.ts`, Session Inbox links in `apps/web/src/pages/Sessions.tsx`, and tests in new `apps/web/src/tests/inbox.test.tsx` plus `apps/web/src/tests/sessions.test.tsx`. Tests must click both answer kinds, force a retry, assert one idempotency key, and render every lifecycle/resume failure state.

**Depends on:** steps 5-6.

**Verify:** `npm run test -w @agentos/web -- --test-name-pattern='Inbox|inbox' && npm run build -w @agentos/web && npm run typecheck -w @agentos/web`

### 13. Build restartable preflight, backfill, shadow comparison, and invariant tooling

**Requirements:** every legacy mapping row, active quarantine, historical low confidence, idempotent rerun, one-way projection, cutover checksums; spec §13 and final acceptance evidence items 1/8.

**Change:** Add `packages/db/src/inbox-migration.ts` with exported `preflightInboxV1`, `backfillInboxV1`, `compareInboxV1Projection`, and `verifyInboxV1Invariants`; add CLIs `packages/db/prisma/precheck-inbox-v1.ts`, `backfill-inbox-v1.ts`, and `verify-inbox-v1.ts`; export root/workspace scripts in `packages/db/package.json` and `package.json`. Page by stable primary-key cursors, attach a migration run id, deterministic legacy-source key, payload hash, and confidence/reason to every backfilled row, retain bounded diagnostics, and exit nonzero on any active ambiguity or failed row. Map every row in spec §13.1 exactly; never infer `ANSWERED` vs `ACKNOWLEDGED` vs `RESUMED`, selected choices, actors, or correlations beyond evidence.

Expand `packages/api/src/inbox-v1-migration.dbtest.ts` with fixtures for every preflight anomaly and mapping row, simultaneous/repeated backfills, active quarantine, historical LOW confidence, projection agreement, and the invariant query. Require a second completed backfill to create/update zero rows and the invariant verifier to report zero duplicate active Questions, Answers, ResumeRequests, and correlation mismatches.

**Depends on:** steps 2, 4, and 6.

**Verify:** `npm run test:db -w @agentos/api -- --test-name-pattern='Inbox v1 migration|backfill|invariant' && npm run db:validate && npm run typecheck -w @agentos/db`

### 14. Prove every required race and failure boundary with real transactions

**Requirements:** all 16 races, atomic fault injection, authorization negatives, exactly one automatic provider start, all adapters; spec §§14, 17 and final acceptance items 2-6.

**Change:** Add `packages/api/src/inbox-v1-concurrency.dbtest.ts` and `packages/api/src/inbox-v1-runner.dbtest.ts` using `packages/api/src/testdb.ts` and independent Prisma clients. Cover all 16 races in spec §14.1, including same/different create keys, identical/different answers across WEB/FEISHU sources, answer against expiry/cancel/supersede, old action after supersede, duplicate event, two delivery workers, two runners, stale re-claim callbacks, duplicate `starting`, cancel vs `starting`, reconciler vs confirmation, and sequential questions in one Session. Assert exact row/event/queue/start counts and immutable winner bytes, not only response status.

Use the step 9 fault hooks at every write in create/suspend and answer/queue, and after `STARTING`. Table-drive CLAUDE/CODEX/PI claim-start-confirm flows through the real Hono control-plane transactions while runner adapters are deterministic fakes; assert only the winning runner receives provider/answer/grant data, only one adapter invocation is admitted, safe pre-start can requeue the same request, and ambiguous start produces no automatic request or Run. Add authorization/correlation negatives for web, Session, runner, mapped/unmapped Feishu actor, wrong account/chat, tampered/expired token, and cross-project ids, with one redacted rejected event apiece.

**Depends on:** steps 7-11 and 13.

**Verify:** `npm run test:db -w @agentos/api -- --test-name-pattern='Inbox v1 concurrency|Inbox v1 runner' && npm run test -w @agentos/inbox && npm run test -w @agentos/runner`

### 15. Add redacted structured logs, durable metrics, invariant audits, and alert evidence

**Requirements:** logs, metrics, alerts, operator/task evidence without content/secrets; spec §10.3, §15, §17 observability row.

**Change:** Add `packages/db/src/inbox-observability.ts` and export `logInboxEvent`, `inboxMetricsSnapshot`, and `auditInboxInvariants`. Call the logger from step 4 transitions/rejections, step 7 claim/start callbacks, step 9 reconciliation, step 10 ingestion, step 11 delivery, and step 13 migration; emit one-line JSON with contract version, ids, versions/generations, actor/source class, result/reason, duration, and service instance only. Explicitly exclude prompt/answer text, raw tokens, action signatures, resume grants, raw provider ids, and raw source payloads.

Add operator-only `GET /inbox/observability` in `packages/api/src/app.ts`, returning database-derived state/source counts, WAITING/ANSWERED/ACKNOWLEDGED ages, accepted/duplicate/conflict/validation/auth/correlation results, resume outcomes, delivery ages/attempts/failures/duplicates, migration confidence/quarantine counts, and invariant violations. Add `createInboxAlertScheduler` to `packages/db/src/inbox-observability.ts`, start/stop it from `packages/api/src/index.ts`, and have it periodically emit deduplicated structured errors plus Task activities for every spec §15.3 condition; add fail-closed parsing for its interval/age thresholds to `packages/db/src/inbox-config.ts` and safe examples to `.env.example`. Add `docs/runbooks/inbox-3a-observability.md` with threshold queries/alert conditions and Task-activity id/reason format. Add tests in `packages/api/src/inbox-observability.test.ts` and `packages/api/src/inbox-v1.dbtest.ts` that seed each counter/age/alert, assert the invariant counter stays zero, and scan captured logs/activity metadata for forbidden content and credentials.

**Depends on:** steps 4, 7, 9-11, and 13.

**Verify:** `npm run test -w @agentos/api -- --test-name-pattern='Inbox observability' && npm run test:db -w @agentos/api -- --test-name-pattern='Inbox observability|invariant' && rg -n 'BLOCKED_AMBIGUOUS|ANSWERED|ACKNOWLEDGED|delivery|authorization|invariant' docs/runbooks/inbox-3a-observability.md`

### 16. Write and rehearse the gated rollout and rollback runbook

**Requirements:** all rollout gates, stop conditions, code rollback, no evidence deletion/down migration, legacy contraction separation, Goal 5a1 block; spec §16 and final acceptance item 7.

**Change:** Add `docs/runbooks/inbox-3a-rollout-rollback.md` and `docs/reviews/inbox-3a-staging-rehearsal.md`. The runbook must pin implementation/rehearsal commit, current migration set, backup/precheck/drift commands, backfill count/checksum and second-run-zero expectations, projection comparison, each environment-mode transition, controlled Run ids, API/runner/Feishu/web canaries, all three runner versions/capabilities, activation criteria, legacy traffic proof, and the separately approved contraction gate. State that migration/restart/cutover commands are human-controlled later actions and never embed database credentials or operator/signing tokens.

Make operational rollback a mode/code rollback that leaves additive evidence intact. Before rollback, query and stop on any `STARTING`, `BLOCKED_AMBIGUOUS`, unprojectable active v1 state, grant-incapable consuming runner, active migration ambiguity, checksum/drift/backup failure, or unsafe mixed version; disable new creation, settle only provably safe in-flight work, and revert reads/runners through the maintained one-way projection. Explicitly forbid schema down/drop as operational rollback, coercing ACKNOWLEDGED/SUPERSEDED/ambiguous state to OPEN, deleting audit rows, or starting Goal 5a1. The staging record must contain actual precheck/backfill/projection/canary/rollback/forward-reactivation outputs, zero duplicate provider starts, UI/API/Feishu smoke results, and final invariant output.

**Depends on:** steps 1-15.

**Verify:** On an isolated staging database and services only, execute every command in `docs/runbooks/inbox-3a-rollout-rollback.md`; then run `rg -n 'commit|backup|precheck|checksum|shadow|API canary|runner canary|Feishu|web canary|BLOCKED_AMBIGUOUS|rollback|Goal 5a1|contraction' docs/runbooks/inbox-3a-rollout-rollback.md docs/reviews/inbox-3a-staging-rehearsal.md && npm run db:verify-inbox-v1`

### 17. Assemble final acceptance evidence and run the complete gate

**Requirements:** reviewer acceptance matrix and all eight final evidence artifacts; spec §17.

**Change:** Add `docs/reviews/inbox-3a-acceptance-evidence.md`. Link exact commands/results for schema/preflight/mapping counts; real-database concurrency; CLAUDE/CODEX/PI resume flows; API/auth; web component/browser smoke; Feishu ingestion/delivery; staging rollout/rollback; and the final zero-violation query. Include a requirement-to-test index, commit SHA, environment/mode snapshot with secret values redacted, and honest blockers; do not claim production migration/restart or Goal 5a1 readiness beyond the recorded gates.

Run the full repository gates in the order below, then rerun the dedicated invariant verifier. Review the diff against the step 1 base for scope, credentials, accidental destructive SQL, independent legacy writers, and any new public action. A failing required gate blocks acceptance; do not waive or downgrade it in this task.

**Depends on:** steps 1-16.

**Verify:** `npm run db:validate && npm run build && npm run typecheck && npm test && npm run test:db && npm run db:verify-inbox-v1 && git diff --check && test -s docs/reviews/inbox-3a-acceptance-evidence.md`

## Requirement-to-step map

| Specification requirement | Implemented in | Verified in |
| --- | --- | --- |
| §§1-2 scope, audience, A1-A9 and non-goals | plan authority; steps 1, 16, 17 | steps 1, 16, 17 review gates |
| §3 preserve atomic suspension/current compatibility evidence | steps 1, 4, 6, 9 | steps 4, 6, 9, 14 |
| §4 distinct Message/Question/Answer/ResumeRequest/event/delivery/source terminology | steps 2-4 | steps 2-5, 13 |
| §5.1 identity, immutability, canonical idempotency/scoped external ids | steps 2-4, 10 | steps 2-5, 10, 13-14 |
| §5.2 Project/Goal/Task/Run/Session/Agent correlation and one active question | steps 2, 4-5 | steps 2, 5, 13-14 |
| §5.3 atomic wait, fences, grants, one start, same Run/Session | steps 4, 7-9 | steps 7-9, 14 |
| §5.4 harmless create/delivery/answer/runner duplicates | steps 4, 7, 10-11 | steps 4, 7, 10-11, 14 |
| §5.5 all fail-closed identity/correlation cases and rejected evidence | steps 4-5, 7, 10 | steps 5, 7, 10, 14-15 |
| §6.1 exact v1 wire types and unknown-version rejection | steps 2-3, 5, 7, 12 | steps 3, 5, 7, 12 |
| §6.2 typed choice/free-text validation, bounds, byte preservation, NFC hash | steps 3-5 | steps 3-5, 14 |
| §6.3 persistence constraints and audit retention | step 2 | steps 2, 13-14 |
| §6.4 ownership/allowed writers | steps 4-7, 10-12 | steps 5-7, 10-12, 14 |
| §7.1 legal/illegal lifecycle transitions | steps 4, 7, 9 | steps 4, 7, 9, 14 |
| §7.2 supersede/replacement/stale actions | steps 4-6, 10, 12 | steps 4-6, 10, 12, 14 |
| §7.3 cancel/expiry and `STARTING` race | steps 4-5, 9 | steps 4-5, 9, 14 |
| §7.4 BLOCKED_SAFE/BLOCKED_AMBIGUOUS recovery | steps 5, 7-9, 12 | steps 7-9, 12, 14 |
| §8 S1-S12 concrete scenarios | steps 4-12 | steps 4-14 table-driven scenario tests |
| §9.1 create/MCP stable call identity/default expiry | steps 5, 8 | steps 5, 8, 14 |
| §9.2 reads, filters, cursor, redacted detail | steps 5, 12 | steps 5, 12 |
| §9.3 typed answer/status/error contract | steps 4-5, 12 | steps 4-5, 12, 14 |
| §9.4 supersede/cancel idempotent APIs | steps 4-5 | steps 4-5, 14 |
| §9.5 runner claim/starting/start callbacks | steps 7-8 | steps 7-8, 14 |
| §9.6 legacy endpoints/deprecation/shared service | step 6 | steps 6, 13-14 |
| §10 principals, Feishu mapping/binding, immutable audit ledger | steps 2-5, 7, 10, 15 | steps 5, 7, 10, 14-15 |
| §11 all web lifecycle/answer/correlation/failure behavior | step 12 | steps 12, 16-17 |
| §12 adapter, delivery, retry/restart, explicit ingestion | steps 10-11 | steps 10-11, 14, 16-17 |
| §13.1 every legacy mapping | steps 6, 13 | step 13 fixtures/checksums |
| §13.2 preflight/quarantine/LOW confidence | step 13 | steps 13, 16-17 |
| §13.3 expand/backfill/projection/cutover/contraction rules | steps 2, 6, 13, 16 | steps 2, 6, 13, 16-17 |
| §14.1 all 16 required races | step 14 | step 14 real-database suite |
| §14.2 every recovery row | steps 7-11, 13 | steps 9, 11, 13-14 |
| §15 logs, metrics, alerts, redaction, Task evidence | step 15 | steps 15-17 |
| §16.1 all ten rollout gates and stop conditions | steps 1, 13-16 | steps 13-17 staging evidence |
| §16.2 rollback without deletion/coercion/down migration | step 16 | steps 16-17 rehearsal evidence |
| §17 acceptance matrix and eight evidence artifacts | steps 2-17 | steps 14-17 final gate |
| §18 dependencies, Planned Critical route, `senior-dev`, stop/escalation | plan authority; steps 1, 16-17 | steps 1, 16-17 |
| §19 reviewed human assumptions | fixed decisions; steps 3-12, 16 | steps 4-14 plus human approval gate |
