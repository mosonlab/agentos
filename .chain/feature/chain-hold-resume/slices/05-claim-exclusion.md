---
id: 05-claim-exclusion
title: Claim-time exclusion of held-Chain Runs
blocked_by:
  - 01-chain-control-authority-and-hold
risk: false
---

# 05: Claim-time exclusion of held-Chain Runs

**What to build:** A Run that was already queued for a layer above the held
layer before the Hold landed stays unclaimed while the Chain is held — and
becomes claimable again the moment the hold is released, with no new enqueue.
Both claim lanes enforce it: the ranked raw SQL used by ordinary runners gains
a held-Chain exclusion (a NOT EXISTS against the ChainControl authority,
comparing the candidate Task's execution layer to the held layer), and the
Prisma candidate predicate used by the merge executor gains the mirror
condition. The read is live — the authority row at claim time decides, which is
what lets Resume make a queued Run claimable without resurrecting or recreating
anything. Runs in layers at or below the held layer, and Runs of unheld Chains,
are claimed exactly as at the frozen base, in the same order.

**Blocked by:** 01-chain-control-authority-and-hold.

- [ ] A queued Run above the held layer is not handed out by the runner claim
      route while the Chain is held, while a queued Run of a second, unheld
      Chain in the same poll is; verified by a new dbtest driving the real claim
      route through `createApp`.
- [ ] A queued Run at or below the held layer is claimed normally under the
      hold; verified by dbtest.
- [ ] After the ChainControl row flips to released (seeded directly), the
      previously barred Run is claimed by the next poll with no new Run row
      created; verified by dbtest.
- [ ] The merge-executor claim lane refuses a queued merge-tail Run above the
      held layer and hands it out after release; verified by dbtest.
- [ ] In a mixed poll containing barred and allowed held-Chain candidates, the
      allowed Runs retain their ordinary relative ranking after barred Runs are
      filtered; a focused dbtest covers the new mixed state while existing
      claim-ordering and blind-claim suites remain regression verification.
