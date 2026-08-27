---
id: 07-unseen-indicator
title: Completed-but-unseen indicator with client-side seen state
blocked_by:
  - 01-list-row-hover-card
risk: true
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
newest entries; an unparseable record is treated as absent and replaced.
(Spec: L21-L30; stories 30-37.)

**Blocked by:** 01-list-row-hover-card.

**Risk: true.** This slice writes persisted client data — a per-Project record
in the browser's local storage, through the existing storage wrapper. The
record is disposable and per-browser, and there is still no schema change and
no server round trip, but the write outlives the page and the process, which
is what the risk flag marks. A key-shape or baseline-semantics mistake shipped
here is corrected only by every operator's browser reaching the corrected
code, so the key name and the record shape are decided once, in this slice,
and not revised later in the chain.

**Boundaries this slice preserves rather than proves:** no database schema
change, no new API call, and no cross-device synchronisation. That non-change
is chain-level regression evidence.

- [ ] The unseen predicate is false for a live Session, false for a terminal
  Session finished at or before the baseline, true for a terminal Session
  finished after the baseline and never opened, and true for a Session opened
  before it finished; the finish stamp is `endedAt ?? startedAt ??
  requestedAt` — pure unit tests in the list module.
- [ ] First creation of a Project's record writes the baseline, so
  pre-existing terminal Sessions count as seen on a fresh browser — pure test.
- [ ] The record is written under the existing per-Project key convention and
  two Projects keep independent records — pure test asserting the stored key
  and value shape.
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
- [ ] With the storage wrapper degraded to its in-memory path, seen state still
  works for the life of the page — marking a Session opened clears its dot and
  nothing throws — test over the degrade path.
