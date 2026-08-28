---
id: 06-board-non-interaction
title: Board card moves never touch the Chain hold
blocked_by:
  - 01-chain-control-authority-and-hold
risk: false
---

# 06: Board card moves never touch the Chain hold

**What to build:** Dragging a Task card on the board keeps meaning exactly one
thing — a status change on that one Task — and the two states 'parked Step' and
'held Chain' are never confused in either direction. Moving a Step of an unheld
Chain to Backlog writes no ChainControl row; moving a Step of a held Chain
leaves the hold standing, byte-identical; and no board surface (server board
projection, board module, card markers) describes a parked Step as a held Chain
or a held Chain as parked. This slice is mostly assertion, not construction: it
pins the negative space of the feature so a regression that couples the board
to the hold authority fails a named test rather than shipping silently.

**Blocked by:** 01-chain-control-authority-and-hold.

- [ ] A PATCH moving a Chain Step to BACKLOG through the HTTP seam leaves the
      Chain with no ChainControl row (never-held Chain) and an unchanged held
      row (held Chain), and parks only that Step; verified by dbtest through
      `createApp`.
- [ ] The board module's chain-marker and parked labels for a parked Step of a
      held Chain contain no held-Chain wording, and the board's per-card chain
      marker output is unchanged from the frozen base; verified in the existing
      board unit tests (web board module and server board projection).
- [ ] `GET /tasks` and its `chainProgress` marker are byte-identical to the
      frozen base for held and unheld Chains alike; verified by dbtest.
