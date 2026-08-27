---
id: 06-output-caps
title: Line caps so one huge output cannot own the page
blocked_by:
  - 04-stream-projection-tool-groups
risk: false
---

# 06: Line caps so one huge output cannot own the page

**What to build:** No single output can dominate a Session page. A pure
line-clamp helper in the Session stream module returns the clamped text and
the number of lines dropped; it is applied to a tool call's arguments and
result before they reach the code block, which keeps its scrolling max height,
and the truncation is never silent — capped output says how much was withheld.
Tool arguments and results clamp at 40 lines and text nodes clamp at 12 lines
before the existing show-more control; both limits are single named constants
in the module that owns them. (Spec: D16; stories 44-45; assumption A7.)

**Blocked by:** 04-stream-projection-tool-groups.

**Boundaries this slice preserves rather than proves:** the existing
8 000-character block truncation stays as the byte backstop and the code
block keeps its scrolling max height; both are unchanged behaviour covered by
chain-level regression, not by this slice's acceptance.

- [ ] The pure clamp helper returns the first N lines plus the count of lines
  dropped, and returns short text unchanged with zero dropped — pure unit
  tests.
- [ ] An expanded tool call's arguments and result are clamped at the named
  40-line constant inside the scrolling code block, with visible wording
  stating how many lines were withheld — component test with an oversized
  fixture result.
- [ ] A single oversized line still hits the byte backstop after clamping, so
  the two caps compose rather than one defeating the other — component test
  with a one-line fixture longer than the byte cap.
- [ ] Text nodes clamp at the named 12-line constant behind the existing
  show-more control — component test.
- [ ] The withheld-lines wording renders in English and in Chinese, with the
  count substituted correctly in both — component test under each active
  locale using the existing locale-switching test harness.
