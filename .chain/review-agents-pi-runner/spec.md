Deliver the already-reviewed PR #56 implementation through the current canonical server-owned merge tail so the GitHub App can merge it and the legacy six-step chain remains historically truthful.

Background: PR #56 (`review-agents-pi-runner`) was created by a legacy `direct-engineer-workflow` snapshot whose final step was Human PR review and which has no Merge readiness or Merge execution tasks. That legacy chain is now fully DONE with a fresh delegated Human review at exact head `eeb547c33c714b0f467450ce8b6b1d1dabec35ab` against main `5b6825c58d325aa64855bd3766361038235e2b18`; the branch implementation and RV-01 repair are complete. The missing behavior is only canonical server-owned readiness, authorization, and App merge authority.

Changes:
1. Adopt the existing remote branch `review-agents-pi-runner` at exact starting feature head `eeb547c33c714b0f467450ce8b6b1d1dabec35ab`; preserve every non-`.chain/` path byte-for-byte from that tree.
2. Replace only `.chain/review-agents-pi-runner/spec.md` with this brief as required by the canonical direct template and commit that record on the shared branch.
3. Reuse PR #56; do not create a second pull request or alter its base branch.
4. Let the canonical chain perform its own dual review, fix/regression decision, exact-head gate through `scripts/gate-worker/gate-dispatch.sh`, server-owned readiness, authorization, and mechanical App merge.

Out of scope: product-code changes; changing the PR title, target, or branch; reworking the PI runner feature; modifying credentials, deployment configuration, another goal branch, main, or any other pull request; manually manufacturing review, gate, authorization, or merge evidence.

Constraints: published branch history remains append-only; fail loudly if the starting feature head, existing PR identity, or non-`.chain/` tree differs; all gate execution uses the dispatcher; only `agentos-merge-executor[bot]` may merge.

Acceptance: before the implementation step publishes, `git diff --name-only eeb547c33c714b0f467450ce8b6b1d1dabec35ab..HEAD` contains only `.chain/review-agents-pi-runner/spec.md`, every non-`.chain/` blob at HEAD matches `eeb547c33c714b0f467450ce8b6b1d1dabec35ab`, PR #56 is the reused OPEN pull request, later canonical review outputs contain no open must-fix, regression persists PASS for the exact current head and current main base, App merge succeeds, and post-merge main contains no `.chain/` path.
