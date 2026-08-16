# Batch 4 — sessions viewer

Status: current.

This page describes the current session-reading surface: where sessions are listed, how their
stored events become readable messages and tools, how usage is derived, and which boundaries are
intentional.

## What the operator can see

The sidebar contains `Sessions` between `Tasks` and `Goals`. The hand-written route table in
[`App.tsx`](../../apps/web/src/App.tsx) serves `/sessions` and `/sessions/:sessionId`.

### Session list

[`SessionsPage`](../../apps/web/src/pages/Sessions.tsx) polls the project-scoped
`GET /sessions?projectId=…&limit=50` endpoint every 2.5 seconds. The API orders rows by
`requestedAt desc`; the page renders Started, Agent, Task/Goal, Runner, Duration, Status, and
Result. A row opens its session, while the nested Task or Goal link keeps its own destination.

Older rows are loaded with `before=<oldest requestedAt>` rather than infinite scrolling. The live
first page and imperatively loaded older pages are separate state; the rendered list is sorted and
deduplicated by session id. Older pages reset when the selected project changes. Refresh reloads
the live head and polling continues. An absent endpoint produces the existing `GapNotice`, and an
empty project produces an `EmptyState`.

The API clamps `limit` to 1–200 and ignores an invalid `before` cursor. The web page uses a page
size of 50 and treats a short page as exhausted. The route is deliberately plural: the auth
boundary denies the singular `/session/` prefix.

### Session detail

The detail page polls `GET /sessions/:sessionId` at the same 2.5-second interval, including after
the session becomes terminal. The response includes the agent, task, goal, and run; the run
contains model, branch, workspace, pull-request URL, and the repository remote. A missing session
returns `404 {"error":"Session not found"}`.

The header shows the agent, session status, runner, and Refresh. The Details card shows Task, Run,
Model, Started, Duration, Branch, Workspace, Termination, and non-zero Resume attempts. A GitHub
remote produces a branch link; a null or non-GitHub remote remains plain text.

The stat bar is derived from the same normalized event list rendered below it:

- live statuses (`REQUESTED`, `PROVISIONING`, `RUNNING`, `WAITING_INBOX`) show `Live`;
- `SUCCEEDED` shows `Done`; other terminal statuses show `Failed`;
- message, tool, and file counts are followed by `+` when the event render ceiling was reached;
- token and cost pills are omitted when their value is unknown.

`WAITING_INBOX` always displays `Waiting on an Inbox decision.`; it links to the Inbox only when a
message id is available. A session failure reason is shown above the stream.

## API and persistence contracts

The API implementation is in [`packages/api/src/app.ts`](../../packages/api/src/app.ts). Both
session reads are operator-authenticated and share one relation selection. The event read is the
one changed response shape:

```text
GET /runs/:runId/events?afterSeq=<seq>&limit=<n>
{
  events,
  nextAfterSeq,
  hasMore,
  total
}
```

The default page size is 500 and the maximum is 2,000. `afterSeq` is exclusive; `total` is the
whole run's event count, not the filtered page count. The API fetches one extra event to calculate
`hasMore` and uses the `[runId, seq]` index.

The web client in [`use-event-stream.ts`](../../apps/web/src/lib/use-event-stream.ts) accepts the
old bare-array response as well. It filters that array by the requested sequence and deduplicates
all appends by `seq`, because an older endpoint ignores `afterSeq`. This makes a web-first deploy
safe. The reverse rollback is unsafe: an old web client cannot read the new envelope, so revert
the API and web together or revert the API alone.

### Usage columns are a derived cache

[`Session`](../../packages/db/prisma/schema.prisma) has four nullable integer columns:
`inputTokens`, `outputTokens`, `cachedInputTokens`, and `totalTokens`. The migration also indexes
`Session(projectId, requestedAt)` and `SessionEvent(runId, seq)`. It is additive; the columns may
be unread by older code and no event data is removed.

[`packages/db/src/usage.ts`](../../packages/db/src/usage.ts) is the single usage implementation.
`extractUsage` is total over unknown payloads and reads shape rather than runner name:

- `usage.input_tokens` and `usage.output_tokens` populate the input/output columns;
- `usage.cached_input_tokens`, or the sum of Claude's cache-read and cache-creation fields,
  populates cached input;
- top-level numeric `total_cost_usd` populates cost;
- `reasoning_output_tokens` is intentionally not included in output tokens.

`sumUsage` preserves absent fields. `deriveUsageColumns` leaves token fields null when the provider
reported no corresponding value, computes `totalTokens` as input plus output only when at least one
of those values exists, excludes cache from that total, and rounds cost to the database's four
decimal places. Thus cost-only data does not become zero tokens, and unknown data is shown as `—`.

The event table is the source of truth. After a batch containing `FINAL_OUTPUT` is inserted,
`recomputeSessionUsage` folds every stored `FINAL_OUTPUT` for the session and writes absolute
column values only when they differ. This makes the write idempotent, accumulates resumed attempts,
repairs a partial write, and avoids arithmetic on nullable columns. A recompute failure is logged
and does not fail event ingest: usage is a derived cache and can be repaired later.

[`backfill-session-usage.ts`](../../packages/db/prisma/backfill-session-usage.ts) scans every
session with at least one `FINAL_OUTPUT`, recomputes it in batches of 200, and prints
`scanned N, updated M`. A second run is a no-op, including for cost-only sessions. The production
migration must be deployed before the API is restarted; the runner has no migration or restart
requirement for this feature.

## Event normalization and stream rendering

[`session-stream.ts`](../../apps/web/src/lib/session-stream.ts) is pure and total over malformed
payloads. It returns `text`, `tool`, `error`, and `final` items, file touches, and counts. The page
uses one normalization result for both the stream and stat bar, so counts describe rendered items
rather than raw database rows.

### Provider mappings

- **CLAUDE:** assistant text comes from `MODEL_DELTA.message.content[]`; tool starts are the
  `tool_use` part and tool completions are `tool_result` parts. File paths come from
  `input.file_path` or `input.notebook_path`; search-directory `path` arguments are excluded.
  `FINAL_OUTPUT.result` supplies the Result card.
- **CODEX:** `agent_message` items become text, and a later event with the same item id replaces
  the earlier text. `file_change.changes[].path` contributes file touches. Command-execution tool
  argument/result fields are handled using the inferred `command` and `aggregated_output` shape;
  non-matching data degrades without throwing. The final text falls back to the last agent
  message. `reasoning` items are excluded.
- **PI:** assistant `MODEL_COMPLETED` messages become text. The normalizer suppresses the adapter's
  duplicate `message_end`/`turn_end` emission by message timestamp, or by a parsed
  `textSignature.id`; an event without identity is not suppressed. Tool failures use `isError`,
  and tool results are extracted from `result.content[]`. `agent_settled` has no display text, so
  PI has no Result card.

`ADAPTER_ERROR` becomes an inline error item. Its message preference is `message`, string
`error`, nested `error.message`, then compact JSON truncated to 500 characters. Provider status,
raw provider lines, stderr, model-start, tool-progress, process-start, unknown events, and the
excluded reasoning items remain visible only in Debug events.

### Tool and file rules

Tool starts and completions join by `toolCallId`; an event id is the fallback key when it is absent.
Duplicate completions use the last result and state. An orphan completion still renders and counts
as a tool with `Arguments: —`. An unfinished tool is `running` while the session is live and
`incomplete` once the session is terminal. Completion states are `ok` or `error` according to the
runner payload.

Tool rows are collapsed one-liners. Expansion shows the full path, pretty JSON Arguments, and
Result; each code block is limited to 8,000 characters with an explicit truncation line. File paths
are displayed separately, untruncated and wrap-enabled. `Files touched` lists distinct paths in
alphabetical order with a per-path touch count and is collapsed by default. Relative paths are
kept verbatim; no path is resolved against the workspace.

For a non-Claude session with tool calls but no extracted paths, the page says
`File tracking is not available for <RUNNER> sessions.` rather than presenting zero as a verified
fact. The relevant PI argument keys and CODEX `file_change` shape are still inferred and are
tracked in [`BACKLOG-V2.md`](../BACKLOG-V2.md).

### Polling and reader behavior

`useEventStream` starts with an initial forward drain of 500-event pages. It stops rendering at
40 pages / 20,000 events and shows the loaded count and server total; stat counts receive a `+`.
While non-terminal, an empty poll backs off after four consecutive empty responses: 2.5 seconds,
then 5, 10, and 15 seconds, with 15 seconds as the ceiling. Any new event resets the delay to
2.5 seconds. A terminal session stops event polling after a poll has no new events and
`hasMore` is false. Refresh starts another cycle without clearing the held event sequence.

Hidden tabs issue no fetches. A failed poll retains the last good events, shows an ErrorNotice,
and schedules another poll. The Debug events section reuses this same event array and makes no
additional request.

The stream is oldest-first. Initial history is not treated as unseen news; a live session is
positioned at the newest output after its initial drain, while a finished session remains at the
beginning. Later events auto-scroll only when the reader is within 100 pixels of the bottom;
otherwise an `N new ↓` control appears.

Debug events is collapsed by default and contains every raw event in the `#seq | type | payload`
table. Payloads are compacted to 160 characters in the row and retained to 2,000 characters in
the title. `All`, `Provider`, and `Runner` filter by source, with Provider meaning every source
other than `RUNNER` because the enum has no literal Provider value.

## Task detail and Markdown

[`TaskDetail.tsx`](../../apps/web/src/pages/TaskDetail.tsx) now shows step output through the
shared `Markdown` renderer. Non-empty output is clamped at 420px with the same Show more/Show less
control used elsewhere; whitespace-only output is `No output recorded.`. The renderer supports
the existing headings, lists, bold, and inline code plus:

- fenced code blocks with an optional language caption, preserving fenced content verbatim;
- unterminated fences, which render their remaining lines as code;
- links only for `http://` and `https://`, opening in a new tab; other schemes stay literal text.

Tables and syntax highlighting remain unsupported.

Task detail has a Tokens column and a task-level tokens pill. Cost is displayed from the same
session cache. The task Details card and each run row expose a GitHub Branch link when the remote
matches the supported HTTPS or SSH forms; all other remotes remain plain text. Pull-request
labels use `#<number>` for a `/pull/<number>` tail and otherwise retain the URL. Each expanded run
also exposes its own Pull request link and `Open session ↗`. There is no raw event table on the
task page; the session detail is the only raw-event home.

## Constraints and deliberate boundaries

- No new npm dependency, router, state library, Markdown package, syntax highlighter, charting
  library, virtualization, SSE, or WebSocket was added. The stream is a bounded plain list and
  the existing `usePoll` signature and `POLL_MS` remain unchanged.
- The runner is unchanged. It already emits the event vocabulary consumed by the normalizer.
- Session metadata continues polling at 2.5 seconds even after terminal state; only the event
  stream has a hard stop. This keeps late end-state and backfilled usage visible.
- Raw events have one reading surface by design. The task run row links to that surface instead
  of maintaining another copy.
- Orphan tool completions count because counts are derived from the normalized items; this keeps
  the stat bar and visible stream consistent. This is the chosen behavior for the specification's
  conflicting orphan-count statements.
- PI usage and cost are deliberately not harvested. PI reports them per `message_end`/`turn_end`
  under `message.usage.{input,output,cacheRead,cacheWrite,reasoning,totalTokens,cost.total}`;
  summing directly would double-count the adapter's duplicate emissions. PI therefore shows
  unknown usage until a message-identity-aware aggregation is implemented.
- CODEX reasoning output tokens are currently excluded from `outputTokens`; changing that is a
  data-definition decision, not a display-only tweak.

## Verification and fixture support

The batch's tests cover the pure normalizer, provider payloads, usage recomputation, API route
shapes, polling transitions, Markdown safety, task links, row interaction, pagination, and the
empty/error states. Build must run before the web tests because the style tests read emitted CSS:

```sh
npm run build
npm test
npm run typecheck
npm run db:validate
```

The baseline screenshot harness also serves `/sessions` and `/sessions/:id` with real session event
vocabulary and token-bearing fixtures. Those four session frames have no pre-batch comparison
frame; they are reference fixtures for the current pages, not pairwise regressions.

Start with [`Sessions.tsx`](../../apps/web/src/pages/Sessions.tsx), then inspect
[`session-stream.ts`](../../apps/web/src/lib/session-stream.ts) and
[`use-event-stream.ts`](../../apps/web/src/lib/use-event-stream.ts) before changing a displayed
count, provider mapping, polling limit, or debug row. Usage changes belong in
[`packages/db/src/usage.ts`](../../packages/db/src/usage.ts) so ingest and backfill cannot drift.
