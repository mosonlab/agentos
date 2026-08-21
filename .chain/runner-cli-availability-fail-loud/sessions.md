implementation_range:
  base: 9914a401d0f9fa94dbe9d8556a66bcbf46a7f4ce
  head: 29f687921d12552fc8aacb3804b3003a41b21d12
  note: this recorded base does not bound the implementation. `9914a40` is
    itself a commit inside the feature, and `9914a40..29f6879` contains no
    `packages/runner` change at all - the entire runner-side implementation
    landed in `ad8bc67`, whose parent is `0d5b93e`. The corrected base is
    `0d5b93e`. See OPUS-15 in `reviews/opus-blind-findings.md`. The first
    reviewer's report was produced against the recorded range; the blind Opus
    review and the adjudication used the corrected superset.

opus_blind_review:
  session: cmt2fswp706ytmp45vbi9hrmi
  blind findings commit: 3b377eb (written and committed before
    `reviews/sol-findings.md` was opened)
  findings: reviews/opus-blind-findings.md
  adjudication: reviews/adjudication.md
  pre-fix head: 29f687921d12552fc8aacb3804b3003a41b21d12
  must-fix: SOL-STD-001, OPUS-1, OPUS-2 (all P1)
