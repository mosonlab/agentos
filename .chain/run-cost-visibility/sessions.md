# Review sessions

## implementation_range

- base: `00b94f9861861d19c5bdc78b57cb5949d82bd730`
- head: `047818c63e87177894ccb547679c5e18f80b2655`
- verification: both values resolve to commits, base is an ancestor of head, and
  the review checkout was at the delivered head with a clean worktree

## opus_blind_review

- session: `cmt2gwwuz0az2mp45yl81zd4s`
- blind findings commit: `d02e10c` (written and pushed before
  `sol-findings.md` was opened; the commit order is the evidence)
- adjudication: `.chain/run-cost-visibility/reviews/adjudication.md`
- pre-fix head: `047818c63e87177894ccb547679c5e18f80b2655`
- must-fix: MFX-01..MFX-04, all P1, no P0
- resume this session id for regression verification; never select by recency
