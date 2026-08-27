---
id: 04-stream-projection-tool-groups
title: Stream projection layer with collapsed tool-call groups
blocked_by: []
risk: false
---

# 04: Stream projection layer with collapsed tool-call groups

**What to build:** Opening a Session detail page renders a projection of the
event stream instead of a transcript. A projection pass in the Session stream
module — a pure function of (events, Runner, terminal) on top of the existing
normalizer, which keeps its job and its tests — returns typed nodes, the
files-touched list and the counts. A maximal run of consecutive tool calls
becomes one group node rendered as a single card holding one line per call:
a tool-kind icon (from a small map over the existing hand-authored icon
module, covering read, edit, search, run, web and a default), the tool name,
and the existing one-line summary, with state shown by tone. Every line is
collapsed on arrival, always; when a call failed, its line shows the first
line of its result in the destructive colour in place of the summary. Clicking
a line expands its arguments and result inline beneath it in the existing code
block. Text and final-output nodes render in the existing message card under
the existing Agent or Result heading. Counts derive from the nodes, the
projection is memoised on the same keys as today, and the stream container
keeps its scroll box, drain priming, auto-scroll rule, new-items control (now
counting nodes) and event-cap notice. (Spec: D1-D3, D5, D7 drop rules, D8-D10,
D12-D14, D17; stories 38-43, 49-50, 54-57, 60.)

**Blocked by:** None (can start immediately).

**Boundaries this slice preserves rather than proves:** Files touched and Debug
events, including the Debug filter and its counts, are untouched — Debug
events remains where every dropped event is still visible. The event polling
contract (page size, render ceiling, backoff, terminal stop) and the existing
normalizer and its tests are unchanged. That non-change is chain-level
regression evidence, not slice acceptance. The per-item render conditionals
the projection replaces are deleted in this slice, not deprecated.

The node vocabulary is fixed by the spec (decision-bearing type shape, from
the specification of record, not a working demo):

```
type StreamNode =
  | { kind: 'input';  id: string; at: string; text: string }
  | { kind: 'text';   id: string; at: string; text: string; final: boolean }
  | { kind: 'tools';  id: string; at: string; calls: ToolCall[] }
  | { kind: 'marker'; id: string; at: string; variant: 'info' | 'error'; text: string }
```

`final` is a flag, not a fifth kind; `ToolCall` is the existing tool item
shape unchanged. This slice declares all four kinds and produces `text` and
`tools`; the `marker` producers land in slice 08 and the `input` producer in
slice 09 — the kinds exist now so the page renders nodes from day one and
those slices add producers, not a new vocabulary.

- [ ] The projection is a pure function from raw Session events to nodes,
  files and counts, with no React and no network; a run of consecutive tool
  calls becomes exactly one group node whose timestamp is its first call's,
  and an intervening assistant message splits it into two groups — pure tests
  on event fixtures in the Session stream test file's captured-output style.
- [ ] Counts equal what the nodes contain for a mixed stream: messages is the
  number of text nodes, tool calls the sum of group entry counts, files the
  files list length — pure test.
- [ ] Heartbeat, provider-status, model-started, raw provider and Runner stderr
  events produce no node, an unknown event type produces no node, and a
  malformed payload (null, number, string, array) contributes nothing and
  nothing throws — pure tests holding the normalizer's defensive line through
  the new projection.
- [ ] A tools node renders one card with one line per call — icon, tool name,
  one-line summary, state tone — collapsed, with no arguments or result
  present in the markup; clicking a line expands that line's arguments and
  result inline and no other's — jsdom interaction test.
- [ ] A failed call's line shows the first line of its result in the
  destructive colour in place of the summary — component test.
- [ ] Text and final-output nodes render in the existing message card under the
  Agent and Result headings respectively — component test on the node renderer.
- [ ] The stream container's live behaviour is proved by new page-level tests
  in the Sessions page test file rather than assumed, run against a web app
  built first so the stylesheet regression guards resolve. The red anchor: with
  the stream scrolled away from the bottom, a batch of consecutive tool events
  arriving raises a new-items control counting projected nodes — one group, not
  one per raw item — and activating it returns the view to the newest node. The
  same tests also cover, in the same file, auto-scroll after priming when the
  view is already at the bottom and the visible cap notice on a capped stream;
  those two behaviours exist at the frozen base and are written here as the
  regression net that proves the rewrite kept them.
- [ ] The tool-line and node-renderer copy this slice introduces renders in
  English and in Chinese — component test under each active locale using the
  existing locale-switching test harness.
