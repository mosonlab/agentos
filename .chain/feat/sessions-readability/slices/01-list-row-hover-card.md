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

**Boundaries this slice preserves rather than proves:** the existing
click-precedence assertions (row click opens the Session, nested Task link
wins) and the page-level Load-more, Refresh and drain assertions are
re-pointed at the new row markup, never deleted — they already pass at the
frozen base, so their continued passing is chain-level regression evidence,
not slice acceptance. The API, the polling contract, Debug events and Files
touched are untouched.

- [ ] A row renders the status dot (tone taken from the existing session-pill
  projection so the merge-outcome override is inherited), the title with Agent
  secondary text, and a relative time over `startedAt ?? requestedAt`; it does
  not render Duration, Runner or Result — component test on the new row markup.
- [ ] The title falls back Task name, then Goal title, then Session id — one
  component assertion per shape.
- [ ] Focusing the row title opens the hover card containing Started, Duration,
  Runner, the Result word, the run number, and the compacted failure reason
  when present — jsdom test driving focus (not pointer geometry) and querying
  portal content from the document; the hover card uses the repository's
  existing hover-card primitives.
- [ ] The Inbox-wait duration wording, asserted on the table row at the frozen
  base, is now asserted inside the hover card for a Session whose wall clock
  includes Inbox wait — the assertion moves, it is not dropped.
- [ ] The rendered Sessions list contains no table element and no Started,
  Runner, Duration or Result column headings — component test on the rendered
  list markup.
- [ ] The row's new labels and the hover card's field labels render in English
  and in Chinese — component test rendering the row and card under each active
  locale and asserting the visible strings, using the repository's existing
  locale-switching test harness.
