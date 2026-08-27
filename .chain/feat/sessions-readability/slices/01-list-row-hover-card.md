---
id: 01-list-row-hover-card
title: Slim session rows with a hover card, table retired
blocked_by: []
risk: false
---

# 01: Slim session rows with a hover card, table retired

**What to build:** Opening Sessions shows a plain list of slim rows instead of
the seven-column table. Each row is a coloured status dot, a title — the Task
name, else the Goal title, else the Session id — with the Agent title (falling
back to the Agent id) as secondary text beneath it, and a relative time at the
trailing edge. Hovering or keyboard-focusing the row title opens a hover card
carrying Started (absolute), Duration (with the existing Inbox-wait wording),
Runner, the Result word, the run number, and the failure reason compacted to a
bounded length when one exists; the card holds no controls. Clicking anywhere
on the row opens the Session; clicking the nested Task or Goal link inside the
row still opens that Task or Goal instead. The table and its imports are
deleted — one rendering path, no flag. (Spec: L1-L10, X4; stories 1-15, 62.)

**Blocked by:** None (can start immediately).

- [ ] A row renders the status dot (tone taken from the existing session-pill
  projection so the merge-outcome override is inherited), the title with Agent
  secondary text, and a relative time over `startedAt ?? requestedAt`; it does
  not render Duration, Runner or Result — component test on the new row markup,
  rewritten from the existing table-row assertions.
- [ ] The title falls back Task name, then Goal title, then Session id — one
  component assertion per shape.
- [ ] Focusing the row title opens the hover card containing Started, Duration
  including the Inbox-wait wording, Runner, the Result word, the run number,
  and the compacted failure reason when present — jsdom test driving focus (not
  pointer geometry) and querying portal content from the document; the hover
  card uses the repository's existing hover-card primitives.
- [ ] Clicking a row opens the Session detail route; clicking the nested Task
  link opens the Task — the existing click-precedence assertions re-pointed at
  the new markup, none deleted.
- [ ] The Inbox-wait duration wording, previously asserted on the table row, is
  now asserted inside the hover card — moved assertion, not dropped.
- [ ] The table primitives are no longer imported by the Sessions page module,
  and the existing page-level tests — Load more dedup, failed Load more
  surfacing, initial drain not counted as news — pass against the new list.
- [ ] All new copy is added to both locale dictionaries; locale parity, the
  untranslated-copy sweep, the no-hard-coded-colour check, lint and type
  checking are green.
