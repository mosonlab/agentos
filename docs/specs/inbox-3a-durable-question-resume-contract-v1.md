# Inbox 3a — durable question and resume contract

Contract ID: `Inbox 3a`

Contract version: `1.0`

Wire/data version: `inbox.question.v1`

Status: specification for human review; no implementation is authorized by this document

Author: spec agent, 2026-08-17

Revision: 2026-08-17 plan-review closure; clarified provider-acceptance evidence, unbound rejection evidence, and server-derived non-Feishu source identities without changing Product Contract scope

Routing snapshot: Routing Contract v1.0 · Planned Critical · future implementation agent `senior-dev` · high effort

Authority: the task Product Contract and `docs/governance/task-routing-v1.md`. Changing the objective, scope, acceptance semantics, evidence, authority, dependencies, or safety boundary requires a new Product Contract version and product-owner approval.

---

## 1. Problem and audience

AgentOS can currently suspend a running agent on an Inbox question, accept a web or Feishu reply, and queue the same Run for continuation. The path has important safety pieces, but its durable identities and hand-off states are incomplete:

- an `InboxMessage` is simultaneously used as a display message, a question, the state mutex, and the external notification object;
- an accepted answer and a safely started provider continuation are not separate durable facts;
- a Feishu sender is recorded but not mapped to an authorized AgentOS actor;
- inbound text may be associated by “the only open question in this chat,” which is not a durable identity;
- the current status set (`OPEN`, `ANSWERED`, `CLOSED`) cannot distinguish acknowledged, superseded, cancelled, and resumed outcomes;
- `Session.resumeInput` is a mutable hand-off slot rather than an immutable answer/resume record.

The result is unsafe for Goal 5a1, where unattended Goal, Task, Run, and Session activity must be correlated exactly and retries must not wake the wrong execution.

This contract is for:

1. the single human operator answering in the AgentOS web UI or an authorized notification channel;
2. agents that ask one blocking question through their authenticated Session;
3. the control plane that owns durable state and authorization;
4. runner processes that resume a provider conversation;
5. reviewers who must prove concurrency, recovery, migration, and rollback behavior before Goal 5a1 integration.

The intended outcome is one authoritative identity and lifecycle contract in which duplicate answers and retries are harmless, exactly one logical continuation of the suspended execution may start, and any ambiguous actor, question, correlation, or start outcome fails closed.

## 2. Scope, non-goals, and assumptions

### 2.1 In scope

- distinct message, question, answer, lifecycle-event, notification-delivery, and resume-request identities;
- single-choice and free-text answers;
- authenticated actor and source identity;
- Project, Goal, Task, Run, Session, and Agent correlation;
- `WAITING`, `ANSWERED`, `ACKNOWLEDGED`, `SUPERSEDED`, `CANCELLED`, and `RESUMED` question lifecycle;
- idempotent question creation, answer acceptance, notification ingestion, runner claim, and resume start;
- authorization and append-only audit evidence;
- compatibility and migration from the current Inbox and runner suspension flow;
- API, web UI, notification-adapter, test, observability, rollout, and rollback contracts.

### 2.2 Explicitly out of scope

- implementation or an ordered implementation plan in this specification step;
- Goal router behavior, Goal phase selection, or Goal completion semantics;
- automatic waiver of Goal Definition-of-Done items;
- public repository actions;
- performing a production migration, restart, or cutover;
- changing approval-gate approve/reject chain behavior beyond adapting it to the shared identity, authorization, and audit rules;
- a general Inbox redesign, arbitrary chat, message editing/deletion, search, or new navigation architecture;
- multi-question forms, multi-select answers, ranked choices, file answers, or rich answer schemas;
- adding Slack, email, Telegram, or any other new notification channel;
- guaranteeing that a third-party model provider executes a continuation exactly once when that provider exposes no idempotency primitive. AgentOS instead guarantees at-most-one automatic start and fails closed after an ambiguous start boundary.

### 2.3 Assumptions selected for v1

Ambiguities are resolved to the smallest safe behavior:

- **A1 — One blocking question.** One Run/Session may have only one active resumable question. A question contains one prompt, not a form.
- **A2 — Single operator.** The product remains single-operator. Every external channel identity must map to the one configured operator identity; being present in the destination chat is not authorization.
- **A3 — Choice compatibility.** A choice question may declare `allowFreeText`. Legacy choice questions migrate with it enabled because the current UI/Feishu flow accepts direct text. New callers must state it explicitly; omission defaults to `false` on the v1 API.
- **A4 — Default expiry.** Omitted expiry remains seven days; explicit `null` means no automatic expiry. This preserves current behavior.
- **A5 — Acknowledged meaning.** `ACKNOWLEDGED` means an authorized, fenced runner claim has durably received the immutable answer and a resume grant. It does not mean a notification toast was shown.
- **A6 — Resumed meaning.** `RESUMED` means the runner has observed the runner-kind-specific provider-acceptance signal defined in §5.3, and the control plane has durably stored its redacted evidence plus the runtime handle under the current fence. Process spawn, PID allocation, session lookup alone, queuing, or claiming is not resumed.
- **A7 — Same execution.** Answering resumes the existing Run and Session. It never creates a replacement Run or Session. A separate operator retry after a terminal failure is a different product action and is not “the resume.”
- **A8 — Fail closed after ambiguity.** If AgentOS cannot prove whether provider continuation began, it does not invoke the provider again automatically. The Task moves to `REVIEW` with recovery evidence.
- **A9 — Approval gates.** Existing approval-gate cards may use the question/answer identity model with purpose `APPROVAL_GATE`, but they do not create a resume request unless their correlated Run is actually `WAITING_INBOX`.

These assumptions require human review, especially A3, A4, A5/A6, and A8.

## 3. Current-system audit

The following is binding compatibility evidence, not the desired design:

| Current behavior | Evidence | Contract consequence |
| --- | --- | --- |
| Question creation, outbox creation, Run suspension, lease release, workspace retention, and Session waiting state share a serializable transaction. | `packages/api/src/inbox.ts:15-74` | Preserve this atomic boundary. |
| A provider conversation ID is required before suspension. | `packages/api/src/inbox.ts:21-30` | Preserve; missing provider identity is a 409 and no question is created. |
| The question id is currently an `InboxMessage.id`; `Session.waitingOnMessageId` points to it. | `packages/api/src/inbox.ts:36-63`; `packages/db/prisma/schema.prisma:723-738` | Introduce distinct `questionId`; keep a compatibility projection during migration. |
| The current answer mutex is `InboxMessage.status = OPEN`; the accepted answer, human reply message, decision row, Run queue transition, and Session hand-off are transactional. | `packages/db/src/workflow.ts:559-703` | Preserve one transactional answer acceptance, but store an immutable Answer and ResumeRequest. |
| Current duplicate answer behavior returns a no-op after the `OPEN` claim loses. | `packages/db/src/workflow.ts:622-626` | Retain as a documented idempotent response. |
| Feishu events dedupe on external event id, but free text may fall back to the only open question in a chat. | `packages/inbox/src/events.ts:20-56` | Keep external-event dedupe; remove chat-only answer inference. |
| Unmatched inbound text is retained as an inert human message. | `packages/inbox/src/events.ts:59-80` | Preserve as non-question message behavior. |
| Feishu actor `open_id` is evidence only; it is not authorized against an operator mapping. | `packages/inbox/src/events.ts:83-90` | Require actor mapping before answer acceptance. |
| Delivery is a retried Feishu outbox with a compare-and-set `SENDING` claim. | `packages/inbox/src/delivery.ts:15-75` | Generalize behind a notification-adapter contract without adding channels. |
| Answering currently sets the same Run to `QUEUED`, Session to `REQUESTED`, copies text into `resumeInput`, and increments `resumeAttempt`. | `packages/db/src/workflow.ts:692-703` | Keep the same Run/Session, but make ResumeRequest authoritative and legacy fields projections. |
| Runner claim reads `resumeInput`; the runner reuses the workspace and invokes adapter `resume`. | `packages/api/src/app.ts:2618-2621`; `packages/runner/src/runner.ts:136-168` | Bind the hand-off to question, answer, resume request, Run, Session, and fencing generation. |
| The adapter is invoked before `/runner/runs/:runId/start` records the runtime handle. | `packages/runner/src/runner.ts:164-180` | Add a durable pre-invocation boundary; a crash inside the gap must fail closed. |
| Waiting Runs expire by CAS, close the open message, retain the workspace as terminal evidence, and move a Task to review. | `packages/api/src/reconcile.ts:108-255` | Preserve expiry semantics using question identity and event evidence. |
| Web endpoints separate choice decisions and text replies but both call the same mutation. | `packages/api/src/app.ts:2460-2501` | Replace with one typed answer endpoint; keep adapters for legacy clients. |
| Web UI filters only open vs non-open and builds a reply id with `Date.now()`. | `apps/web/src/pages/Inbox.tsx:48-53,129-149` | Render the full lifecycle and use a stable client-generated idempotency key per submission. |
| Current schema stores correlations on `InboxMessage`, answer text in `InboxDecision.decision`, and actor evidence in nullable `actorOpenId`. | `packages/db/prisma/schema.prisma:809-900` | Normalize immutable question/answer/audit identities; retain history during expansion. |

## 4. Normative language and terminology

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative.

- **Message** — immutable human-visible content in an Inbox thread. A prompt message, answer message, system notice, or unmatched inbound message is a Message. A Message alone never resumes execution.
- **Question** — durable control object that asks for exactly one answer and owns lifecycle state. Its prompt is referenced by `promptMessageId`.
- **Answer** — the one immutable accepted response to a Question.
- **ResumeRequest** — the durable one-to-one hand-off from an accepted Answer to the suspended Run/Session.
- **Resume grant** — short-lived, single-purpose credential returned only to the runner that wins the fenced claim for that ResumeRequest.
- **Lifecycle event** — append-only evidence of a Question transition or rejected transition attempt.
- **Source event** — a web request, Feishu event, MCP request, runner callback, reconciler action, migration action, or control-plane action with a stable source id.
- **Provider-acceptance evidence** — append-only, redacted proof that a pinned runner adapter observed its defined continuation-acceptance event for the expected provider conversation after `STARTING`.
- **Mutation attempt** — append-only ingress/source receipt for an answer, supersede, or cancel request. A safely authorized and correlated attempt may bind its Question/result; an unbound rejection keeps `questionId` null because identity is missing, unknown, unauthorized, or correlation-invalid.
- **Active resumable question** — a `RESUME_EXECUTION` question in `WAITING`, `ANSWERED`, or `ACKNOWLEDGED` state whose ResumeRequest is not terminal.
- **Ambiguous start** — AgentOS recorded intent to invoke provider continuation but cannot prove that the provider did or did not accept it.

## 5. Global invariants

### 5.1 Identity and immutability

1. `messageId`, `questionId`, `answerId`, `resumeRequestId`, `deliveryId`, and lifecycle `eventId` are distinct, globally unique, opaque identifiers. No one may substitute for another.
2. A Question references exactly one prompt Message. A Message is at most one Question's prompt.
3. A Question accepts at most one Answer. The accepted Answer is immutable.
4. A resumable Answer creates exactly one ResumeRequest in the same transaction. A ResumeRequest references exactly one Question, Answer, Run, and Session.
5. Prompt body, response mode, choices, correlation, source request identity, and expiry are immutable after Question creation. Replacement uses `SUPERSEDED` plus a new Question.
6. Every mutation carries a stable idempotency/source-event key and a canonical payload hash. Reusing a key with the same payload returns the original result; reusing it with different payload returns `409 IDEMPOTENCY_KEY_REUSED` and performs no write.
7. External channel ids are scoped by channel and account/tenant. A raw Feishu event id or message id is not globally unique without that scope.
8. An unbound mutation-attempt id and a provider-acceptance-evidence id are globally unique identities; neither substitutes for a lifecycle event id or Question id.

### 5.2 Correlation

1. Every Question has a non-null `projectId`.
2. A `RESUME_EXECUTION` Question has non-null `runId`, `sessionId`, and `agentId`.
3. `session.runId` MUST equal `question.runId`; `session.projectId` and `run.projectId` MUST equal `question.projectId`; `agentId`, `taskId`, and `goalId` MUST exactly match the correlated Run/Session snapshot at creation.
4. A Goal-originated Task may legitimately populate both `goalId` and `taskId`; neither field is inferred from a notification thread.
5. The Session's provider conversation id MUST be non-null before a resumable Question is created.
6. There is at most one active resumable Question per Session and per Run. This is enforced by database constraints/CAS, not by a pre-read.
7. Notification destination, external chat, thread, reply parent, Message, Question, actor, Run, and Session correlations must agree. Any mismatch rejects the answer and records an audit event.

### 5.3 Suspension and resume

1. Creating a resumable Question and changing Run/Session to waiting are one serializable transaction.
2. The transaction MUST fence the current Run lease, revoke the asking Session token, clear the runtime handle/in-flight tool, retain the workspace, and set the Session's authoritative `waitingOnQuestionId`.
3. An accepted Answer, ResumeRequest creation, Run `WAITING_INBOX → QUEUED`, and Session `WAITING_INBOX → REQUESTED` are one transaction. If any write fails, none commits.
4. Answering never creates a new Run or Session.
5. Only the correlated Run may consume the ResumeRequest. Runner claim and every resume callback require the current fencing token, lease generation, resume grant, `questionId`, `answerId`, and `resumeRequestId` to agree.
6. At most one runner holds an active resume claim. A stale runner cannot acknowledge, start, complete, heartbeat, or append provider events after suspension or re-claim.
7. AgentOS MUST record a `STARTING` boundary immediately before invoking the provider. If the runner disappears after this boundary and before `RESUMED`, automatic continuation retry is forbidden; the execution fails closed for operator review.
8. A safe pre-start failure may requeue the same Run with the same ResumeRequest. It may not create a new Run.
9. `RESUMED` is written only after provider continuation acceptance and runtime-handle persistence succeed under the same current fence. The only v1 acceptance signals are adapter-specific and version-pinned: CLAUDE requires a well-formed stream-json `system` event with `subtype=init` and `session_id` equal to the requested conversation; CODEX requires `thread.started` with the requested `thread_id` followed by `turn.started`; PI requires a `session` event with the requested `id` followed by `agent_start`. A PID, successful `spawn`, process liveness, the conversation-id event alone for CODEX/PI, stderr silence, or an arbitrary first JSON line is not acceptance.
10. Later Run completion, failure, or cancellation does not rewrite a Question already in `RESUMED`.
11. The acceptance callback MUST atomically persist a unique `InboxResumeAcceptanceEvidence` row containing runner kind, adapter/CLI version, signal kind, canonical signal hash, observed timestamp, expected provider-conversation hash, runtime handle, claim/lease generations, and runner id while moving ResumeRequest `STARTING → STARTED`, Question `ACKNOWLEDGED → RESUMED`, and Run/Session to running. Raw provider event content is not stored in this evidence row. An unrecognized signal or changed CLI event shape leaves the request `STARTING`; it never falls back to spawn-based confirmation.

### 5.4 Harmless duplicates

1. Repeated question creation with the same `(sessionId, sourceRequestId)` and same canonical payload returns the existing Question and does not suspend twice.
2. Repeated delivery events may create delivery-attempt evidence but no duplicate Question.
3. Repeated identical answers return the accepted Answer and ResumeRequest with `duplicate: true`; they never enqueue or resume again.
4. A different answer after one was accepted returns `409 QUESTION_ALREADY_ANSWERED`, includes the current lifecycle state but not secret actor evidence, and causes no side effect.
5. Concurrent web and Feishu answers have one winner determined by the Question state CAS. The losing request is harmless.
6. Repeated runner claim/start callbacks with the same fence and resume grant return the existing state. A different or stale fence returns `409 STALE_RESUME_GRANT`.

### 5.5 Fail-closed rules

No answer or resume transition occurs when any of these is missing or ambiguous:

- question id;
- authorized actor mapping;
- source event/idempotency identity;
- reply-to or signed action binding;
- Project/Goal/Task/Run/Session correlation;
- current Question state;
- exact choice id or permitted free-text mode;
- current Run status and fencing generation;
- provider conversation id;
- workspace identity/retention needed for continuation;
- whether provider continuation may already have begun.

The system MUST retain the rejected source event and a redacted reason for audit. If a valid, authorized Question binding cannot be established, it MUST write the independent `InboxMutationAttempt` ledger described in §§6.3 and 10.3 rather than inventing a Question foreign key or per-question sequence. It MUST NOT choose the newest/only Question in a chat, guess from text, or create a replacement execution.

## 6. Versioned data contract

### 6.1 Wire-level types

The canonical representation is equivalent to:

```ts
type QuestionState =
  | "WAITING"
  | "ANSWERED"
  | "ACKNOWLEDGED"
  | "SUPERSEDED"
  | "CANCELLED"
  | "RESUMED";

type QuestionPurpose = "RESUME_EXECUTION" | "APPROVAL_GATE";
type ResponseMode = "SINGLE_CHOICE" | "FREE_TEXT" | "SINGLE_CHOICE_OR_TEXT";
type AnswerKind = "CHOICE" | "FREE_TEXT";

type QuestionChoice = {
  id: string;          // 1..100 chars, unique within question
  label: string;       // 1..200 chars
};

type InboxQuestionV1 = {
  contractVersion: "inbox.question.v1";
  id: string;
  promptMessageId: string;
  purpose: QuestionPurpose;
  projectId: string;
  goalId: string | null;
  taskId: string | null;
  runId: string | null;
  sessionId: string | null;
  agentId: string | null;
  sourceActorId: string;
  sourceKind: "SESSION_MCP" | "CONTROL_PLANE" | "MIGRATION";
  sourceRequestId: string;
  sourcePayloadHash: string;
  responseMode: ResponseMode;
  choices: QuestionChoice[];
  state: QuestionState;
  stateVersion: number;
  expiresAt: string | null;
  supersededByQuestionId: string | null;
  terminalReasonCode: string | null;
  createdAt: string;
  answeredAt: string | null;
  acknowledgedAt: string | null;
  resumedAt: string | null;
  supersededAt: string | null;
  cancelledAt: string | null;
};

type InboxAnswerV1 = {
  id: string;
  questionId: string;
  answerMessageId: string;
  kind: AnswerKind;
  choiceId: string | null;
  text: string | null;
  actorType: "OPERATOR";
  actorId: string;
  sourceKind: "WEB" | "FEISHU" | "MIGRATION";
  sourceAccountId: string;
  sourceEventId: string;
  idempotencyKey: string;
  payloadHash: string;
  authorizationEvidenceId: string;
  acceptedAt: string;
};

type ResumeState =
  | "PENDING"
  | "CLAIMED"
  | "STARTING"
  | "STARTED"
  | "BLOCKED_SAFE"
  | "BLOCKED_AMBIGUOUS"
  | "CANCELLED";

type InboxResumeRequestV1 = {
  id: string;
  questionId: string;
  answerId: string;
  projectId: string;
  runId: string;
  sessionId: string;
  providerConversationIdHash: string;
  state: ResumeState;
  claimGeneration: number;
  claimedByRunnerId: string | null;
  claimedLeaseGeneration: number | null;
  claimedAt: string | null;
  startingAt: string | null;
  startedAt: string | null;
  blockedReasonCode: string | null;
  createdAt: string;
  updatedAt: string;
};
```

The database may use enums and normalized tables, but the API MUST serialize these semantics exactly. Unknown contract versions are rejected, not partially interpreted.

### 6.2 Answer validation

- `CHOICE`: `choiceId` is non-null and exactly matches an immutable Question choice id; `text` is null.
- `FREE_TEXT`: `text` is non-null after trim validation and is at most 8,000 Unicode characters; `choiceId` is null. The accepted content preserves the user's original text bytes after UTF-8 decoding; trimming is validation only.
- `SINGLE_CHOICE` accepts only `CHOICE`.
- `FREE_TEXT` accepts only `FREE_TEXT`.
- `SINGLE_CHOICE_OR_TEXT` accepts either.
- Choice ids and source ids are compared as case-sensitive opaque strings.
- Prompt body is 1..8,000 characters. Choice count is 1..20 for modes containing choice; choices are empty for `FREE_TEXT`.
- Canonical payload hashing uses UTF-8 JSON with sorted object keys, array order preserved, and strings normalized to Unicode NFC. Hashes are SHA-256 lowercase hex.

### 6.3 Persistence and constraints

The authoritative schema MUST express, at minimum:

| Entity | Required constraints |
| --- | --- |
| `InboxMessage` | immutable id/body/actor/thread; unique external message identity scoped by channel account; prompt/answer messages remain display objects only |
| `InboxQuestion` | unique `promptMessageId`; unique `(sessionId, sourceRequestId)` for resumable questions; state version starts at 1; correlation foreign keys include Project scope |
| `InboxAnswer` | unique `questionId`; unique `(sourceKind, sourceAccountId, sourceEventId)`; unique `(actorId, idempotencyKey)`; typed choice/text check constraint |
| `InboxResumeRequest` | unique `questionId`; unique `answerId`; correlation must equal Question; one nonterminal request per Run/Session |
| `InboxQuestionEvent` | unique `(questionId, sequence)`; unique source-event identity where present; append-only |
| `InboxMutationAttempt` | canonical ingress/source receipt for answer/supersede/cancel; globally unique attempt/ingress receipt id; nullable `questionId` only after authorization and correlation permit binding; accepted Answer/result links when bound; attempted Question reference stored only as a redacted hash when unbound; stable source identity uniquely deduped by `(sourceKind, sourceAccountId, sourceEventId)` across accepted and rejected outcomes; independently ordered by `(occurredAt, id)`; append-only |
| `InboxResumeAcceptanceEvidence` | unique `resumeRequestId`; expected provider-conversation hash and runner/fence/claim generations must match ResumeRequest; redacted signal kind/hash plus adapter/CLI version and runtime handle required; append-only |
| `InboxNotificationDelivery` | unique `(questionId, channel, destinationId, renderingVersion)`; attempts append or increment under a delivery claim; external message identity scoped by channel account |
| active-question constraint | partial unique indexes ensure at most one active resumable Question per `runId` and per `sessionId` |

Foreign keys used for audit MUST default to `RESTRICT` or durable snapshots rather than erasing identity with `SET NULL`. User-facing entity deletion/archival must not destroy question, answer, or transition evidence.

### 6.4 Ownership and allowed writers

| State/data | Owner | Allowed writer |
| --- | --- | --- |
| Question and suspension | control plane | authenticated Session endpoint after fence validation |
| Answer | control plane | authenticated operator endpoint or verified notification adapter after actor mapping |
| Question lifecycle | control plane | answer transaction, runner callbacks, reconciler, or explicit operator cancel/supersede command |
| ResumeRequest | control plane | answer transaction; runner may request fenced transitions but never write DB directly |
| Run/Session execution state | control plane | existing claim/start/heartbeat/complete/reconcile APIs under fences |
| Notification delivery | Inbox notification service | adapter worker under outbox CAS; never the source of question state truth |
| Audit events | control plane | append-only alongside every accepted or rejected mutation |
| Mutation attempts | control plane ingress | one append-only source receipt for every answer/supersede/cancel ingress; bind Question/result only after identity/authorization/correlation validate |
| Provider-acceptance evidence | control plane | authenticated runner callback under the current fence/grant; runner never writes DB directly |
| UI state | server-derived | web client never invents lifecycle status or assumes success before response |

## 7. Lifecycle contract

### 7.1 Question transitions

```text
create + suspend
    └──> WAITING
          ├── accepted answer + resume request ──> ANSWERED
          │        └── fenced runner claim ─────> ACKNOWLEDGED
          │                  └── provider continuation confirmed ──> RESUMED
          ├── replacement created atomically ──> SUPERSEDED
          └── execution/question cancelled ────> CANCELLED
```

`SUPERSEDED`, `CANCELLED`, and `RESUMED` are terminal. `ANSWERED` and `ACKNOWLEDGED` are durable intermediate states and remain visible even if resume is delayed or blocked.

| From | Event | Preconditions | Atomic effects | To |
| --- | --- | --- | --- | --- |
| none | create | current live fenced Run; resumable provider id; no active question | create prompt Message + Question + event; Run/Session wait; token revoked; workspace retained | `WAITING` |
| `WAITING` | answer | authorized actor; exact binding; valid answer; before expiry; state CAS | create Answer, answer Message, ResumeRequest, events; queue same Run; request same Session | `ANSWERED` |
| `ANSWERED` | runner claim | same Run/Session; current claim CAS and fence | bind resume grant and lease generation; event | `ACKNOWLEDGED` |
| `ACKNOWLEDGED` | runner re-claim before `STARTING` | prior claim expired safely; no provider-start intent | rotate resume grant and claim generation; retain event history | `ACKNOWLEDGED` |
| `ACKNOWLEDGED` | start intent | current resume grant/fence; workspace/provider identity match | ResumeRequest `STARTING`; event written before provider call | `ACKNOWLEDGED` |
| `ACKNOWLEDGED` | provider acceptance confirmed | same grant/fence; request is `STARTING`; adapter-specific acceptance evidence and runtime handle present | acceptance evidence + ResumeRequest `STARTED` + Session/Run running + Question event in one transaction | `RESUMED` |
| `WAITING` | supersede | authorized operator/control plane; replacement payload valid | old terminal event + new Question; Session pointer moves; Run remains waiting; old actions invalidated | `SUPERSEDED` |
| `WAITING`, `ANSWERED`, or safely claimed `ACKNOWLEDGED` | cancel | authorized operator/control plane; provider start not possible/in progress | Question/ResumeRequest cancel; Run/Session cancel; open notifications invalidated; Task to review where applicable | `CANCELLED` |

Illegal or stale transitions return a deterministic conflict response and append rejected-transition audit evidence. They do not silently coerce state.

### 7.2 Supersede

- Supersede is not an edit. It atomically terminalizes the old Question and creates a new `WAITING` Question for the same suspended Run/Session.
- Only a `WAITING` Question may be superseded.
- `supersededByQuestionId` is mandatory and immutable.
- Existing notification actions for the old Question return `409 QUESTION_SUPERSEDED` and deep-link to the replacement.
- The Run remains `WAITING_INBOX`; no lease or Session token is restored.
- Same-key/different-payload retries never auto-supersede; they return an idempotency conflict.

### 7.3 Cancellation and expiry

- Explicit cancellation always requires a reason code and operator/control-plane actor.
- Cancelling a resumable Question cannot leave its Run in `WAITING_INBOX` or leave the Session pointing at it.
- Expiry is a control-plane cancellation with reason `ANSWER_WINDOW_EXPIRED`. It preserves current behavior: Run/Session become timed out, Task moves to review when present, and workspace enters terminal retention policy.
- An answer and expiry/cancel race use the same Question-row CAS. Exactly one wins.
- If cancellation races a `STARTING` resume and provider-start absence cannot be proven, the Question does not falsely become `CANCELLED`; ResumeRequest becomes `BLOCKED_AMBIGUOUS`, Run/Session stop accepting automatic work, and Task moves to review.

### 7.4 Safe and ambiguous resume failure

- **Safe pre-start failure:** missing local binary before spawn, failed workspace verification, failed preflight with evidence that no provider process was invoked, or a spawned CLI's version-pinned parser records a definitive authentication/session-not-found rejection before any adapter-specific acceptance signal. Set ResumeRequest `BLOCKED_SAFE`; the same Run may be requeued after the cause clears. The Answer remains authoritative.
- **Ambiguous start failure:** runner loss, network loss, or control-plane failure after `STARTING` where provider acceptance is unknown. Set/detect `BLOCKED_AMBIGUOUS`; mark the Run non-retryable and Task `REVIEW`; do not invoke the provider again automatically.
- A spawned process exiting, emitting malformed/unknown output, or changing its event shape before the expected signal is not proof of rejection; unless the pinned adapter classifies explicit pre-acceptance rejection evidence, it is `BLOCKED_AMBIGUOUS`.
- **Confirmed post-start failure:** once Question is `RESUMED`, ordinary Run failure/retry policy applies, but any retry is a new execution attempt and MUST NOT replay the consumed ResumeRequest.

## 8. Concrete scenarios

### S1 — Free-text question and normal resume

An authenticated agent Session calls create with prompt “Which branch?” and no choices. The control plane validates the current Run fence and provider conversation id, writes Message/Question/event, suspends the same Run/Session, revokes the Session token, and returns `201` with `WAITING`. The operator submits text with one idempotency key. One transaction writes the Answer and ResumeRequest and queues the same Run. A runner claims it, receives a bound resume grant and answer, records `STARTING`, invokes the provider, waits for its adapter-specific acceptance signal, then confirms that signal together with the runtime handle. The Question reads `RESUMED`; one provider continuation exists.

### S2 — Choice answer

A question declares `SINGLE_CHOICE` and choices `approve` and `reject`. `approve` is stored as `Answer.kind=CHOICE, choiceId=approve`; the label is rendered from the immutable Question snapshot. A text reply is rejected with `422 ANSWER_KIND_NOT_ALLOWED` and the Question remains `WAITING`.

### S3 — Compatible choice-or-text answer

A migrated current-system choice question declares `SINGLE_CHOICE_OR_TEXT`. A direct Feishu reply is accepted only when it explicitly replies to the external prompt message and its sender maps to the configured operator. Chat membership or being the only open card is insufficient.

### S4 — Duplicate client retry

The web client times out after the server committed an Answer. It retries the same idempotency key and payload. The server returns `200`, `duplicate: true`, and the original Answer/Question state. Counts remain one Answer, one ResumeRequest, and one Run queue transition.

### S5 — Competing web and Feishu answers

Web submits `approve` while Feishu submits `reject`. Both are authorized and exactly bound to the same Question. The first Question-state CAS wins. The other receives `409 QUESTION_ALREADY_ANSWERED`. Only the winner is delivered to the runner. Both source events are auditable.

### S6 — Ambiguous notification identity

A free-text Feishu message appears in a chat with no explicit reply parent/action binding. It is stored as an inert human Message, not an Answer. If it claims an unknown/mismatched question id, it is rejected and audited. No execution changes state.

### S7 — Duplicate runner claim

Two runners race to claim the answered Run. Existing Run claim CAS chooses one. Only that runner receives a resume grant. The loser receives no provider conversation id or answer payload. A stale callback from the loser is rejected.

### S8 — Runner dies before provider start

The runner claims and acknowledges, then fails workspace validation before `STARTING`. Evidence proves no provider call. The ResumeRequest is `BLOCKED_SAFE`; the same Run may be requeued and claimed later without creating another Answer/ResumeRequest.

### S9 — Runner dies across provider start

The runner records `STARTING`, invokes the provider, and disappears before confirmation. Reconciliation detects the unresolved boundary, sets `BLOCKED_AMBIGUOUS`, prevents automatic retry, and moves the Task to review. This sacrifices automatic liveness to preserve the one-continuation guarantee.

### S10 — Supersede

An operator replaces a malformed `WAITING` question. Old and new states, linkage, Session pointer, and notification invalidation commit together. Answering the old card is a harmless conflict. The Run stays suspended on the new Question.

### S11 — Cancel or expire

Cancellation/expiry wins the state CAS before an answer. The Question is `CANCELLED`, Run/Session become terminal, and a later answer is harmless. If the answer wins first, expiry observes a non-`WAITING` state and does nothing.

### S12 — Goal correlation

A Goal-originated execution asks a question. The Question snapshots `projectId`, `goalId`, optional `taskId`, `runId`, `sessionId`, and `agentId` from the authenticated execution. UI links and Goal 5a1 consumers read these fields; no consumer infers Goal ownership from thread or message text.

## 9. API contract

All APIs use JSON, authenticated principals, stable machine error codes, and server timestamps. Bodies containing unknown contract versions or unknown enum values return `400`.

### 9.1 Create and suspend

`POST /session/runs/:runId/inbox/questions`

```json
{
  "contractVersion": "inbox.question.v1",
  "fencingToken": "...",
  "idempotencyKey": "tool-call-or-client-generated-id",
  "prompt": "Which branch should I use?",
  "response": {
    "mode": "SINGLE_CHOICE_OR_TEXT",
    "choices": [
      { "id": "main", "label": "main" },
      { "id": "release", "label": "release" }
    ]
  },
  "expiresAt": null
}
```

- Principal MUST be the Session principal for `:runId`; fence and lease must be current.
- Server derives every correlation and actor field. Clients cannot submit Project/Goal/Task/Session/Agent ids.
- `201` creates; identical replay returns `200` and `duplicate: true`.
- Same idempotency key with different canonical payload returns `409`.
- Missing provider conversation id or non-resumable state returns `409 RUN_NOT_RESUMABLE` with no partial rows.
- MCP `inbox_ask` maps its `requestId` to `idempotencyKey`. Hashing/truncating prompt text is not sufficient identity; the tool call must supply or persist a stable call id.

### 9.2 Read

- `GET /inbox/questions?state=&projectId=&goalId=&taskId=&runId=&sessionId=&cursor=` returns Question summaries and prompt Message, with cursor pagination and server filtering.
- `GET /inbox/questions/:questionId` returns Question, prompt Message, accepted Answer/answer Message if present, transition history, delivery summary, and redacted resume status.
- Operator reads may span the single-operator installation. Session and runner principals cannot use operator read endpoints.
- `404` is used for unknown ids; cross-principal access does not reveal existence.

### 9.3 Answer

`POST /inbox/questions/:questionId/answers`

Choice body:

```json
{
  "contractVersion": "inbox.question.v1",
  "idempotencyKey": "client-generated-stable-id",
  "answer": { "kind": "CHOICE", "choiceId": "main" }
}
```

Text body:

```json
{
  "contractVersion": "inbox.question.v1",
  "idempotencyKey": "client-generated-stable-id",
  "answer": { "kind": "FREE_TEXT", "text": "Use release/1.x" }
}
```

- `201`: accepted for the first time.
- `200`: same accepted result replayed; `duplicate: true`.
- `403 ACTOR_NOT_AUTHORIZED`: authenticated channel/user is not the configured operator.
- `409 QUESTION_ALREADY_ANSWERED`, `QUESTION_SUPERSEDED`, `QUESTION_CANCELLED`, `QUESTION_EXPIRED`, or `CORRELATION_MISMATCH`: no mutation.
- `422 INVALID_CHOICE`, `ANSWER_KIND_NOT_ALLOWED`, or `EMPTY_ANSWER`: no mutation.
- Success returns `questionId`, `answerId`, `resumeRequestId` when resumable, `state`, `duplicate`, and timestamps. It never returns provider credentials.
- The server derives Answer source identity; clients never supply `sourceAccountId` or `sourceEventId`. For `WEB`, `sourceAccountId` is exactly the authenticated `operatorActorId` and `sourceEventId` is exactly the case-sensitive request `idempotencyKey`. For `MIGRATION`, `sourceAccountId` is the literal stable namespace `agentos/inbox-3a-backfill/v1` and `sourceEventId` is `InboxDecision:<legacy-primary-key>` for a migrated accepted Answer. The migration run id is separate audit evidence and MUST NOT enter either identity. Retries reuse these derived values; same identity/same canonical payload returns the original Answer, while same identity/different payload is `409 IDEMPOTENCY_KEY_REUSED` with no write.

### 9.4 Supersede and cancel

- `POST /inbox/questions/:questionId/supersede` accepts an idempotency key, reason, and complete replacement prompt/response. Operator/control-plane only. It returns both old and replacement ids.
- `POST /inbox/questions/:questionId/cancel` accepts an idempotency key and reason code. Operator/control-plane only.
- Both endpoints use state CAS and return idempotent results for identical retries.

### 9.5 Runner resume hand-off

The existing runner claim response adds:

```json
{
  "resume": {
    "questionId": "...",
    "answerId": "...",
    "resumeRequestId": "...",
    "resumeGrant": "short-lived-secret",
    "providerConversationId": "...",
    "answer": { "kind": "FREE_TEXT", "text": "Use release/1.x" }
  }
}
```

- This envelope is returned only to the winning fenced runner claim and is never persisted in logs as a whole.
- A runner records the pre-provider boundary through `POST /runner/runs/:runId/resume/starting` with current fence and resume grant.
- Existing `POST /runner/runs/:runId/start` confirms the resume only after adapter acceptance by including the three ids, resume grant, runtime handle, runner kind, adapter/CLI version, acceptance signal kind, canonical signal hash, and observed timestamp when `resume != null`; it validates the exact signal allowed for that pinned runner kind, then atomically records `InboxResumeAcceptanceEvidence`, runtime handle, and `RESUMED`.
- All callbacks are idempotent for the same fence/grant and reject stale or mismatched credentials.
- Pre-acceptance heartbeats are allowed while the ResumeRequest remains `STARTING`. A child exit or explicit rejection before acceptance uses `/resume/failure`; a definitive pinned-parser authentication/session rejection may become `BLOCKED_SAFE`, while unknown output, callback loss, or any uncertainty becomes `BLOCKED_AMBIGUOUS`.

### 9.6 Legacy endpoint compatibility

- Current `POST /inbox/messages/:id/decision` adapts choice input to the v1 answer service.
- Current `POST /inbox/messages/:id/reply` adapts text input only when `:id` resolves uniquely to `promptMessageId` of a v1 Question.
- Current `GET /inbox/messages` may project v1 Question state during the compatibility window.
- Legacy paths receive deprecation headers and must not contain an independent answer/resume implementation.

## 10. Authorization and audit evidence

### 10.1 Principals

- **Session agent:** authenticated by a non-revoked Session token bound to Run and lease generation, plus fencing token in mutation body. May create a question only for its own Run.
- **Runner:** authenticated by runner token, current Run lease/fence, and resume grant. May request only the ResumeRequest bound to its claim.
- **Web operator:** authenticated operator principal with a stable `operatorActorId`. Raw operator tokens are never stored.
- **Notification operator:** verified channel event plus an `(channel, account/tenant, externalActorId) → operatorActorId` mapping. No mapping means 403 and audit, even in the correct chat.
- **Control plane/reconciler:** named service actor with instance id and reason code.
- **Migration:** named migration actor and migration run id; historical mapping does not grant runtime authorization.

### 10.2 Notification binding

An external answer is valid only if all applicable values agree:

1. verified channel/account and source event identity;
2. authorized external actor mapping;
3. explicit signed action token or explicit reply-to external prompt message;
4. delivery row, Question, prompt Message, destination, and external message id;
5. choice id embedded/bound by the action token, where applicable;
6. current Question state and correlations.

Chat-only fallback is forbidden. Action tokens are opaque, tamper-evident, single-question scoped, expire no later than the Question, and contain/version-bind the rendering. Raw database ids in an unsigned card action are insufficient.

### 10.3 Audit ledgers

Every answer/supersede/cancel ingress first resolves or creates one immutable `InboxMutationAttempt` source receipt. An accepted mutation and every rejected mutation that has established a valid, authorized, correlation-consistent Question binding also appends an immutable `InboxQuestionEvent` containing:

- event id and per-question sequence;
- contract version;
- event type and before/after lifecycle states;
- all correlation ids;
- actor type/id and source kind/account/event/idempotency key;
- authorization-evidence id, not raw tokens or secrets;
- canonical payload hash;
- Question state version, Run lease generation, resume claim generation, and runner id when relevant;
- timestamp, service instance id, and reason/error code;
- linkage to replacement/cancellation/Answer/ResumeRequest where relevant.

Prompt/answer content is not duplicated into structured logs or metrics. Database access may show content to the operator; service logs use ids, lengths, hashes, and redacted error details.

A request with a missing Question id, unknown/tampered id, unauthorized principal, or cross-project/correlation-invalid target leaves its immutable `InboxMutationAttempt` unbound and appends no fabricated `InboxQuestionEvent`. The control plane MUST NOT attach its `questionId` or per-question sequence until the principal is authorized to know and mutate that Question and all correlations validate. An attempt row contains attempt/ingress-receipt id, contract version, operation, source kind/account/event/idempotency identity when valid, canonical payload hash or bounded shape hash, attempted-question-reference hash, actor/source class, authorization-evidence id when available, validated correlations only, timestamp, service instance, HTTP-equivalent outcome, redacted reason code, and accepted Answer/result linkage only when bound. The API response remains the same non-disclosing `404` or specified rejection and never reveals whether the attempted id exists.

Stable source identities dedupe centrally on `InboxMutationAttempt(sourceKind, sourceAccountId, sourceEventId)` across accepted, bound-rejected, and unbound-rejected outcomes: same payload returns the original result, while a different payload records/returns `IDEMPOTENCY_KEY_REUSED` without a business mutation. `InboxAnswer` references the winning attempt, so the same source identity cannot exist once as a rejection and again as an Answer. If the request lacks a valid stable source identity, ingress generates a unique receipt id and records exactly one rejected attempt for that receipt; such a request is never eligible for idempotent business processing. `InboxMutationAttempt`, `InboxQuestionEvent`, authorization evidence, and provider-acceptance evidence are append-only with `RESTRICT`/durable snapshots, survive rollback and legacy contraction, and may be removed only by a separately approved retention/export process.

## 11. Web UI contract

1. Inbox list and detail use `questionId` as the actionable route identity. Legacy `/inbox/:messageId` resolves once and redirects to `/inbox/questions/:questionId` where possible.
2. Filters expose at least `Waiting`, `In progress` (`ANSWERED`/`ACKNOWLEDGED`), and `Finished` (`RESUMED`/`SUPERSEDED`/`CANCELLED`). Counts are server-derived.
3. Every Question displays purpose, lifecycle, created/expiry timestamps, actor/source, delivery status, and links for Goal, Task, Run, and Session when present.
4. Choice buttons submit choice ids; free text submits the preserved text. Mixed mode shows both without converting text to a synthetic choice.
5. The client generates one stable idempotency key when the human initiates submission and reuses it across network retries. It must not use `Date.now()` on every retry.
6. The UI waits for the server result before showing accepted/resume state. It may disable controls locally but cannot infer success.
7. A duplicate success displays the original accepted result. A competing different answer displays “Already answered” and the current lifecycle, not a generic failure.
8. Superseded Questions show and link to the replacement. Cancelled Questions show the reason. `ACKNOWLEDGED` shows “Answer received; runner preparing to resume.” `RESUMED` shows the Run/Session link.
9. `BLOCKED_SAFE` and `BLOCKED_AMBIGUOUS` resume states are visible as operator-action failures; the latter explicitly says automatic retry was stopped to prevent duplicate continuation.
10. Delivery failure does not hide or disable the web answer path.
11. Ambiguous/unmatched external text remains visible as a non-actionable Message and never appears as an accepted Answer.
12. UI access and answer calls remain operator-authenticated; no Question payload or answer is placed in unauthenticated push content.

## 12. Notification contract

### 12.1 Adapter boundary

The Inbox service exposes a channel-neutral `NotificationAdapter` contract with behavior equivalent to:

```ts
interface NotificationAdapter {
  channel: string;
  renderQuestion(input: RedactedQuestionDelivery): RenderedNotification;
  send(input: RenderedNotification, idempotencyKey: string): Promise<ExternalDeliveryIdentity>;
  verifyInbound(envelope: unknown): VerifiedInboundEvent;
  parseAnswer(event: VerifiedInboundEvent): ExplicitAnswerBinding | UnmatchedInbound;
}
```

Feishu is the only required adapter in v1. Extracting the interface does not authorize a new channel.

### 12.2 Delivery and ingestion

- Question persistence never depends on successful notification delivery.
- Each destination has a durable delivery identity and retry state. A delivery worker uses CAS/lease semantics; restart converts abandoned sending claims to retryable failures.
- Send idempotency is based on delivery id, not prompt text. If a channel lacks idempotent send, duplicate external cards are tolerated because only Question answer CAS can win; all external ids are recorded.
- Retry uses bounded exponential backoff and operator alerting after a configured threshold. Delivery failure never causes automatic cancellation or resume.
- Buttons/actions carry signed bindings. Text answers require explicit reply-to the recorded prompt external message.
- Duplicate inbound source events return the original result and do not re-run business logic.
- Unmatched text remains an inert Message. Unmatched actions, tampered tokens, unknown actors, and correlation mismatches fail and are audited.
- Notification acknowledgements/toasts describe answer receipt only; they must not claim “resumed” before Question state is `RESUMED`.

## 13. Compatibility and migration contract

Migration is expand → backfill → shadow/projection → gated cutover → contract. It is not performed by this task.

### 13.1 Legacy mapping

| Current field/entity | v1 authority/projection |
| --- | --- |
| `InboxMessage.id` used as question | becomes `promptMessageId`; a new `questionId` is authoritative |
| `InboxMessage.status=OPEN` | `Question.state=WAITING` only when exact waiting Run/Session correlation is proven |
| `InboxMessage.status=ANSWERED` | map from evidence to `ANSWERED`, `ACKNOWLEDGED`, or `RESUMED`; do not infer beyond evidence |
| `InboxMessage.status=CLOSED` | `SUPERSEDED` only with replacement evidence; otherwise `CANCELLED` with explicit legacy reason |
| `choices` | immutable Question choices; current multiple-choice rows use `SINGLE_CHOICE_OR_TEXT` |
| `selectedChoiceId` | Answer `choiceId` only when it matches a choice; free text maps to Answer `text` |
| `InboxDecision` | historical Answer source; raw `actorOpenId` maps to a historical actor record, not authorization |
| `Session.waitingOnMessageId` | compatibility shadow of `waitingOnQuestionId`/prompt mapping |
| `Session.resumeInput` | compatibility projection of immutable accepted Answer; never authority after cutover |
| `Session.resumeAttempt` | compatibility count; v1 authority is ResumeRequest claim/start event history |
| `InboxExternalEvent` | retained source-event evidence with channel/account scoping added |
| message-level delivery fields | projected from the primary Feishu delivery row during compatibility window |

### 13.2 Preflight and quarantine

Before backfill, a read-only preflight reports counts and ids for:

- more than one open/waiting candidate for a Run or Session;
- `WAITING_INBOX` Run without exactly one Session and resolvable waiting message;
- open resumable message without matching Run/Session/provider conversation id;
- mismatched Project/Goal/Task/Agent correlations;
- answered message with zero or multiple plausible decisions;
- selected choice not present in the immutable choices;
- duplicate external event/message/action identities after channel scoping;
- `resumeInput` with no accepted-decision evidence;
- delivery rows stuck in `SENDING`;
- historical actors that cannot map to the configured operator.

Ambiguous active rows are quarantined: no automatic answer, cancellation, or resume is inferred. Cutover stops until each active ambiguity is repaired or explicitly cancelled by the operator. Historical closed ambiguity may migrate with `migrationConfidence=LOW` and a reason, but may never become actionable.

### 13.3 Cutover compatibility

1. Additive schema lands first; no destructive column/table change is part of initial rollout.
2. Backfill is restartable and idempotent by legacy primary key plus migration run id.
3. During the compatibility window, v1 is the only business-logic writer after the write flag flips. Legacy fields are one-way projections written in the same transaction; there are not two independent state machines.
4. Legacy APIs call the v1 service. New APIs never call legacy decision logic.
5. Legacy runners may consume projected `resumeInput` only while the compatibility flag is enabled and claim telemetry advertises both `resumeGrantV1` and `resumeAcceptanceV1`. A runner missing either capability cannot claim a v1 ResumeRequest; it remains `ANSWERED` for a capable runner. A mixed runner fleet cannot consume the same ResumeRequest twice; the control plane issues a resume grant to one capable claim regardless of runner version.
6. Active pre-cutover `WAITING_INBOX` executions may continue only when preflight maps them exactly. Otherwise they remain stopped for operator action.
7. Contracting/removing legacy columns occurs only in a later separately approved migration after the rollback window and zero legacy consumers are proven.
8. Migrated accepted Answers use the fixed source identity from §9.3. A backfill rerun reuses `sourceAccountId=agentos/inbox-3a-backfill/v1` and `sourceEventId=InboxDecision:<legacy-primary-key>` regardless of migration run id, so it cannot create a second Answer.

## 14. Concurrency and failure-recovery requirements

The implementation test suite MUST exercise real database transactions for concurrency claims. Mock-only tests are insufficient.

### 14.1 Required races

1. same question-create idempotency key/same payload concurrently → one Question and one suspension;
2. same key/different payload → one success, one deterministic conflict;
3. identical answer retried concurrently → one Answer, one ResumeRequest, one Run queue transition;
4. different web/Feishu answers concurrently → one accepted Answer, loser harmless;
5. answer vs expiry → exactly one terminal branch;
6. answer vs cancel → exactly one branch;
7. answer vs supersede → either original answered or replacement created, never both;
8. old-card answer vs supersede commit → no old Answer after replacement;
9. duplicate channel event → one source-event processing result;
10. two notification workers → one active delivery claim per row;
11. two runner claims → one lease/fence and one resume grant;
12. stale runner callback after re-claim → rejected without state change;
13. two `starting` callbacks → one `STARTING` boundary;
14. cancel vs `starting` → either proven cancellation or ambiguous-stop state, never a second continuation;
15. reconciler vs runner start confirmation → consistent `RESUMED` or fail-closed ambiguity;
16. sequential questions in one Session after the first is `RESUMED` → distinct identities and no reuse of the first Answer/ResumeRequest.

### 14.2 Recovery behavior

| Failure | Required behavior |
| --- | --- |
| DB failure during create/suspend | rollback all; original Run keeps prior live state/fence |
| DB failure during answer/queue | rollback Answer/ResumeRequest and execution transition; retry is safe |
| notification send timeout | retain Question; retry delivery; duplicate card harmless |
| notification service offline | web Inbox remains authoritative; alert on delivery age |
| invalid/tampered inbound action | reject, audit, no state change |
| answer committed but no runner claim | remain `ANSWERED`; alert on age; do not create another Run |
| runner claim lost before `STARTING` | allow fenced re-claim of same Run/ResumeRequest |
| workspace missing before `STARTING` | `BLOCKED_SAFE`, Task review/repair; no new execution |
| crash after `STARTING` before confirmation | `BLOCKED_AMBIGUOUS`, non-retryable automatic path, Task review |
| provider rejects resume definitively | record reason; if adapter proves no continuation began, `BLOCKED_SAFE`; otherwise ambiguous |
| process spawns then provider rejects before acceptance signal | pinned adapter records the definitive rejection; real control-plane path stores `BLOCKED_SAFE`, no acceptance evidence/`RESUMED`, and no replacement Run; unknown or malformed evidence is ambiguous |
| control-plane restart | reconstruct state solely from DB; no in-memory ownership assumption |
| Question expiry | CAS cancel/timeout, preserve evidence/workspace policy, late answer harmless |
| rollback attempted with active `STARTING`/ambiguous requests | stop rollback; human resolution required |

Real API/database negative tests MUST cover a missing Question id, an unknown/tampered id, an unauthorized existing id, and a cross-project existing id. Each produces one deduped unbound `InboxMutationAttempt`, zero fabricated Question events, no state change, and the same non-disclosing response for existing and non-existing targets. Same-source/same-payload retry returns the recorded rejection; different payload conflicts; a source identity first recorded as rejected cannot later create an Answer.

## 15. Observability contract

### 15.1 Structured logs

Every create, answer, transition, delivery attempt, authorization rejection, unbound mutation attempt, claim, start boundary, provider-acceptance confirmation, reconcile action, and migration decision logs contract version, ids, state versions, actor/source class, result code, duration, and service instance. Prompt/answer text, raw tokens, resume grants, raw acceptance events, and provider conversation ids are excluded.

### 15.2 Metrics

At minimum:

- question counts by purpose/state/source;
- age histograms for `WAITING`, `ANSWERED`, and `ACKNOWLEDGED`;
- answer accepted, duplicate, conflict, validation reject, authorization reject, and correlation reject counters;
- bound/unbound mutation-attempt counts and dedupe/conflict outcomes by source class, without target ids;
- resume claim/start/adapter-acceptance/confirmed, safe-block, ambiguous-block, capability-mismatch, and stale-grant counters;
- delivery pending age, attempts, failures, and duplicates by channel;
- migration quarantined/low-confidence counts;
- invariant-violation counter, which should remain zero.

### 15.3 Alerts and operator evidence

Alert on:

- any `BLOCKED_AMBIGUOUS` ResumeRequest;
- any invariant/correlation violation;
- `ANSWERED` without claim beyond the configured runner-service objective;
- `ACKNOWLEDGED` without `STARTING` or `RESUMED` beyond its objective;
- delivery failure/age over threshold;
- authorization failures above normal noise;
- active Question past expiry that reconcile did not terminalize;
- more than one active resumable Question detected by audit query.

Task activity logs reference `questionId`, `answerId`, `resumeRequestId`, Run/Session ids, and reason codes. They do not contain answer text.

## 16. Rollout and rollback contract

This section defines safety gates and evidence; it does not authorize or schedule production work.

### 16.1 Rollout gates

1. **Write-surface review:** compare current master after Inbox 3a and Goal 5a0 complete. Implementation may begin only when review confirms safe integration with the current Inbox, workflow, runner claim/start, reconcile, notification, web, and schema write surfaces.
2. **Additive schema:** migration precheck, backup, drift check, and rollback artifact pass before schema application.
3. **Backfill dry run:** counts, quarantine list, mapping checksum, and rerun-idempotency evidence reviewed.
4. **Shadow/projection verification:** old and v1 read projections agree for exact rows; discrepancies are zero for active questions.
5. **API cutover canary:** v1 creation/answer behind a feature flag on controlled executions; concurrency and authorization probes pass.
6. **Runner cutover canary:** all runner kinds prove claim, safe pre-start retry, start boundary, and confirmation. No Goal 5a1 integration yet.
7. **Notification canary:** Feishu explicit action and reply binding, duplicate event, unauthorized actor, and delivery retry pass.
8. **Web canary:** typed answer, stable idempotency retry, lifecycle display, and failure states pass.
9. **General activation:** only after no active migration ambiguity and no canary invariant/ambiguous-start failure.
10. **Legacy contraction:** separate approval after rollback window, zero legacy traffic, and retained backup/evidence.

Production migration/restart is a human-controlled later action. Active Runs, active waiting Questions, migration/drift/checksum anomalies, failed backup/prechecks, unsafe mixed versions, or any ambiguous resume are stop conditions.

### 16.2 Rollback

- Before write cutover: disable the feature flag; additive unused tables may remain.
- After write cutover but before legacy contraction: disable new question creation, let exact safe in-flight transitions settle, and switch reads/runners only through the maintained one-way legacy projection.
- Rollback MUST NOT proceed while a ResumeRequest is `STARTING` or `BLOCKED_AMBIGUOUS`, while an active v1 Question lacks an exact legacy projection, or while a runner version could consume without resume grants and provider-acceptance evidence.
- No rollback deletes Question, Answer, ResumeRequest, provider-acceptance, lifecycle, unbound-mutation, source-event, or delivery evidence.
- Schema down migration is not the operational rollback. Dropping data requires a separate destructive migration and approval after retention/export.
- If legacy projection cannot represent a v1 state safely, freeze the affected execution in review; do not coerce `ACKNOWLEDGED`, `SUPERSEDED`, or ambiguous state to `OPEN` and continue.
- Rollback verification includes database counts/checksums, zero active new-only states, no duplicate provider start, UI/API smoke tests, and notification rejection of stale action tokens.

## 17. Reviewer verification and acceptance matrix

The feature is acceptable only when a reviewer can cite automated evidence for every row and manual evidence only where explicitly named.

| Requirement | Verification |
| --- | --- |
| Distinct durable identities | Schema/API tests prove Message, Question, Answer, ResumeRequest, delivery, and event ids are separate and immutable. |
| Correlation | DB constraints and negative API tests cover Project/Goal/Task/Run/Session/Agent mismatches; each fails closed. |
| Atomic suspend | Fault-injection DB test at each write proves no Question without waiting Run/Session and no waiting Run/Session without its Question. |
| Typed answers | API tests cover valid/invalid choice, text, mixed compatibility, empty/oversize input, duplicate choice ids, and unknown contract version. |
| Harmless duplicate answers | Real-DB concurrent same-answer tests prove one Answer, one ResumeRequest, one queue transition. |
| Competing answers | Real-DB web/Feishu race proves one winner and immutable winner payload. |
| Exactly one logical resume | Two-runner claim/start tests plus stale-fence tests prove one ResumeRequest consumer and at-most-one automatic provider start; CLAUDE/CODEX/PI tests require their exact acceptance signals before `RESUMED`. |
| Ambiguous start safety | Crash/fault injection after `STARTING` and spawn-success/provider-rejection-before-acceptance tests prove no spawn-only `RESUMED`, no automatic retry/new Run, and visible safe/ambiguous evidence. |
| Lifecycle | Transition-table tests cover every legal edge and every illegal/stale edge, including supersede/cancel/expiry races. |
| Authorization | Web, Session, runner, authorized Feishu actor, unmapped actor, wrong chat/account, tampered token, and cross-project tests. |
| Audit | Each bound accepted/rejected scenario produces ordered immutable Question events; missing, unknown, unauthorized, and cross-project attempts produce deduped append-only unbound evidence without existence disclosure; neither ledger leaks secrets/content in logs. |
| Notification | Delivery worker race, retry/restart, duplicate external card/event, explicit reply binding, unmatched text, and stale superseded action tests. |
| UI | Component/browser tests show filters and all six lifecycle states, stable retry id, Goal/Task/Run/Session links, duplicate success, conflicts, and blocked resume states. |
| Compatibility | Fixture migration covers every mapping row; active ambiguity stops; rerun produces zero extra rows; legacy endpoints share v1 logic. |
| Rollout/rollback | Staging rehearsal records precheck, backup, checksums, canary evidence, feature-flag rollback, and stop behavior for ambiguous state. |
| Observability | Metrics/log tests and a staging dashboard show ids/states without prompt, answer, token, grant, or provider-id leakage. |

Final acceptance evidence MUST include:

1. schema/migration precheck output and mapping counts;
2. the real-database concurrency suite results;
3. runner-kind resume tests for Claude, Codex, and Pi adapters, including exact acceptance signals and spawn-success/provider-rejection-before-acceptance (provider calls may be deterministic fakes, but the runner/control-plane transactions are real);
4. API and authorization test results;
5. web component/browser results;
6. Feishu adapter ingestion/delivery results;
7. staging rollout and rollback rehearsal records;
8. an invariant query showing zero duplicate active Questions, duplicate Answers, duplicate ResumeRequests, or unresolved correlation mismatches.

## 18. Dependencies, authority, and stop conditions

- Specification and planning may proceed now.
- Goal 5a1 implementation MUST NOT begin until Inbox 3a and Goal 5a0 are complete.
- Inbox 3a implementation may begin independently only after a fresh write-surface review against current master confirms safe integration.
- Future implementation uses the recorded Planned Critical route and `senior-dev`; down-routing or reduced safeguards requires a new Product Contract version and product-owner approval.
- This chain is specification, planning, review, revision, and human approval only. It does not implement, migrate, restart, or perform production actions.
- Stop and request product-owner approval for any change to the assumptions that expands answer shape, creates multiple concurrent questions per Session, permits automatic retry after ambiguous provider start, weakens actor mapping, infers identity from a chat, or changes the seven-day default/no-expiry semantics.

## 19. Human-review assumptions

The specification is complete under A1–A9. The assumptions most likely to change product behavior are:

1. legacy choice questions remain choice-or-text, while new v1 choice questions default to choice-only unless `allowFreeText` is explicit;
2. omitted expiry remains seven days and explicit `null` remains indefinitely waiting;
3. `ACKNOWLEDGED` is runner hand-off and `RESUMED` is confirmed provider-process start;
4. an ambiguous provider-start boundary stops automatic retry and moves the Task to review;
5. v1 remains one question with one single-choice or free-text answer; multi-question and multi-select forms are deferred;
6. approval gates adopt identity/auth/audit primitives but keep their existing chain semantics outside this resume contract.

No unresolved design question is delegated to the implementation agent: unless the human revises one of these assumptions, the behaviors above are authoritative.
