# Sessions readability rework

Specification of record for the chain on branch `feat/sessions-readability`.
Written against workspace HEAD b2ca7fedeaf6ad3da796d3478eb871ae4d3ec7c5.

Source of authority: the feature brief on this task, which distills the
Sessions card of the decision record `records/AUDIT-danny-parity-refresh-20260826.md`
(approved by Leo 2026-08-26). That record lives in the private operator
repository and is not tracked here; the brief is the version this spec obeys.
Design reference is the DeepSeek Harness (dsh) session UI: its patterns are
borrowed, none of its code or architecture is ported.

## Problem Statement

The Sessions surface is the operator's window onto every Run the control plane
has executed, and it is the largest daily readability pain in the product.

On the list, every Session is one row of a flat seven-column table - Started,
Agent, Task, Runner, Duration, Status, Result. Each row leads with an absolute
timestamp, so the column an operator scans first is the one that varies least
and means least. Every row is the same visual weight, there is no break between
one day's work and the next, and page one is fifty rows with a Load more button
under it. Past a few dozen Sessions the operator cannot answer the two
questions they actually arrive with - what ran recently, and did anything
finish that I have not looked at yet - without reading the whole table.

There is also no notion of having seen a Session. A Session that finished four
hours ago and a Session the operator read twice look identical, so the only way
to find newly finished work is to remember what the list looked like last time.

On the detail page, the Stream card renders one card per normalized item in
arrival order. A rich Session mixes a few hundred words of agent prose into
dozens of tool cards, and the noisy Runner and provider events sit under a
separate Debug events section that routinely holds 150 or more rows. Every tool
call is its own bordered card of the same size as a paragraph of prose, so the
page reads as tool traffic with prose scattered through it - the inverse of what
the operator came for. A single large tool result can also occupy the whole
viewport: the byte cap is 8 000 characters, which is many screens of output, and
nothing bounds the number of lines a collapsed-then-expanded result contributes
to page height.

None of this is a data problem. Every fact the operator needs is already
fetched by `GET /sessions` and `GET /runs/:runId/events`; the presentation
spends it badly.

## Solution

The Sessions list becomes a grouped, scannable list instead of a table, and the
Session detail page renders a projection of the event stream instead of a
transcript of it.

On the list, a row is three things: a status dot, a title (the Task name, with
the Agent as secondary text), and a relative time. Duration, Runner, Result and
the absolute timestamps move into a hover card on the row title, so they are one
pointer or one keyboard focus away instead of four columns wide. Rows are
grouped by calendar day under a Today / Yesterday / date heading, and each group
shows its five newest Sessions with an expand control for the rest. A Session
that finished since the operator last opened it carries a green dot at the
trailing edge of its row, tracked in browser storage and cleared when the
Session is opened. Two filters - by Agent and by status - sit beside the
existing Refresh.

On the detail page, a projection layer sits between the raw Session events and
the renderer. It reduces the stream to four node kinds - operator input,
assistant text, tool-call group, system marker - and does all merging and
dropping of heartbeat and internal noise once, at projection time, rather than
in per-row render conditionals. Consecutive tool calls collapse into a single
group node whose entries each render as one line: an icon, a one-line summary,
and for a failed call the first line of the error in the destructive colour.
Clicking a line expands its arguments and result. Long outputs are capped by
line count as well as by the existing byte cap, inside a scroll container, so
one enormous tool result cannot own the page. Debug events keeps its existing
collapsed section, untouched.

The result: with a hundred Sessions loaded the list is scannable at a glance and
broken into days, and a Session with thirty or more stream items opens as
readable prose with every tool call collapsed.

## User Stories

1. As an operator opening Sessions, I want each row to lead with what ran rather than when it started, so that I can scan the list by meaning instead of by timestamp.
2. As an operator, I want a Session row to show the Task name as its title, so that I recognise the work without reading a column of ids.
3. As an operator, I want the Agent title as secondary text under the row title, so that I can tell two Sessions on the same Task apart.
4. As an operator, I want a Session that belongs to a Goal rather than a Task to show the Goal title as its row title, so that Goal-driven Sessions are not left blank.
5. As an operator, I want a Session with neither a Task nor a Goal to fall back to its identifier, so that no row is unidentifiable.
6. As an operator, I want a coloured status dot at the head of each row, so that lifecycle state is readable without reading a word.
7. As an operator, I want the status dot to use the same tone vocabulary as the existing Session pill, so that the list and the detail page never disagree about what green means.
8. As an operator, I want a relative time on each row, so that recency is legible without arithmetic.
9. As an operator, I want a Session older than a month to fall back to an absolute date, so that relative time never becomes meaningless.
10. As an operator, I want to hover the row title and see Duration, Runner, Result, the absolute start time and the run number, so that the details I need occasionally do not cost me four columns permanently.
11. As a keyboard operator, I want the same detail card to open when I focus the row title, so that the information is not pointer-only.
12. As an operator, I want a failed Session to show its failure reason in the hover card, so that I can triage without opening the Session.
13. As an operator, I want a Session whose wall-clock includes Inbox wait to say so in the hover card, so that a long duration is not mistaken for a slow Agent.
14. As an operator, I want clicking anywhere on a row to open that Session, so that the whole row is the target.
15. As an operator, I want clicking the Task or Goal link inside a row to open that Task or Goal instead of the Session, so that the nested link keeps its meaning.
16. As an operator, I want rows grouped under a calendar day heading, so that the list has structure instead of running together.
17. As an operator, I want today's group labelled Today and yesterday's labelled Yesterday, so that the two groups I look at most need no decoding.
18. As an operator, I want each day heading to show how many Sessions ran that day, so that I can judge a day's volume without expanding it.
19. As an operator, I want each day group to show only its five newest Sessions by default, so that one busy day cannot bury every other day below the fold.
20. As an operator, I want an expand control naming how many more Sessions that day holds, so that I know what I am not being shown.
21. As an operator, I want to collapse an expanded day again, so that expanding is not a one-way door.
22. As an operator, I want the newest day at the top and the newest Session at the top of each day, so that ordering is the same everywhere.
23. As an operator, I want to filter the list by Agent, so that I can look at one Agent's work alone.
24. As an operator, I want the Agent filter to offer only Agents that actually appear in the loaded Sessions, so that I am never offered a filter that returns nothing.
25. As an operator, I want to filter the list by status, so that I can see only what is live, or only what failed.
26. As an operator, I want filters to apply before grouping and before the five-row cap, so that a filtered day shows the five newest matching Sessions rather than the five newest of any kind.
27. As an operator, I want to be told that filters apply to the Sessions already loaded, so that I do not read an empty filtered list as an empty history.
28. As an operator, I want the existing Refresh to keep working with filters applied, so that the control I already know does not change meaning.
29. As an operator, I want Load more to keep working with filters applied, so that filtering does not strand me on page one.
30. As an operator, I want a green dot on a Session that finished since I last opened it, so that newly completed work finds me instead of me hunting for it.
31. As an operator, I want that dot to clear when I open the Session, so that the indicator tracks what I have actually read.
32. As an operator, I want a Session that finishes while I am watching its detail page to count as seen, so that it does not reappear as unread the moment I go back.
33. As an operator, I want the unseen dot to sit apart from the status dot, so that I never confuse completed-but-unread with succeeded.
34. As an operator, I want the unseen state kept in my own browser, so that the feature costs no schema change and no server round trip.
35. As an operator on a fresh browser, I want Sessions that finished before my first visit to count as already seen, so that the feature does not open with a wall of dots.
36. As an operator using two browsers, I want each to track its own seen state without error, so that the feature degrades to per-browser memory rather than failing.
37. As an operator whose browser blocks storage, I want the list to keep working without the indicator, so that a storage failure never breaks the page.
38. As an operator opening a Session, I want the stream to read as prose with tool calls folded away, so that I can follow what the Agent actually did.
39. As an operator, I want every tool call collapsed on arrival, so that no Session opens as a wall of arguments.
40. As an operator, I want consecutive tool calls presented as one group, so that ten calls cost one block of page rather than ten cards.
41. As an operator, I want each collapsed tool call on one line with an icon and a one-line summary, so that I can skim what the Agent touched.
42. As an operator, I want a failed tool call to show the first line of its error in the error colour, so that a failure is visible while collapsed.
43. As an operator, I want to click a collapsed tool line and see its arguments and result, so that detail is available on demand.
44. As an operator, I want an expanded result capped by line count inside a scrolling box, so that one huge output cannot dominate the page.
45. As an operator, I want a capped output to say how much was withheld, so that truncation is never silent.
46. As an operator, I want consecutive assistant messages merged into one block of prose, so that streaming boundaries do not fragment a paragraph into cards.
47. As an operator, I want empty and whitespace-only assistant output to produce nothing, so that the stream has no blank cards.
48. As an operator, I want the final result to render once, not twice, when it repeats the last assistant message, so that a Session does not end by saying the same thing twice.
49. As an operator, I want provider and Runner heartbeat traffic dropped from the stream, so that the readable view stays readable.
50. As an operator, I want dropped noise still available in the existing Debug events section, so that nothing is lost, only relocated.
51. As an operator, I want an adapter error rendered as a system marker in stream order, so that I can see where in the Session it went wrong.
52. As an operator, I want a resumed Session to show a marker where it resumed, so that a gap in the transcript has an explanation.
53. As an operator whose Runner echoes operator input into the stream, I want that input rendered as its own node kind, so that I can tell what I said from what the Agent said.
54. As an operator, I want the stat bar counts to be derived from what is rendered, so that the header can never claim more messages or tool calls than the stream shows.
55. As an operator on a live Session, I want the stream to keep auto-scrolling and to keep offering the new-items control, so that the rework does not cost me live behaviour I have today.
56. As an operator on a Session with more events than the client will render, I want the existing cap notice to remain, so that I still know the view is partial.
57. As an operator, I want Files touched and Debug events to behave exactly as they do today, so that the rework has a boundary I can trust.
58. As a Chinese-locale operator, I want every new label translated, so that the rework does not reintroduce English into a translated page.
59. As an operator, I want the page to keep using the product's design tokens, so that the rework holds in both themes.
60. As a developer, I want the projection expressed as one pure function over events, so that stream behaviour is testable without a DOM.
61. As a developer, I want the list's filtering, grouping and seen-state logic in one pure module, so that list behaviour is testable without a DOM.
62. As a developer, I want the retired seven-column table removed rather than left behind a flag, so that the page has one rendering path.

## Implementation Decisions

### Scope of change

- Two application surfaces change: the Sessions list and the Session detail
  page, both in the web app's `Sessions` page module.
- One existing pure module changes: the Session stream normalizer in the web
  app's lib layer gains the projection pass.
- One new pure module is added to the web app's lib layer for the list's
  filtering, grouping and seen-state logic.
- Nothing in the API, DB, Runner or Inbox packages changes. `GET /sessions`
  and `GET /runs/:runId/events` are consumed exactly as they are today.

### List: row shape

- L1. A Session row renders, in order: a status dot, a title block, a trailing
  unseen dot when applicable, and a relative time. The row is a single
  navigation target to the Session detail route.
- L2. The status dot reuses the existing dot element and tone map, and takes its
  tone from the existing Session pill projection, so the merge-outcome override
  the pill already applies is inherited rather than re-derived.
- L3. The title is the Task name, else the Goal title, else the Session id. The
  Task and Goal titles remain links to their own routes, and the row's own
  click handler continues to yield to a nested link that has already handled the
  event.
- L4. Secondary text under the title is the Agent title, falling back to the
  Agent id. The existing Agent chip is not used in a row: it is a bordered
  element and the row is deliberately unbordered.
- L5. The relative time uses the existing relative-time formatter over
  `startedAt ?? requestedAt` - the same timestamp the current Started column
  uses - so a queued Session that never started still shows a time.
- L6. The seven-column table is retired. The list renders as a plain list inside
  the existing flush card. The table primitives are removed from the page's
  imports; no compatibility path is kept.

### List: hover card

- L7. The hover card uses the repository's existing hover-card primitives, with
  open and close delays set at the call site, matching the sidebar Runner
  popover that is the only current consumer.
- L8. The trigger is the row's title element. It is focusable, so the card opens
  on keyboard focus as well as pointer hover; the primitive already does both.
- L9. Card contents: Started (absolute, existing date-time formatter), Duration
  (existing duration formatter including its Inbox-wait wording), Runner, Result
  (the existing in-progress / success / failed word), run number, and the
  failure reason compacted to a bounded length when one is present.
- L10. The hover card carries no interactive controls. Opening the Session
  remains the row's job.

### List: grouping and expansion

- L11. Grouping is by local calendar day of the row's own timestamp
  (`startedAt ?? requestedAt`), computed in the new pure list module. Groups are
  ordered newest first; rows inside a group keep the existing newest-first
  order.
- L12. Group headings read Today, Yesterday, or the absolute date via the
  existing date formatter, plus the number of Sessions in that group. The
  Today / Yesterday decision is made against the current local date at render
  time, not cached.
- L13. A group shows its five newest rows. When it holds more, an expand control
  states the remaining count; expanding shows the whole group and offers a
  collapse. Expansion is component state keyed by day, not persisted, and reset
  when the Project scope changes.
- L14. Grouping is applied after filtering, so the cap counts matching rows only.

### List: filters

- L15. Two filters sit in the page header actions row beside the existing
  Refresh: Agent and status. Both use the repository's existing native select
  component - the Agent list is unbounded, which rules out the segmented control
  - and both default to All.
- L16. Agent options are derived from the loaded Sessions: distinct Agent id with
  the Agent title as label, sorted by label, plus an All option.
- L17. Status options are the four lifecycle buckets the product already speaks:
  Live (the existing live-status set), Done (SUCCEEDED), Failed (FAILED,
  TIMED_OUT, LOST) and Cancelled (CANCELLED), plus All. The bucket predicates
  live in the new pure list module and reuse the page's existing live-status
  helper. This is assumption A2.
- L18. Filtering is client-side over the Sessions already loaded. `GET /sessions`
  takes no Agent or status parameter and none is added. When either filter is
  not All, the page shows a one-line hint that filters apply to loaded Sessions;
  Load more and Refresh keep working unchanged. This is assumption A3.
- L19. Filter state is component state, reset when the Project scope changes. It
  is not persisted.
- L20. When filters exclude every loaded Session, the list shows the existing
  empty state with a filtered wording, not the no-Sessions-yet wording.

### List: completed-but-unseen indicator

- L21. Seen state is owned by the new pure list module and stored through the
  existing storage wrapper, which already degrades to in-memory when the browser
  blocks local storage.
- L22. One record per Project, keyed `agentos.sessions.seen.<projectId>`,
  matching the existing per-Project key convention used by the board. The value
  is a JSON object with a `since` baseline timestamp and an `opened` map from
  Session id to the timestamp the operator last opened it.
- L23. `since` is written when the record is first created for a Project. A
  terminal Session that finished at or before `since` counts as seen. This is
  what prevents the feature from opening with a dot on every historical Session.
  This is assumption A4.
- L24. A Session's finish stamp is `endedAt ?? startedAt ?? requestedAt`, so a
  terminal Session whose `endedAt` was never written (a LOST Session) still
  resolves to a real timestamp rather than being permanently unseen.
- L25. Unseen means: the Session is not live, and its finish stamp is later than
  `opened[id]`, or later than `since` when the Session has never been opened.
  A live Session is never marked unseen; the indicator is about completion.
- L26. The Session detail page marks the Session opened on mount, and marks it
  again when the open Session transitions to a terminal status, so a Session
  that finishes while the operator watches it does not come back as unread.
- L27. On write, the `opened` map is pruned to its 500 newest entries, so the
  record cannot grow without bound.
- L28. A record that fails to parse is treated as absent and replaced. This is
  the only silent recovery in the feature and it is bounded to a JSON parse
  failure of a local cache; every other storage failure is already handled by
  the storage wrapper.
- L29. The list reads the record once per mount into component state. Navigating
  to a Session unmounts the list, so returning to it re-reads the record and the
  dot clears without any cross-component signalling.
- L30. The unseen dot renders at the trailing edge of the row, adjacent to the
  relative time, and the row title renders bold while unseen. It is deliberately
  not adjacent to the status dot, which is also green for a succeeded Session.
  This is assumption A5.

### Detail: the projection layer

- D1. The existing stream normalizer keeps its job - mapping raw Session events
  to items using per-Runner payload knowledge proved against captured CLI
  output - and the module gains a projection pass on top of it. The page imports
  only the projection entry point; the normalizer stays exported because it is
  the payload-mapping contract its own tests assert.
- D2. The projection is a pure function of (events, Runner, terminal) returning
  nodes, the files-touched list and the counts. It performs no rendering and
  touches no React state.
- D3. There are exactly four node kinds. Expressed as the type shape the module
  exports:

  ```
  type StreamNode =
    | { kind: 'input';  id: string; at: string; text: string }
    | { kind: 'text';   id: string; at: string; text: string; final: boolean }
    | { kind: 'tools';  id: string; at: string; calls: ToolCall[] }
    | { kind: 'marker'; id: string; at: string; variant: 'info' | 'error'; text: string }
  ```

  `final` is a flag on a text node rather than a fifth kind: the final result is
  assistant prose that renders under a different heading, not a different thing.
  `ToolCall` is the existing tool item shape (name, one-line summary, file path,
  arguments, result, state, timestamp) unchanged.
- D4. `input` nodes carry operator-authored or user-authored text that the
  provider echoed into the stream. On today's Runners only PI does this, through
  a completed message whose role is user; CLAUDE and CODEX never echo the resume
  input, and those Sessions get the resume marker of D6 instead. The kind exists
  because the projection is the single place that decides node kind; it is not a
  render-time conditional. This is assumption A6.
- D5. `tools` nodes group a maximal run of consecutive tool calls into one node.
  Any input, text or marker node between two tool calls closes the group. A
  group's timestamp is its first call's timestamp.
- D6. `marker` nodes come from two sources. Error markers come from adapter
  errors and from prompt-delivery failures. Info markers come from the second
  and subsequent process-start events in one Session's stream: the first is the
  Session starting, which the page header already states, and every later one is
  a resume boundary.
- D7. Merging and dropping happen only here:
  - consecutive `text` items with nothing between them merge into one node,
    joined by a blank line, carrying the earliest timestamp;
  - empty and whitespace-only text produces no node;
  - a final-output node whose text equals the text of the immediately preceding
    text node is dropped rather than repeated - this is the CODEX case, where
    the final output is the last agent message;
  - tool-progress heartbeats, provider status, model-started, raw provider
    events and Runner stderr continue to produce no node, exactly as the
    normalizer already drops them.
  No render path may re-implement any of these rules with a conditional.
- D8. Counts are computed from the nodes, not from the events: messages is the
  number of text nodes, tool calls is the sum of the group entry counts, files
  is the files list length. The existing invariant - the stat bar cannot
  disagree with the stream - is preserved by construction.
- D9. The projection is memoised on the same keys as today (event count, Runner,
  terminal), so an empty poll does not re-project a long Session.

### Detail: rendering

- D10. A `text` node renders in the existing message card, with the existing
  Agent or Result heading and the existing markdown renderer, clamped by the
  existing show-more control at a line limit.
- D11. An `input` node renders in the same card with an operator heading and the
  same clamp, so operator input and agent prose are visually siblings, not
  strangers.
- D12. A `tools` node renders as one card holding one line per call. A line is a
  button showing: a tool-kind icon, the tool name, and the existing one-line
  summary. State is shown by tone, as today. When a call failed, the line shows
  the first line of its result in the destructive colour in place of the
  summary. Every line is collapsed on arrival, always - there is no auto-expand
  rule.
- D13. Clicking a line expands its arguments and result inline beneath it, using
  the existing code block, which already scrolls at a max height. Expansion is
  per line and is component state.
- D14. Tool-kind icons come from a small map over the existing hand-authored
  icon module, covering read, edit, search, run, web and a default. No icon
  dependency is introduced.
- D15. A `marker` node renders as a single muted line; the error variant reuses
  the existing error notice component.
- D16. Output caps. A pure line-clamp helper in the stream module returns the
  clamped text and the number of lines dropped; it is applied to a tool call's
  arguments and result before they reach the code block. The existing
  8 000-character block truncation stays as the byte backstop, and the code
  block keeps its scrolling max height. Text nodes keep the show-more line
  clamp. Concretely: tool arguments and results clamp at 40 lines, text nodes
  clamp at 12 lines before show-more. Both limits are named constants in the
  module that owns them.
- D17. The stream container keeps everything it has today: the scroll box, the
  drain-versus-news priming, the auto-scroll-when-at-bottom rule, the new-items
  control and the event-cap notice. The new-items counter now counts nodes; the
  existing guard that ignores a non-positive delta already covers a merge that
  shrinks the count.
- D18. Files touched and Debug events are untouched, including the Debug filter
  and its counts. Debug events remains the place every dropped event is still
  visible.

### Cross-cutting

- X1. All new copy goes through the existing translation helpers, with matching
  keys added to both locale dictionaries. The repository's parity and sweep
  tests already fail a missing key, an untranslated value or a placeholder
  mismatch.
- X2. Only design tokens are used. The existing test that forbids a hard-coded
  hex colour in the Sessions page module stays green.
- X3. No new component file is created for the list or the detail: both stay in
  the Sessions page module, which keeps the component seam to one module, as it
  is today. Shared primitives are added to the existing UI module only if a
  second page would use them - none is expected.
- X4. Removed code is deleted, not deprecated: the table imports, the row's
  duration and result cells, and the per-item render conditionals the projection
  replaces.

### Assumptions

- A1. The brief's list and detail scopes are complete; nothing else on the
  Sessions surface is in scope. The simplest reading of each numbered item in
  the brief is the one specified here.
- A2. Status filtering means the four lifecycle buckets (Live, Done, Failed,
  Cancelled), not the nine raw execution statuses. The buckets are the
  vocabulary the detail page's lifecycle stat already speaks.
- A3. Filters are client-side over loaded Sessions. The brief forbids a schema
  change and does not ask for an API change, and adding query parameters to
  `GET /sessions` would be scope the brief did not request.
- A4. A baseline timestamp makes pre-existing Sessions count as seen. Without
  it, shipping the feature marks every historical completed Session unread,
  which is the opposite of the brief's intent.
- A5. The unseen dot sits at the trailing edge of the row rather than beside the
  status dot, because a green status dot and a green unseen dot adjacent to each
  other are not distinguishable.
- A6. The operator-input node kind is specified with the producers that exist
  today (PI user-role messages) and will simply not occur for CLAUDE and CODEX
  Sessions. The brief names four node kinds; the projection declares all four.
- A7. Line caps of 40 (tool arguments and results) and 12 (text nodes before
  show-more) are chosen as readable defaults, not derived from a measurement.
  They are single named constants and cheap to retune.

None of these assumptions changes the objective, scope, acceptance criteria,
evidence, authority or risk boundary recorded in the Product Contract, so none
was escalated to the Inbox.

## Testing Decisions

### What a good test is here

A good test asserts what an operator can observe: the nodes a projection
returns for a given event sequence, the rows and groups a list function returns
for a given set of Sessions, and the markup or behaviour a component produces.
It never asserts a class name, an internal helper's signature, the number of
renders, or the order of state updates. Tests are driven by data the product
really produces - event fixtures pasted from captured CLI output, Session
fixtures built from the shared factory - not by shapes invented to suit the
assertion.

### Seams under test

Three seams, two of which already exist. No other seam is introduced.

1. **The projection function in the Session stream module (existing seam,
   highest available).** A pure function from raw Session events to nodes,
   counts and files, with no React and no network. Every merge, drop, group and
   cap rule in the Implementation Decisions is observable here. This is the seam
   the brief's new projection-layer tests attach to.
2. **The new pure list module (new seam, added at the highest point).** Filter
   predicates, Agent option derivation, day grouping, and the seen-state store.
   Proposed here rather than inside the page component because the same rules
   are otherwise only observable through rendered markup, which would make the
   list's behaviour a DOM test.
3. **The Sessions page module's exported components (existing seam).** Rendered
   with static markup for shape, and with the existing jsdom plus React root
   harness for interaction. Used only for what is genuinely a rendering or
   interaction question: the row's click target, the hover card's contents, the
   group expand control, the collapsed-by-default tool line, and the page-level
   pagination and drain behaviour that is already tested here.

Nothing else is exported to be tested. In particular the seen-state store is
reached through the list module, not through a separate storage wrapper, and
the tool-kind icon map is not tested directly - a rendered tool line covers it.

### Modules under test

- The Session stream module: the projection function, the line-clamp helper, and
  the existing normalizer, whose current tests stay as they are.
- The new list module: filtering, Agent options, grouping, and seen state.
- The Sessions page module: the Session row, the grouped list, the stream node
  view, the tool group, and the two page components.

### Prior art

- Pure stream tests: the existing Session stream test file, whose fixtures are
  pasted from real CLI stdout captures and which is the model for the new
  projection cases.
- Pure list-logic tests with a storage dependency: the existing storage test
  file, which exercises the degrade paths, and the existing board test file,
  which is the model for per-Project storage key helpers.
- Component and interaction tests: the existing Sessions test file, which
  already contains the static-markup pattern, the jsdom harness, the click
  helper, the Session and event factories, and page-level tests that stub
  fetch and drive Load more, Refresh and the event drain.
- New test files are discovered automatically: the web test script globs the
  whole source tree, and an existing test proves that discovery.

### Cases the work must cover

At seam 1 (projection):

- a run of consecutive tool calls becomes exactly one group node, and an
  intervening assistant message splits it into two;
- consecutive assistant messages merge into one text node with the earliest
  timestamp;
- empty and whitespace-only assistant output produces no node;
- a final output that repeats the preceding assistant text produces one node,
  not two, while a final output with distinct text produces its own;
- an adapter error becomes an error marker in stream order;
- a second process-start event becomes an info marker and the first does not;
- a PI user-role message becomes an input node;
- heartbeat, provider-status and raw provider events produce no node;
- counts equal what the nodes contain, for a mixed stream;
- the line clamp returns the first N lines and reports the number dropped, and
  returns the text unchanged when it is short.

At seam 2 (list module):

- grouping splits Sessions across local calendar days and orders groups and rows
  newest first;
- a queued Session with no start time groups by its requested time;
- the Agent filter offers exactly the Agents present, sorted, and filters to
  them;
- each status bucket selects exactly the execution statuses it names;
- unseen is false for a live Session, false for a Session finished before the
  baseline, true for a terminal Session finished after the baseline and never
  opened, and true again for a Session opened before it finished;
- marking opened clears unseen for that Session and nothing else;
- the opened map prunes to its bound;
- an unparseable stored record is treated as absent and does not throw.

At seam 3 (components):

- a row renders title, Agent secondary text, status dot and relative time, and
  does not render Duration, Runner or Result;
- the hover card content carries Started, Duration, Runner, Result and run
  number, including the Inbox-wait wording where it applies;
- clicking a row opens the Session, and clicking the nested Task link opens the
  Task - the existing assertions, re-pointed at the new row markup;
- a day group renders five rows with an expand control naming the remainder, and
  expanding renders the rest;
- a tool group renders one line per call, collapsed, with no arguments or result
  in the markup, and expands one line on click;
- a failed tool line shows its first error line;
- the existing page-level tests - Load more dedup, failed Load more surfacing,
  and the initial drain not being called news - keep passing against the new
  list and stream rendering.

### Tests that change

The existing Sessions tests that encode the retired seven-column table are
rewritten against the new row, not deleted. Every behaviour they protect must
still be asserted somewhere: the row click target, the nested Task link taking
precedence, and the Inbox-wait duration wording (which moves from the row to the
hover card). Deleting an assertion because its markup moved is not acceptable.

### Suite-level guards that must stay green

Locale parity and the untranslated-copy sweep; the placeholder-parity check
between dictionaries; the no-hard-coded-colour check on the Sessions page
module; the built-stylesheet regression tests, which require the web app to be
built before the test run; type checking and both lint passes.

## Out of Scope

The brief's stated non-goals, restated as boundaries:

- drag-to-sort or any reordering of the list;
- a DevTools-style timeline or waterfall view of a Session;
- model-generated Session titles or summaries;
- any database schema change, including any table or column for seen state.

Additionally out of scope for this specification:

- any change to `GET /sessions` or `GET /runs/:runId/events`, including adding
  Agent, status, or sort parameters, or server-side grouping;
- any change to the event polling contract: page size, the render ceiling, the
  backoff curve and the terminal stop rule are unchanged;
- any change to the Debug events section or the Files touched section beyond
  leaving them where they are;
- list virtualisation or windowing; the five-row group cap plus the existing
  page size is the readability mechanism;
- persisting filter selections or group expansion across visits;
- cross-device or cross-browser synchronisation of seen state;
- exporting, copying or sharing a projected stream;
- any change to other pages that show Sessions, including the Task detail page
  and the board;
- porting any DeepSeek Harness code, component library, or architecture. The
  reference contributes patterns only.

## Further Notes

- The decision record named in the brief is not tracked in this repository:
  frozen records live in the private operator repository. The brief's
  distillation of the Sessions card is what this spec was written against, and
  a plan step should not go looking for the record here.
- The event vocabulary the projection consumes is fixed by the Runner adapters
  and is small: model started, model delta, model completed, tool started, tool
  progress, tool completed, final output, provider status, adapter error, plus
  the Runner's own process started, stderr, raw provider and prompt-delivery
  failure. The projection must keep tolerating an unknown type by producing no
  node, exactly as the normalizer does today.
- Every payload access in the stream module is already defensively guarded, and
  the projection must hold that line: a payload that is null, a number, a string
  or an array contributes nothing and nothing throws. This is not a swallowed
  error - a malformed provider payload is expected input, not a failure.
- Two risks worth naming for the plan step. First, the hover card trigger sits
  inside a row that is itself a click target; the trigger must not swallow the
  row's click, and the existing rule that a nested link wins must survive.
  Second, jsdom has no layout, so hover-card tests should drive focus rather
  than pointer geometry, and portal-rendered content is queried from the
  document rather than from the render container - the existing stream test that
  stubs scroll metrics is the precedent for working around the same gap.
- The list's five-row group cap interacts with the existing fifty-row page size:
  a hundred loaded Sessions across several days will show a small number of rows
  until groups are expanded. That is the intent, and the group counts and expand
  labels are what keep it honest rather than hiding rows.
- Performance is not expected to need attention: a hundred Sessions and twenty
  thousand events are both already handled, and the projection adds one linear
  pass over items that are already computed once and memoised.
