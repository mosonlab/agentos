# SPEC — Batch 4: the sessions viewer

Status: draft for the plan step. Written against `master` at `b820152` (2026-08-16), i.e. **after**
the frontend-convergence chain merged (PR #39, `3c1f186`). Every code fact below was re-read at that
commit; where this document disagrees with the task brief, §2.7 says so explicitly.

Scope authority: [`docs/BACKLOG-V2.md`](../BACKLOG-V2.md) 批次 4.
Detail ledger: [`docs/reference/danny-agentos-video/detail-gaps.md`](../reference/danny-agentos-video/detail-gaps.md) §10.
Decisions source: [`docs/reference/danny-agentos-video/decisions.md`](../reference/danny-agentos-video/decisions.md) §10 item 1, §13.
Prior art the plan step must read before planning: [`docs/wiki/batch-0-frontend-base.md`](../wiki/batch-0-frontend-base.md)
and [`docs/specs/batch-frontend-convergence.md`](./batch-frontend-convergence.md) §2.6 (the rem trap and
the preflight exceptions still apply — this batch adds markdown rendering, which is where they bite).

---

## 1. Problem and audience

**Audience.** Leo, the single self-hosted operator, is the end user. The direct consumers of this
document are the plan agent (② / ④), the implementer (⑤ `frontend-dev`), and the code reviewer (⑥).

**Problem.** Today there is no way to see what an agent is doing. A run's session events are stored
(`SessionEvent`, 179k+ rows in normal use) and the web app does render them — as a three-column table
of `#seq | TYPE | JSON truncated to 160 characters` inside an expanded run row
(`apps/web/src/pages/TaskDetail.tsx:25-41`). That table is a debugging instrument, not a reading
surface: the agent's actual prose, the tool it called, the arguments it passed and the file it wrote
are all inside the truncated JSON. Leo's own words for the dogfood pain point are "看不懂 agent 在干嘛",
and that is why decisions §13 pulled this batch forward to run in parallel with batch 1.

Three smaller wounds ride along, all first-hand reports from 2026-08-16:

1. **Step outputs are unreadable in the product.** A spec or plan body is markdown; the task detail
   page renders it as clamped plain text (`TaskDetail.tsx:208-213` uses `ShowMore`, which is a
   `whitespace-pre-wrap` clamp). Leo reads spec bodies on GitHub instead of in AgentOS.
2. **Branch and PR are dead text.** The run row prints `run.branch` as a plain string
   (`TaskDetail.tsx:51`); the PR URL is a link but only behind an expanded run row, mislabelled as
   "Push" (`TaskDetail.tsx:70`).
3. **The Cost column is permanently `—`.** `Run` rows render `money(run.session?.costUsd)`
   (`TaskDetail.tsx:57`) and `Session.costUsd` is a column **nothing ever writes** — verified by
   grepping the whole repo: the only occurrences are three read sites in `apps/web` and the schema
   itself. So a column that looks like a metering feature has been showing an em dash since it
   shipped.

**What "done" looks like.** Leo opens `/sessions`, sees the run that is live right now, clicks it,
and reads what the agent is saying and doing as it happens — prose as prose, tool calls as collapsed
one-liners he can open, file paths as absolute paths, and a stat bar that tells him how big the
session has got. The raw JSON table still exists, one click away, collapsed, for when something
breaks.

---

## 2. Verified starting state

### 2.1 Data model (`packages/db/prisma/schema.prisma`)

`Session` (line 661) is **1:1 with `Run`** — `runId` is `@unique` (line 663) and there is a
`@@unique([runId, projectId])`. It carries `agentId`, `taskId?`, `goalId?`, `projectId`, `runner`,
`executionStatus`, `startedAt`, `endedAt`, `exitCode`, `terminationReason`, `costUsd Decimal?` and
`failureReason`. It has **no token columns**.

`SessionEvent` (line 708): `{ id, sessionId, runId, seq, at, source, type, providerEventId?,
toolCallId?, payload Json }`, `@@unique([sessionId, seq])`, indexed on `[runId, at]` and
`[sessionId, at]`. `seq` is a monotonic per-session integer — this is what makes incremental polling
cheap (§5.3).

`SessionExecutionStatus` (line 113): `REQUESTED | PROVISIONING | RUNNING | WAITING_INBOX | SUCCEEDED
| FAILED | TIMED_OUT | CANCELLED | LOST`.

### 2.2 Event types the runner actually emits (`packages/runner/src/adapters.ts:189-320`)

`emit()` (line 189) writes `{source, type, payload, toolCallId?}`. The vocabulary is fixed and small:

| type | emitted by | payload is |
|---|---|---|
| `MODEL_STARTED` | claude `system`, codex `thread.started`, pi `session` | the whole provider event |
| `MODEL_DELTA` | claude `assistant`, codex non-command `item.started`/`item.completed`, pi message events | the whole provider event |
| `MODEL_COMPLETED` | pi `turn_end` / `message_end` | the whole provider event |
| `TOOL_STARTED` | claude `tool_use` content part, codex `command_execution` item, pi `tool_execution_start` | **the part/item only**, plus `toolCallId` |
| `TOOL_PROGRESS` | pi `tool_execution_update` | the whole event |
| `TOOL_COMPLETED` | claude `tool_result` part, codex completed `command_execution` item, pi `tool_execution_end` | the part/item only, plus `toolCallId` |
| `FINAL_OUTPUT` | claude `result`, codex `turn.completed`, pi `agent_settled` | the whole terminal event |
| `PROVIDER_STATUS` | everything unmatched | the whole event |
| `PROVIDER_RAW` | every line, unconditionally (line 322) | the whole event |
| `ADAPTER_ERROR` | unparseable JSON line, codex `error` | `{error, line}` or the event |
| `STDERR` | every stderr chunk (line 418) | `{text}` |
| `PROCESS_STARTED` | runner itself (line 445) | `{pid, binary, args, promptHash}` |

Note `PROVIDER_RAW` duplicates every provider line. Roughly half of all stored rows are noise for a
reading surface; §4.3 keeps them out of the stream and in Debug events.

### 2.3 Usage data — verified present for two of three runners

The brief says to check whether runner events already carry usage. They do, for CLAUDE and CODEX:

- **CLAUDE** is invoked with `-p --output-format stream-json --verbose`
  (`adapters.ts:344-346`). Its terminal `result` event — stored verbatim as the `FINAL_OUTPUT`
  payload (`adapters.ts:222-228`) — carries `usage.{input_tokens, output_tokens,
  cache_read_input_tokens, cache_creation_input_tokens}`, `total_cost_usd`, `duration_ms`,
  `num_turns`.
- **CODEX** is invoked with `exec --json` (`adapters.ts:357-363`). Its `turn.completed` event —
  stored as `FINAL_OUTPUT` (`adapters.ts:263-266`) — carries `usage.{input_tokens,
  cached_input_tokens, output_tokens}`. It reports **no cost**.
- **PI**: `agent_settled` is stored as `FINAL_OUTPUT` (`adapters.ts:302-304`); its usage shape is
  **not verified**. Treated as absent until proven otherwise (§4.6, §11-A4).

So the data is in the database already, in `SessionEvent.payload`, and has been all along. Nothing
in the pipeline reads it. This batch reads it — it does not build a metering pipeline (§4.6).

### 2.4 API surface (`packages/api/src/app.ts`)

- `GET /runs/:runId/events` (line 2199): returns **every** event for a run, ordered by `seq`, no
  limit, no filter, bare array. Its only consumer in the repo is `RunEvents` in `TaskDetail.tsx`.
- `POST /runner/runs/:runId/events` (line 1757): fenced ingest, `createMany({skipDuplicates:true})`.
  This is where usage extraction belongs (§5.2).
- `GET /tasks` (1209) / `GET /tasks/:taskId` (1273): the latter includes `runs` (desc by
  `runNumber`) each with its `session`. `GET /tasks` takes an optional `?projectId=` query — the
  house convention for project scoping.
- `GET /tasks/:taskId/output` (1410): `TaskStepOutput` is `@unique` on `taskId`, so one row per task.
- **There is no `/sessions` endpoint of any kind.**

### 2.5 Web app (`apps/web`)

- Routes are a hand-rolled table in `App.tsx:17-30`; nav is `NAV` in `components/Shell.tsx:21-29`.
  There is no router library and none is to be added (decisions §3).
- `usePoll(path, intervalMs = POLL_MS)` (`lib/hooks.ts:19`) — `POLL_MS = 2_500`. It **replaces**
  `data` on every tick and skips the fetch while `document.hidden`. It cannot append, so the event
  stream needs its own hook (§5.3).
- `ApiError.missingEndpoint` (404/405/501) plus `GapNotice` (`components/ui.tsx:323`) is the house
  pattern for degrading when an endpoint is absent.
- `Markdown` (`components/ui.tsx:425`) supports headings (rendered as bold paragraphs), bullet and
  ordered lists, `**bold**` and `` `code` ``. It supports **no fenced code blocks, no links, no
  tables**. `ShowMore` (`ui.tsx:361`) is a line-clamp over plain text.
- Existing primitives this batch reuses rather than reinvents: `Card`, `Pill`/`RunPill`, `KeyValue`,
  `EmptyState`, `ErrorNotice`, `AgentChip`, `Table*`, `Tabs`, `STAT_PILLS`/`STAT_PILL`, `COUNT`,
  `CODE_BLOCK`, `IconChevron`. Tokens `--code-background`, `--event-line`, `--surface-run-detail`
  already exist and are already used by the event table.
- Formatters in `lib/format.ts`: `formatDateTime`, `timeAgo`, `duration(from,to)`, `money`, `sha`,
  `compact`, `titleCase`. There is **no** token formatter.
- Web tests live in `apps/web/src/tests/*.test.tsx`. `styles.test.tsx` reads `dist/assets/*.css`, so
  the suite must be run **after** `npm run build` (known trap, BACKLOG-V2 平台修缮).

### 2.6 What the original does (the target picture)

detail-gaps §10, frame [0:16:20] and [0:16:30]: a Sessions list with `Started / Task / Duration /
Status / Result` and a `Refresh` button; a detail page whose header is agent name + `Running` badge +
environment tag + `Refresh`, meta line `Task / In progress / Started …`, a stat bar `● Live · 43
messages · 293 tool calls · 2 files`, a `Files touched` collapsible with a count badge, and the
message stream itself. Finished sessions show `Done` + `29m 54s / 8.9K tokens / Started …`.

### 2.7 Corrections to the task brief

1. Brief item 4 says "Runs table gains Cost and Tokens columns". **Cost already exists as a column**
   (`TaskDetail.tsx:57`) — what is missing is the data behind it. This batch adds the Tokens column
   *and* makes both columns real (§4.6).
2. Brief item 3 says spec/plan bodies "are currently only readable on GitHub". Precisely: they are
   readable in-app but rendered as clamped preformatted text, not markdown.
3. detail-gaps §10 marks the stat bar / Files touched / message stream rows as ✅ "批次 4 明写" —
   that is an accounting of *intent*, not of implemented code. None of it exists.

---

## 3. Scope

### 3.1 In scope

1. `/sessions` list page (§4.1).
2. `/sessions/:sessionId` detail page: header, stat bar, message stream, tool call rendering,
   `Files touched`, `Debug events` (§4.2–§4.5).
3. Cost + Tokens made real: usage extraction at event ingest, four nullable `Session` columns, a
   backfill script, a `Tokens` column on the runs table (§4.6).
4. Task detail: step output rendered as markdown; branch and PR as links (§4.7).
5. Runner-type label (`CLAUDE` / `CODEX` / `PI`) on session list rows and the detail header (§4.1,
   §4.2) — detail-gaps §10 adopted addition, replacing the original's `local` tag.
6. The markdown renderer gains fenced code blocks and links (§4.8) — required by 3 and 4 above.

### 3.2 Explicitly out of scope

- **"Message a running agent"** — the `Type a message…` composer at [0:16:30]. Deferred: it needs
  runner-side injection into a live session, which is built in batch 5's session soft-landing item.
  Do not add the input, not even disabled.
- **`Open SDK ↗`** — a cloud-only affordance of the original. Not applicable.
- **Child sub-agent `<agent-message>` nesting** — decisions §12 collapsed review to a single
  session; no child sessions exist to nest. If a `Task`/`Agent` tool call appears in a stream it is
  rendered as an ordinary tool call, nothing more.
- **A Costs page, cost aggregation, per-agent attribution, charts.** Decisions §9 defers all of it.
  This batch surfaces the number the CLI already prints, per run, and stops.
- **Markdown tables** — belongs to batch 3 (BACKLOG-V2 批次 3, Inbox 正文 Markdown 渲染含表格). A
  markdown table in a step output renders as its literal lines this batch; that is acceptable.
- **Syntax highlighting.** Code blocks are monospace on `--code-background`, no tokenizer, no new
  dependency.
- **Event retention / pruning / archival.** Not touched.
- **Chain visibility on the task page** (which step, which agent, gate position) — that is batch 2.5.
- **Real-time transport.** Polling only; decisions #16 stands. No SSE, no WebSocket.
- **`GET /sessions` for goals-only sessions gets no special treatment** — a session whose `taskId` is
  null shows `—` in the Task column and links to its goal if `goalId` is set.

---

## 4. Intended behaviour, in concrete scenarios

Every scenario below is written as "what Leo does → what he must see". These are the acceptance
scenarios; §9 turns them into a reviewer checklist.

### 4.1 The sessions list — `/sessions`

**Scenario.** Leo clicks `Sessions` in the sidebar while a batch-4 implementation run is live.

- A new sidebar nav entry `Sessions` sits **between `Tasks` and `Goals`** in
  `Shell.tsx:21-29`, icon from `lucide-react` (`MessagesSquare` or the existing `IconActivity`
  family — the implementer picks one consistent with the other nav glyphs), `match: ["/sessions"]`.
- The page polls `GET /sessions?projectId=<active>` at `POLL_MS` (2.5 s) and renders a table with
  columns, left to right:

  | column | content | empty value |
  |---|---|---|
  | Started | `formatDateTime(startedAt ?? requestedAt)` | `—` |
  | Agent | `AgentChip` with the agent's title | agent id |
  | Task | task name, linked to `/tasks/:taskId`; goal name linked to `/goals/:goalId` if no task | `—` |
  | Runner | `Pill` reading `CLAUDE` / `CODEX` / `PI` | n/a, always present |
  | Duration | `duration(startedAt, endedAt)` — live rows count up as the poll ticks | `—` |
  | Status | status pill (§4.1.1) | n/a |
  | Result | `Success` / `Failed` / `In progress`, plus `failureReason` truncated to one line as `title=` | `—` |

- Rows are ordered newest first (`requestedAt desc`). Clicking a row navigates to
  `/sessions/:sessionId`.
- The page header carries a `Refresh` button (same shape as `TaskDetail.tsx:166`) that forces a
  reload; polling continues regardless.
- Empty project → `EmptyState` reading `No sessions yet. Agent tasks create a session when a run
  starts.`
- If the endpoint 404s (a web build newer than the API), `GapNotice` degrades the page instead of
  erroring — the house pattern.

**4.1.1 Status pill mapping.** `REQUESTED`/`PROVISIONING` → grey "queued"; `RUNNING` → green
"running"; `WAITING_INBOX` → amber "waiting"; `SUCCEEDED` → green "done"; `FAILED`/`TIMED_OUT`/`LOST`
→ red with the status word; `CANCELLED` → grey "cancelled". Reuse `Pill` tones already in
`ui.tsx:111-141`; do not introduce a new tone vocabulary.

**4.1.2 Volume ceiling.** The list requests `?limit=50` and supports `&before=<ISO requestedAt>` for
a `Load more` button appended below the table. 50 is the page size; there is no infinite scroll.

### 4.2 Session detail header and stat bar — `/sessions/:sessionId`

**Scenario.** Leo opens the live session.

- **Header row**: back link to `/sessions`, the agent title as `h1`, the status pill from §4.1.1, a
  runner `Pill` (`CLAUDE`), and a `Refresh` button. Header layout reuses `DETAIL_HEAD`.
- **Meta line** (`KeyValue`, 3 columns): `Task` (link), `Run` (`#<runNumber>`, link to
  `/tasks/:taskId`), `Model`, `Started` (`formatDateTime`), `Duration` (`duration(startedAt,
  endedAt)`), `Branch` (link per §4.7.2), `Workspace`, `Termination`.
- **Stat bar** (`STAT_PILLS`), matching the original's shape:
  - a `● Live` pill — green dot, only while `executionStatus ∈ {REQUESTED, PROVISIONING, RUNNING,
    WAITING_INBOX}`;
  - `N messages`;
  - `N tool calls`;
  - `N files`;
  - `N tokens` — `compactTokens` format (§4.6.4), omitted entirely when unknown;
  - `$N.NN` — omitted entirely when cost is unknown.
- **Finished sessions** show, in place of `● Live`, a `Done`/`Failed` pill and the meta line reads
  `29m 54s · 8.9K tokens · Started Aug 16, 3:21 PM` — i.e. duration, tokens and start time are all
  present for a terminal session, per detail-gaps §10 [0:12:50].
- If `failureReason` is set, an `ErrorNotice` sits directly under the header.

**Counting rules** (these are the definitions; §8 tests them):
- **messages** = number of normalized stream items of kind `text` (§4.3), i.e. rendered agent
  messages — *not* raw `MODEL_DELTA` row count.
- **tool calls** = number of distinct `toolCallId` values that have a `TOOL_STARTED`.
- **files** = number of distinct absolute paths in the `Files touched` set (§4.4).

### 4.3 The message stream

**Scenario.** Leo reads down the page while the agent works.

The stream is a vertical list, oldest first, that grows at the bottom. Raw `SessionEvent` rows are
normalized into stream items by a single pure module (§5.4) with these rules:

| stream item | built from | rendering |
|---|---|---|
| `text` | CLAUDE `MODEL_DELTA` → `payload.message.content[]` where `type === "text"`, joined by `\n`; CODEX `MODEL_DELTA` → `payload.item.text` when `payload.item.type === "agent_message"`; PI `MODEL_COMPLETED` → `payload.message.content[].text` joined, when `message.role === "assistant"` | a message card (`MSG_CARD`) whose body is `Markdown` (§4.8). Empty text produces **no item**. |
| `tool` | `TOOL_STARTED` joined to its `TOOL_COMPLETED` by `toolCallId` | collapsed one-liner: chevron, tool name, and the primary argument (§4.3.1). Expands to show full arguments and the full return. |
| `error` | `ADAPTER_ERROR` | `ErrorNotice` inline in the stream |
| `final` | `FINAL_OUTPUT` | a distinct card headed `Result`, body rendered as `Markdown` from CLAUDE `payload.result` / CODEX final agent message / PI final text; if no text field is found, the card is omitted (the stat bar and Debug events still carry the event) |

Every other event type — `PROVIDER_RAW`, `PROVIDER_STATUS`, `STDERR`, `MODEL_STARTED`,
`TOOL_PROGRESS`, `PROCESS_STARTED` — produces **no stream item** and appears only in Debug events
(§4.5). CODEX `reasoning` items are likewise excluded from the stream (assumption A2).

Each item shows a right-aligned timestamp (`MSG_TIME`, `formatDateTime(event.at)`).

**4.3.1 Tool call rendering.** Collapsed, a tool row reads `▸ Read  /Users/leohe/…/adapters.ts` —
tool name plus the primary argument, which is the file path when there is one (§4.4 extraction), the
command string for a shell call, otherwise the first scalar argument value, truncated to 120
characters. A running tool call (started, never completed) shows a `running` marker; a completed one
that reported an error (`payload.is_error === true` for CLAUDE, non-zero `exit_code` for CODEX,
`error` present for PI) shows a red marker.

Expanded, it shows two labelled blocks in `CODE_BLOCK`: **Arguments** (pretty-printed JSON of the
tool input, 2-space indent) and **Result** (the return value: the string content for CLAUDE
`tool_result`, `aggregated_output` for CODEX, the tool result payload for PI; JSON-stringified if
not a string). Each block is truncated at **8 000 characters** with a trailing `… truncated, N more
characters` line — no "show full" affordance; Debug events has the raw payload.

**4.3.2 Code snippets carry absolute paths.** Where a tool item has an extracted file path, the
expanded view's Arguments block is preceded by the **absolute path as its own line**, selectable,
not truncated (wrap with `[overflow-wrap:anywhere]`). This is the original's [0:16:30] behaviour —
`read_file` showing `target_file` / `offset` / `content`.

**4.3.3 Live behaviour.** New items append at the bottom. The page **does not auto-scroll** unless
the viewport is already within 100 px of the bottom (assumption A3) — an operator reading history
must not be yanked away. When auto-scroll is suppressed and new items arrive, show a small
`N new ↓` affordance that scrolls to the bottom on click.

### 4.4 `Files touched`

A collapsible `Card` titled `Files touched` with a `COUNT` badge, **collapsed by default**, listing
each distinct absolute path once, sorted alphabetically, each with a small right-aligned count of how
many tool calls touched it. Paths are not truncated; long paths wrap.

Extraction rules, applied to `TOOL_STARTED` payloads (and, for CODEX, to `MODEL_DELTA` items):

| runner | rule |
|---|---|
| CLAUDE | `payload.input.file_path` ‖ `payload.input.notebook_path`. Directory arguments (`payload.input.path` on `Glob`/`Grep`) are **excluded** — only file-level paths count. |
| CODEX | `TOOL_STARTED` is `command_execution` and carries no structured path, so nothing is extracted from it. Instead, `MODEL_DELTA` items with `payload.item.type === "file_change"` contribute `payload.item.changes[].path`. |
| PI | `payload.args.file_path` ‖ `payload.args.path` ‖ `payload.args.filePath`, whichever is a string. |

A path that is not absolute (does not start with `/`) is **still listed, verbatim** — the workspace
is a clone under a run-specific root and relative paths are meaningful to the reader; do not attempt
to resolve them against the workspace path.

**Verification duty for the implementer**: the CODEX `file_change` item shape and the PI `args` shape
are inferred from the adapter's routing (`adapters.ts:250-256`, `274-286`), not from a captured
payload. At implementation time, open one real CODEX session and one real PI session in the DB (or
the corresponding `/runs/:runId/events` response) and check. **If a shape does not match: extract
nothing for that runner, render the section with count 0 and the hint `File tracking is not
available for <RUNNER> sessions.`, and file a ledger note in BACKLOG-V2.** Do not guess further, and
do not let an unexpected shape throw (§6).

### 4.5 `Debug events`

The raw event table **moves** here from the task page. It is a collapsible `Card` titled `Debug
events` with a `COUNT` badge, **collapsed by default**, at the bottom of the session detail page,
containing exactly the table that lives at `TaskDetail.tsx:25-41` today: `#seq | type | compact(payload)`
with the full payload (2 000 chars) in the `title` attribute, in the same `EVENT_LOG` /
`EVENT_ROW` boxes, over **all** events including `PROVIDER_RAW` and `STDERR`.

Consequently `RunEvents` is **deleted from `TaskDetail.tsx`**, and the expanded run row instead gains
an `Open session ↗` link to `/sessions/:sessionId` (assumption A1). There must be exactly one raw
event table in the product.

Filter affordance inside Debug events: a `Segmented`/`Tabs` control `All | Provider | Runner`
filtering by `SessionEvent.source`. That is the whole feature — no free-text search this batch.

### 4.6 Cost and Tokens made real

**4.6.1 Extraction at ingest.** In `POST /runner/runs/:runId/events`, after the `createMany`, scan
the accepted batch for events with `type === "FINAL_OUTPUT"` and pull usage out of the payload:

| runner | tokens | cost |
|---|---|---|
| CLAUDE | `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens + usage.cache_creation_input_tokens` → cached | `total_cost_usd` (number → `Decimal(12,4)`) |
| CODEX | `usage.input_tokens`, `usage.output_tokens`, `usage.cached_input_tokens` | none — leave `costUsd` null |
| PI | whatever matches the same `usage.{input_tokens,output_tokens}` shape; otherwise nothing | none |

Extraction is **shape-driven, not runner-driven**: read `payload.usage` if it is an object, take the
numeric fields that are present, and ignore the rest. A payload with no usage updates nothing. If
several `FINAL_OUTPUT` events arrive (resume attempts), the values **accumulate** for tokens
(`+=`) and for cost (`+=`), because a resumed session genuinely spent both. Every field is optional
and independently nullable.

**4.6.2 Schema change.** New migration under `packages/db/prisma/migrations/`, additive and
nullable only:

```prisma
model Session {
  // …
  inputTokens        Int?
  outputTokens       Int?
  cachedInputTokens  Int?
  totalTokens        Int?   // input + output; cached excluded to avoid double counting
}
```

No column is dropped, no column is made required, no data is destroyed — so BACKLOG-V2's
"迁移的破坏性守卫不对称" precheck requirement does not apply to this batch.

**4.6.3 Backfill.** A one-shot idempotent script (`packages/db/prisma/backfill-session-usage.ts`,
exposed as a root-level `npm run db:backfill-session-usage`) that walks sessions whose `totalTokens`
**is null**, reads their stored `FINAL_OUTPUT` events, applies the same extraction function, and
writes the columns. Running it twice must be a no-op. The extraction function is shared with the API
path — one implementation, two callers.

**4.6.4 UI.** The runs table on task detail gains a `Tokens` column between `Cost` and `Failure
class`, showing `compactTokens(session.totalTokens)`: `null → —`, `< 1000 → "812"`, `≥ 1000 →
"8.9K"` (one decimal, trailing `.0` stripped), `≥ 1_000_000 → "1.2M"`. `compactTokens` is a new
export in `lib/format.ts`. The `Cost` column is unchanged in code and starts showing real numbers
for CLAUDE runs. The task-level stat bar's `spend` pill (`TaskDetail.tsx:175`) gains a sibling
`N tokens` pill summing the runs.

**4.6.5 The honest fallback.** For any runner or session where usage is absent, every one of these
surfaces shows `—` (or omits the pill), never `0`, and never an estimate. If, at implementation
time, CLAUDE's `result` payload turns out not to carry `usage`/`total_cost_usd` in the installed CLI
version, the implementer ships the columns showing `—`, files a BACKLOG-V2 ledger note naming the
CLI version checked, and **does not** invent a metering pipeline — that is the brief's explicit
instruction and it overrides §4.6.1.

### 4.7 Task detail: readable outputs, clickable branch and PR

**4.7.1 Step output as markdown.** The `Step output` card (`TaskDetail.tsx:208-213`) renders
`output.body` through `Markdown` (§4.8) instead of `ShowMore`'s plain-text clamp. Long bodies stay
clamped: wrap the rendered markdown in a max-height container (`max-h-[420px] overflow-hidden`) with
a `Show more` / `Show less` toggle underneath, same control shape as `ShowMore`. Kind pill and
`Updated <timeAgo>` line are unchanged.

**4.7.2 Branch and PR as links.** Add to the task `Details` `KeyValue`:
- `Branch`: the newest run's `branch`, hyperlinked to `<repoWebUrl>/tree/<branch>`;
- `Pull request`: the newest run's `pullRequestUrl`, hyperlinked, label `#<number>` parsed from the
  URL tail, falling back to the full URL.

The run row's `Branch` cell (`TaskDetail.tsx:51`) becomes the same link, and the expanded row's
`Push` entry keeps its status word but drops the duplicated anchor.

`repoWebUrl` derivation, a new pure helper in `lib/format.ts`:
`https://github.com/o/r(.git)?` → `https://github.com/o/r`; `git@github.com:o/r.git` →
`https://github.com/o/r`; **anything else → null**, and the field renders as plain text. No other
forge is special-cased. All external links open with `target="_blank" rel="noreferrer"`, matching
`TaskDetail.tsx:70`.

### 4.8 Markdown: fenced code and links

`Markdown` in `components/ui.tsx` gains exactly two constructs, and nothing else:

1. **Fenced code blocks** — ```` ```lang ```` … ```` ``` ````. Rendered in `CODE_BLOCK`, content
   verbatim, language label shown as a small muted caption above the block when present. An
   unterminated fence at end of input renders the remaining lines as a code block (do not drop
   them). Inline `` `code` `` behaviour is unchanged.
2. **Links** — `[text](url)`. Rendered as an anchor; `http`/`https` only, everything else renders as
   literal text (a spec body containing `[x](javascript:…)` must not become a live link).

Headings currently render as bold paragraphs; that stays. Tables stay unsupported (batch 3).

---

## 5. Data and interface changes

### 5.1 New and changed HTTP endpoints

| method | path | change | shape |
|---|---|---|---|
| GET | `/sessions` | **new** | query `?projectId&limit=50&before=<ISO>`; returns an array of sessions including `agent {id,title}`, `task {id,name}`, `goal {id,name}`, and `run {id,runNumber,model,branch,pullRequestUrl}`; ordered `requestedAt desc` |
| GET | `/sessions/:sessionId` | **new** | one session with the same includes plus `workspacePath`, `terminationReason`, `exitCode`, token columns, `costUsd`; 404 `{error:"Session not found"}` |
| GET | `/runs/:runId/events` | **changed shape** | gains `?afterSeq=<int>&limit=<int, default 500, max 2000>`; returns `{events: SessionEvent[], nextAfterSeq: number \| null, hasMore: boolean, total: number}` instead of a bare array |

The third row is the one breaking change in this batch and the reason §10 calls out an API rollback
note. Its only in-repo consumer is `TaskDetail.tsx` (verified by grep), which this batch rewrites
anyway. **Callers outside the repo do not exist** — the CLI package does not call it (verify with
`grep -rn "runs/.*events" packages/cli` before changing it; if a caller appears, update it in the
same commit).

Both new GETs are operator-authenticated like every other read route; no new auth surface, no new
token kind.

### 5.2 API implementation notes (for the plan step, not prescriptive)

- Usage extraction belongs in a small pure module (`packages/api/src/usage.ts`) exporting
  `extractUsage(payload: unknown): {inputTokens?, outputTokens?, cachedInputTokens?, costUsd?}` and a
  `applyUsage(db, sessionId, usage)` that accumulates. Pure function, table-driven tests (§8).
- The events ingest path must not get slower in the common case: the scan is over the request body
  already in memory, and the `session.update` fires **only** when a `FINAL_OUTPUT` with usage is in
  the batch.

### 5.3 Polling contract — interval, backoff, ceilings

This is the acceptance-critical part of "a running session's stream is readable live".

- **Session detail metadata** (`GET /sessions/:sessionId`): `usePoll` at `POLL_MS` = **2.5 s**.
- **Events**: a dedicated hook that keeps events in a ref-backed array and fetches
  `GET /runs/:runId/events?afterSeq=<highest seq held>&limit=500`, appending the result.
  - **Initial load**: `afterSeq` absent; drain forward page by page while `hasMore` is true, up to a
    hard ceiling of **40 pages (20 000 events)**. On hitting the ceiling, stop fetching and show a
    notice above the stream: `Showing the first 20,000 events of N. Older-session rendering is
    capped.` Counts in the stat bar are then labelled with a `+` (`43+ messages`).
  - **Live interval**: **2.5 s** while the session is non-terminal.
  - **Backoff ceiling**: after **4 consecutive** polls that return zero new events, the interval
    doubles per empty poll up to a ceiling of **15 s**, and resets to 2.5 s the moment events
    arrive. This is the "ceiling" the acceptance shape asks for.
  - **Stop condition**: when `executionStatus` is terminal (`SUCCEEDED | FAILED | TIMED_OUT |
    CANCELLED | LOST`) **and** a poll returns `hasMore === false` with zero new events, polling stops
    entirely. `Refresh` restarts one cycle.
  - `document.hidden` already suppresses fetches in `usePoll`; the event hook must do the same.
- **Debug events** reuses the already-fetched array — it does **not** issue its own requests.
- A poll failure does not clear the stream: keep the last good data, surface an `ErrorNotice` above
  the stream, keep polling.

### 5.4 New frontend modules

- `apps/web/src/lib/session-stream.ts` — pure, no React: `normalize(events: SessionEvent[]):
  {items: StreamItem[], files: FileTouch[], counts: {messages, toolCalls, files}}`. Both the stat bar
  and the stream read from one call, so a count can never disagree with what is rendered.
- `apps/web/src/lib/use-event-stream.ts` (or a hook inside `hooks.ts`) — the polling contract of §5.3.
- `apps/web/src/pages/Sessions.tsx` — `SessionsPage` and `SessionDetailPage`, exported the same way
  `Tasks.tsx` / `TaskDetail.tsx` are, wired into `App.tsx:17-30` as `/sessions` and
  `/sessions/:sessionId`.
- `lib/types.ts`: extend `Session` with the four token fields and the new includes; add `StreamItem`
  types alongside `session-stream.ts` (not in `types.ts`, which mirrors API rows).

### 5.5 What must not change

- No router library, no state library, no markdown dependency, no syntax highlighter, no charting
  library (decisions §3). The only new npm dependency permitted this batch is **none**.
- `usePoll`'s existing signature and `POLL_MS` stay as they are; the new hook sits beside it.
- No change to `packages/runner` — the runner already emits everything needed. If the implementer
  believes a runner change is required, that is a signal the payload shapes were misread; re-verify
  against a real session first, and if a runner change is genuinely needed, write it into the plan
  as a flagged deviation rather than silently making it.

---

## 6. Edge cases and failure behaviour

| situation | required behaviour |
|---|---|
| Session with zero events (queued, never started) | Stream shows `EmptyState`: `No events yet.` Stat bar shows `0 messages · 0 tool calls · 0 files`. Page does not error. |
| Event payload is not an object, or is `null` | Contributes no stream item, no file, no count. Never throws. `normalize` must be total over `unknown`. |
| `TOOL_COMPLETED` with no matching `TOOL_STARTED` (truncated stream, resumed session) | Rendered as a tool item with `Arguments: —` and the result present. It counts as a tool call. |
| `TOOL_STARTED` never completed (session died mid-tool) | Rendered with a `running` marker; if the session is terminal, marker reads `incomplete`. |
| Same `toolCallId` appearing twice | Later `TOOL_COMPLETED` wins; one item, not two. |
| Enormous tool result (a 2 MB file read) | Truncated at 8 000 chars per §4.3.1. The 160-char `compact()` truncation in Debug events is unchanged. |
| Very long single-line output with no whitespace | Wraps — every code and path surface carries `[overflow-wrap:anywhere]`, as `CODE_BLOCK` already does. |
| Session resumed (`resumeAttempt > 0`) | One continuous stream; `seq` is per session and keeps rising, so nothing special is needed. Meta line shows `Resume attempts: N` when non-zero. |
| `WAITING_INBOX` session | Status pill `waiting`; `● Live` still shown (it is not terminal); a notice above the stream: `Waiting on an Inbox decision.` linking to `/inbox/:waitingOnMessageId` when set. |
| API returns 404 for `/sessions` (older API) | `GapNotice`, not a red error. |
| `/runs/:runId/events` returns the **old** bare-array shape (API not yet deployed) | The hook accepts both shapes: an array is treated as `{events, hasMore:false}`. This costs five lines and removes a deploy-ordering hazard. |
| Session's run has no `session` row (run failed before session creation) | It simply does not appear in `/sessions`; the task page's run row shows no `Open session` link. |
| `costUsd` present but `totalTokens` null (or the reverse) | Show what exists, `—` for the other. Never derive one from the other. |
| Markdown body containing an unterminated code fence | Remaining lines render as a code block; no content is dropped. |
| Step output body that is empty or whitespace | Card renders `EmptyState`, as the Prompt card already does. |
| Repo `remoteUrl` is not GitHub (or null) | Branch/PR render as plain text; no broken link. |
| Clock skew makes `endedAt < startedAt` | `duration()` already clamps at 0; do not add new arithmetic. |

---

## 7. Non-functional expectations

- **A 5 000-event session must render without freezing the tab.** `normalize` runs inside a
  `useMemo` keyed on the event count, not on array identity, so a poll that returns nothing does not
  re-normalize. Incremental appends must not re-normalize from scratch if profiling shows it costs
  more than ~50 ms — but do not build an incremental normalizer speculatively; measure first.
- The stream is a plain list. **No virtualization this batch** — it is a new dependency and 20 000
  DOM rows is beyond the ceiling anyway. If the ceiling proves too high in practice, lower it and
  file a ledger note.
- No layout shift on poll: rows already rendered must not resize when new ones append.
- Light and dark themes both correct — every colour comes from an existing token; no hardcoded hex.

---

## 8. Test expectations

Tests are part of the deliverable, not an afterthought. The suite must be green under `npm run
build && npm test` from the repo root (build first — `styles.test.tsx` asserts against
`dist/assets/*.css`).

**New — `apps/web/src/tests/session-stream.test.ts`** (the largest of the new tests, table-driven
over hand-written fixtures for all three runners):
- CLAUDE: an `assistant` `MODEL_DELTA` with mixed `text` + `tool_use` content yields one `text` item
  and (with its `TOOL_STARTED`) one `tool` item; `file_path` lands in Files touched.
- CODEX: `agent_message` item yields `text`; `command_execution` yields a `tool` item whose primary
  argument is the command; a `file_change` item contributes its `changes[].path`.
- PI: `turn_end` assistant message yields `text`; `tool_execution_start`/`_end` pair yields one tool
  item.
- Counting: messages/toolCalls/files match the definitions in §4.2 on a mixed fixture.
- Robustness: `payload: null`, `payload: 42`, `payload: {}`, missing `toolCallId`, orphan
  `TOOL_COMPLETED`, duplicate `toolCallId` — all produce sane output and no throw.
- Noise exclusion: `PROVIDER_RAW`, `STDERR`, `MODEL_STARTED`, `PROVIDER_STATUS` produce zero items.

**New — `packages/api/src/usage.test.ts`**: extraction from a real-shaped CLAUDE `result` payload
(tokens + cost), a CODEX `turn.completed` payload (tokens, no cost), a payload with no `usage`
(returns empty), a payload with partial usage, and accumulation across two `FINAL_OUTPUT` events.

**New — API route tests** in the existing `packages/api/src/app.test.ts` style: `GET /sessions`
respects `projectId`/`limit`/`before` and includes agent+task; `GET /sessions/:sessionId` 404s on an
unknown id; `GET /runs/:runId/events?afterSeq=&limit=` returns only later events, reports `hasMore`
correctly, and clamps `limit` at 2 000.

**New — `apps/web/src/tests/markdown.test.tsx`** (or an extension of the existing primitives test):
fenced code block renders as a code block with its content verbatim; `[a](https://x)` renders an
anchor; `[a](javascript:alert(1))` renders literal text, not an anchor; unterminated fence renders
its remaining lines.

**New — format tests**: `compactTokens` boundaries (0, 999, 1 000, 8 900, 999 999, 1 200 000, null)
and `repoWebUrl` for https, https-with-.git, ssh, and a non-GitHub remote.

**Must keep passing unmodified**: `styles.test.tsx`, `primitives.test.tsx`,
`input-semantics.test.tsx`, `row-menu.test.tsx`, `storage.test.tsx`, and every existing test in
`packages/api` and `packages/db`. A migration is added, so `npm run db:validate` and the drift check
must also be clean.

---

## 9. Reviewer verification (how a human checks the feature works)

Run in order. Each step states its expected observation.

```bash
npm run build          # must succeed, no new TS errors
npm test               # full workspace suite, green
npm run db:validate    # schema valid after the migration
```

Then, against a live control plane with at least one finished and one running agent task:

1. **List.** Open `/sessions`. Expect: a `Sessions` entry in the sidebar; a table with the columns
   of §4.1 in that order; the live run's Duration increasing every ~2.5 s without a page reload; a
   `CLAUDE` / `CODEX` / `PI` pill on every row.
2. **Live stream.** Click the running session. Expect: `● Live` in the stat bar; agent prose rendered
   as prose (headings, bullets, `code`, fenced blocks — not JSON); new messages appending at the
   bottom within ~3 s of the agent producing them; the counters in the stat bar rising.
3. **Tool calls.** Find a `Read`/`Edit`/`Bash` call. Expect: collapsed to one line with the file path
   or command; expanding shows Arguments and Result; the absolute path is shown in full and is
   selectable.
4. **Files touched.** Expect the section collapsed with a count badge; expanding lists distinct
   absolute paths; the count equals the `N files` stat pill. (For a CODEX or PI session, if the
   payload shapes did not verify, expect the honest hint and a matching BACKLOG-V2 ledger note.)
5. **Backoff and stop.** Watch a session finish. Expect: `● Live` disappears within one poll; the
   meta line shows a duration, a token count and a start time; network polling of the events
   endpoint stops (check DevTools Network — no further requests to `/runs/*/events`).
6. **Debug events.** Expect: the section present, **collapsed by default**, showing raw `#seq | type
   | payload` rows including `PROVIDER_RAW`; the source filter works; and — importantly — the raw
   table is **gone** from the task detail run row, replaced by an `Open session ↗` link.
7. **Outputs and links.** Open a task whose spec/plan step has an output. Expect: the body rendered
   as markdown with working fenced code blocks; `Branch` and `Pull request` in Details are anchors
   that open GitHub in a new tab; the run row's branch cell is the same link.
8. **Cost and Tokens.** Expect: a `Tokens` column on the runs table; for a CLAUDE run finished after
   this batch deploys, real numbers in both `Cost` and `Tokens`; for a CODEX run, tokens present and
   cost `—`; for anything unknown, `—` and never `0`.
9. **Backfill.** Run `npm run db:backfill-session-usage` twice. Expect: the first run fills historic
   sessions (the task page's older runs stop showing `—`), the second reports zero updates.
   *(Corrected 2026-08-16 by batch 4 FIXES: run it **after** the API is restarted onto the fixed
   code, and the second run must report `updated 0` **and exit zero** — the script now exits
   non-zero if any session failed. Full sequence:
   [`docs/runbooks/batch-4-rollback.md`](../runbooks/batch-4-rollback.md) §1.6.)*
10. **Themes.** Toggle the theme control. Expect: the session page is correct in light and dark; no
    hardcoded colour anywhere in the diff (`grep -nE "#[0-9a-fA-F]{3,8}" apps/web/src/pages/Sessions.tsx`
    returns nothing).
11. **Degradation.** Point the web app at an API without the new routes (or stop the API). Expect:
    `GapNotice`/`ErrorNotice`, not a blank page or an uncaught error.

---

## 10. Rollback notes

The batch is **not** purely UI. Three layers, three rollback stories:

1. **UI (`apps/web`)** — pure revert. Removing the new pages, the nav entry and the two route rows
   returns the app to `b820152` behaviour. No stored state, no localStorage key, no cache.
2. **API — two additive routes** (`GET /sessions`, `GET /sessions/:sessionId`). Removing them breaks
   only the new pages. No consumer outside `apps/web`.
3. **API — one changed response shape** (`GET /runs/:runId/events` becomes an envelope). *This is the
   only backwards-incompatible change in the batch.* If the web app is rolled back but the API is
   not, the old `RunEvents` component would receive an object where it expects an array and render
   nothing. Mitigations, both required: the new hook accepts either shape (§6), and the rollback
   procedure for the API is stated here — **revert the API and the web app together, or revert the
   API alone (the new envelope-aware client tolerates the old array), but never revert the web app
   alone while keeping the new API.**
4. **DB migration** — four nullable `Int` columns on `Session`. Rolling the code back does not
   require rolling the migration back: unread nullable columns are inert. If the migration must be
   reverted, `ALTER TABLE "Session" DROP COLUMN` on the four columns loses only derived data that
   the backfill script can recompute from `SessionEvent` at any time. **No destructive migration, no
   precheck script required** (contrast BACKLOG-V2's 破坏性守卫 item).
5. **The backfill script** is idempotent and ~~write-only-to-null~~ *(false — see the superseding
   note below)*. Re-running it after a rollback and re-deploy restores the numbers.

> **Superseded 2026-08-16 by batch 4 FIXES**
> ([spec](batch-4-fixes-usage-correctness.md) MF-3/MF-3b,
> [runbook](../runbooks/batch-4-rollback.md)). Two corrections to items 4 and 5.
>
> **Item 4 omits the migration's two indexes.** `20260816165548_batch4_session_usage`
> also creates `Session_projectId_requestedAt_idx` and `SessionEvent_runId_seq_idx`.
> On a production-sized `SessionEvent` an ordinary `CREATE INDEX` blocks every
> insert for its duration and queues every later writer behind it, so the indexes
> are built **out of band** with `CREATE INDEX CONCURRENTLY` before the migration
> runs, and rolling them back is `DROP INDEX CONCURRENTLY`, one statement per
> `psql -c`, outside any transaction. `docs/runbooks/batch-4-rollback.md` is the
> authoritative procedure for both directions; it also records that
> **`Session.costUsd` predates this migration and must never be dropped with the
> four token columns**.
>
> **Item 5's "write-only-to-null" is false.** The backfill is an absolute
> recompute from `SessionEvent` of every session that has a `FINAL_OUTPUT` event;
> it overwrites any populated cache that differs from the recomputed value and
> writes nothing when they match. That distinction is load-bearing — a
> write-only-to-null backfill would skip every already-populated session, which is
> exactly the population batch 4 FIXES' corrected extractor has to repair.

---

## 11. Assumptions

Each of these is a place where the request was ambiguous, the simplest reading was taken, and the
choice is written into the spec. Ordered by how much a different answer would cost.

- **A1 — the raw event table *moves*, it does not get duplicated.** The brief says the JSON stream
  "moves into a collapsed-by-default Debug events view". I read that as: it leaves `TaskDetail.tsx`
  entirely and re-homes on the session page, with the task page's run row gaining an `Open session ↗`
  link. The alternative reading — keep it in the run row but collapsed — leaves two raw tables in
  the product. If Leo wants the run row to keep its own copy, this is a small change to §4.5, but it
  is worth deciding before ⑤.
- **A2 — CODEX `reasoning` items are excluded from the stream.** They are voluminous and the
  original's stream shows messages and tool calls, not reasoning. They remain visible in Debug
  events. If Leo wants them, the cheapest form is a `Show reasoning` toggle in the stat bar row.
- **A3 — auto-scroll is conditional**, only when the reader is already at the bottom (within 100 px).
  The original's behaviour at [0:16:30] is not determinable from the frame.
- **A4 — PI usage is treated as absent until verified.** PI's `agent_settled` payload shape was not
  verifiable from the code alone. §4.6.1's extraction is shape-driven, so if PI happens to emit
  `usage.{input_tokens,output_tokens}` it works for free; if not, PI sessions show `—` and get a
  ledger note.
- **A5 — usage extraction lives in the API ingest path, not the runner.** The alternative (runner
  computes and reports at `completeRun`) would touch `packages/runner`, which is the file set most
  contended by other chains. The API path has the same data and a smaller blast radius.
- **A6 — token columns accumulate across resumes.** A resumed session really did spend the tokens of
  both attempts, so `+=` is the honest arithmetic. The alternative (last-writer-wins) would
  under-report resumed sessions.
- **A7 — `Sessions` sits between `Tasks` and `Goals` in the sidebar.** The original's ordering is
  only visible in the mobile PWA frame (Inbox/Goals/+/Sessions/Tasks), which we are not building.
- **A8 — the session list is project-scoped** via `?projectId=`, matching `GET /tasks`. Sessions
  carry `projectId`, so this is free; the alternative (global list) would be inconsistent with every
  other page.
- **A9 — 20 000 events is the render ceiling and 15 s is the poll-interval ceiling.** Both are
  judgement calls with no reference behaviour to copy. Both are single constants, trivially
  retuned.
- **A10 — no `Refresh`-on-the-list debounce.** The button forces one reload; spamming it is
  harmless at this scale.

## 12. Open questions (recorded, not blocking)

1. **CODEX `file_change` and PI tool-arg payload shapes are inferred, not observed.** §4.4 states the
   verification duty and the honest fallback, so ⑤ can proceed either way. Recorded here because if
   both fall through, `Files touched` is a CLAUDE-only feature this batch and that should be a
   conscious outcome, not a surprise at the PR gate.
2. **Does any out-of-repo consumer call `GET /runs/:runId/events`?** In-repo grep says no. If Leo has
   a personal script against it, the envelope change breaks it; the fix would be to keep the bare
   array behind a `?v=1` flag. Not worth building speculatively.

## 13. Follow-ups this batch deliberately does not do

Candidates for a BACKLOG-V2 ledger note if the implementer confirms them:
- Markdown tables in outputs (batch 3 owns the renderer upgrade).
- Event pruning / retention: `PROVIDER_RAW` doubles the row count for no reading value.
- A `Sessions` filter by agent/status — the list is short enough at 50 rows/page today.
- Session-level cost attribution and the Costs page (decisions §9, remains deferred).
