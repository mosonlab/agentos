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
counting nodes) and event-cap notice. Files touched and Debug events are
untouched. (Spec: D1-D3, D5, D8-D10, D12-D14, D17-D18; stories 38-45 partial,
54-57, 60.)

**Blocked by:** None (can start immediately).

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
`tools`; the `input` and `marker` producers land in slice 05 — the kinds exist
now so the page renders nodes from day one and slice 05 adds producers, not a
new vocabulary.

- [ ] The projection is a pure function from raw Session events to nodes,
  files and counts, with no React and no network; a run of consecutive tool
  calls becomes exactly one group node whose timestamp is its first call's,
  and an intervening assistant message splits it into two groups — pure tests
  on event fixtures in the Session stream test file's captured-output style.
- [ ] Counts equal what the nodes contain for a mixed stream: messages is the
  number of text nodes, tool calls the sum of group entry counts, files the
  files list length — pure test.
- [ ] A tools node renders one card with one line per call — icon, tool name,
  one-line summary, state tone — collapsed, with no arguments or result
  present in the markup; clicking a line expands that line's arguments and
  result inline and no other's — jsdom interaction test.
- [ ] A failed call's line shows the first line of its result in the
  destructive colour in place of the summary — component test.
- [ ] Text and final nodes render in the existing message card under the Agent
  and Result headings respectively; the per-item render conditionals the
  projection replaces are deleted, and the existing normalizer tests pass
  unchanged.
- [ ] The existing page-level stream tests — drain not counted as news,
  auto-scroll priming, new-items control — pass with the counter counting
  nodes, and the event-cap notice still renders on a capped stream.
- [ ] New copy in both locale dictionaries; locale parity, sweep,
  no-hard-coded-colour, lint and type checks green; no new icon dependency.
