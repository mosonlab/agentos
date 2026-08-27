---
id: 05-stream-prose-merges
title: Prose coalescing and final-output deduplication
blocked_by:
  - 04-stream-projection-tool-groups
risk: false
---

# 05: Prose coalescing and final-output deduplication

**What to build:** The projected stream reads as continuous prose instead of
fragments. Consecutive assistant messages with nothing between them merge into
one text node joined by a blank line and carrying the earliest timestamp;
empty and whitespace-only assistant output produces no node at all, so the
stream has no blank cards; and a final output whose text equals the
immediately preceding text node is dropped rather than repeated (the CODEX
case, where the final output is the last agent message), while a final output
with distinct text keeps its own node. All of this happens at projection time
— no render path re-implements any of these rules with a conditional.
(Spec: D7 merge and dedup rules; stories 46-48.)

**Blocked by:** 04-stream-projection-tool-groups.

**Boundaries this slice preserves rather than proves:** this slice adds
projection rules only. It introduces no copy, no new node kind and no
renderer; the stat bar's derive-from-nodes invariant established in slice 04
continues to hold because merging shrinks the text-node count that feeds it.

- [ ] Consecutive assistant messages with nothing between them merge into one
  text node joined by a blank line, carrying the earliest timestamp — pure
  projection test.
- [ ] A tool call, marker or input between two assistant messages prevents the
  merge, leaving two text nodes — pure projection test.
- [ ] Empty and whitespace-only assistant output produces no node — pure test.
- [ ] A final output repeating the preceding assistant text produces one node,
  not two; a final output with distinct text produces its own node — pure
  tests.
- [ ] The message count reported to the stat bar equals the text-node count
  after merging and dropping, on a mixed stream where merging reduces it —
  pure test.
