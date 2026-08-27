---
id: 03-agent-status-filters
title: Agent and status filters over the loaded list
blocked_by:
  - 01-list-row-hover-card
  - 02-day-grouping
risk: false
---

# 03: Agent and status filters over the loaded list

**What to build:** Two filters sit in the page header beside the existing
Refresh: an Agent select offering only the Agents present in the loaded
Sessions (distinct Agent id, labelled by Agent title, sorted by label) and a
status select offering the four lifecycle buckets — Live, Done, Failed,
Cancelled — both defaulting to All and both using the repository's existing
native select component. Filtering is client-side over the Sessions already
loaded and applies before grouping and before the five-row cap, so a filtered
day shows its five newest matching Sessions and honest counts. When either
filter is not All, a one-line hint says filters apply to loaded Sessions; when
filters exclude everything, the empty state uses a filtered wording, not the
no-Sessions-yet wording. Refresh and Load more keep working unchanged with
filters applied. Filter predicates and Agent-option derivation live in the
pure list module. (Spec: L15-L20; stories 23-29.)

**Blocked by:** 01-list-row-hover-card, 02-day-grouping.

- [ ] Each status bucket selects exactly the execution statuses it names — Live
  is the existing live-status set, Done is SUCCEEDED, Failed is FAILED,
  TIMED_OUT and LOST, Cancelled is CANCELLED — pure unit tests on the bucket
  predicates in the list module.
- [ ] Agent options are exactly the distinct Agents present in the loaded
  Sessions, labelled by title with id fallback, sorted by label, plus All —
  pure unit test.
- [ ] Filtering composes before grouping: with a filter applied, a day group
  contains only matching Sessions, its heading counts matches only, and the
  five-row cap counts matching rows — pure composition test through the list
  module.
- [ ] With a non-All filter the loaded-Sessions hint renders; when filters
  exclude every loaded Session the filtered-empty wording renders instead of
  the no-Sessions-yet wording — component tests.
- [ ] Both filters default to All, are component state, and reset when the
  Project scope changes; the existing page-level Refresh and Load more tests
  pass with a filter applied — component and page tests.
- [ ] New copy in both locale dictionaries; locale parity, sweep,
  no-hard-coded-colour, lint and type checks green.
