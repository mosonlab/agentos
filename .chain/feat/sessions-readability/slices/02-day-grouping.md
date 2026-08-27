---
id: 02-day-grouping
title: Calendar-day grouping with capped, expandable groups
blocked_by:
  - 01-list-row-hover-card
risk: false
---

# 02: Calendar-day grouping with capped, expandable groups

**What to build:** The slim rows are grouped under calendar-day headings.
Today's group is labelled Today, yesterday's Yesterday, older groups carry the
absolute date via the existing date formatter, and every heading shows how many
Sessions that day holds. A group shows its five newest rows; when it holds
more, an expand control names the remaining count, expanding shows the whole
group, and a collapse control undoes it. Groups are ordered newest first and
rows inside a group keep the existing newest-first order. The grouping logic
lives in a new pure list module in the web app's lib layer — the seam the rest
of the list work (filters, seen state) will extend. (Spec: L11-L14; stories
16-22, 61.)

**Blocked by:** 01-list-row-hover-card.

**Boundaries this slice preserves rather than proves:** grouping is a
presentation change over the Sessions already loaded — the `GET /sessions`
contract, its page size and the existing Load more are untouched, and that
non-change is chain-level regression evidence.

- [ ] The pure list module groups Sessions by local calendar day of
  `startedAt ?? requestedAt`, orders groups newest first and keeps rows inside
  a group newest first; a queued Session with no start time groups by its
  requested time — pure unit tests, no DOM.
- [ ] Group headings render Today for the current local date, Yesterday for the
  previous one, the formatted absolute date otherwise, each with the day's
  Session count; the Today/Yesterday decision is made against the current
  local date at render time — component test on rendered headings.
- [ ] A day holding more than five Sessions renders exactly its five newest rows
  plus an expand control naming the remaining count; activating it renders the
  full group and offers a collapse that restores the cap — jsdom interaction
  test.
- [ ] Expansion is component state keyed by day and resets when the Project
  scope changes — component test switching the scoped Project.
- [ ] The Today, Yesterday, expand and collapse labels, including the remaining
  count, render in English and in Chinese — component test under each active
  locale using the existing locale-switching test harness.
