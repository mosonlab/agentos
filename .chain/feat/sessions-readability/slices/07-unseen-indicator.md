---
id: 07-unseen-indicator
title: Completed-but-unseen indicator with client-side seen state
blocked_by:
  - 01-list-row-hover-card
risk: false
---

# 07: Completed-but-unseen indicator with client-side seen state

**What to build:** A Session that finished since the operator last opened it
carries a green dot at the trailing edge of its row, adjacent to the relative
time and deliberately apart from the status dot, with the row title rendered
bold while unseen; the dot clears when the Session is opened. Seen state is
owned by the pure list module and stored through the existing storage wrapper
(which already degrades to in-memory when the browser blocks storage), one
record per Project following the existing per-Project key convention, holding
a baseline timestamp written at first creation and a map from Session id to
last-opened time. A terminal Session finished at or before the baseline counts
as seen, so the feature does not ship as a wall of dots; a live Session is
never unseen; the finish stamp falls back endedAt, startedAt, requestedAt so a
LOST Session still resolves. The detail page marks the Session opened on mount
and again when the watched Session transitions to a terminal status, so a
Session that finishes while the operator watches does not come back as unread.
The list reads the record once per mount; the opened map prunes to its 500
newest entries; an unparseable record is treated as absent and replaced. No
schema change, no server round trip. (Spec: L21-L30; stories 30-37.)

**Blocked by:** 01-list-row-hover-card.

- [ ] The unseen predicate is false for a live Session, false for a terminal
  Session finished at or before the baseline, true for a terminal Session
  finished after the baseline and never opened, and true for a Session opened
  before it finished; the finish stamp is `endedAt ?? startedAt ??
  requestedAt` — pure unit tests in the list module.
- [ ] First creation of a Project's record writes the baseline, so
  pre-existing terminal Sessions count as seen on a fresh browser — pure test.
- [ ] Marking a Session opened clears unseen for that Session and nothing
  else; the opened map prunes to its 500-entry bound on write; an unparseable
  stored record is treated as absent and does not throw — pure tests, modelled
  on the existing storage and board test files.
- [ ] An unseen row renders the trailing green dot beside the relative time —
  not adjacent to the status dot — with a bold title; a seen row renders
  neither — component tests.
- [ ] Opening a Session and returning to the list clears its dot, via the
  detail page marking it opened on mount and the list re-reading the record on
  mount — component and page tests.
- [ ] A Session that transitions to a terminal status while its detail page is
  open is marked opened again and does not reappear unseen — component test
  driving the status transition.
- [ ] With storage blocked, the wrapper's in-memory degrade keeps the list
  rendering without the indicator failing — test over the degrade path.
- [ ] New copy, if any, in both locale dictionaries; locale parity, sweep,
  no-hard-coded-colour, lint and type checks green.
