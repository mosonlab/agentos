Deliver PR #56 through a fresh canonical server-owned merge tail after the prior canonical cycle's independent review found RV-01 and the official review-fix task repaired it at exact head `77b5432cc886132d93a82115d15189a1d0264aa2`.

Background: PR #56 (`review-agents-pi-runner`) contains the PI review-runner feature, its earlier RV-01 session-retention repair, the canonical adoption record, and the official autonomous review-fix for canonical-agent upgrade compatibility. The prior canonical cycle stopped truthfully because its regression prompt was bound to pre-repair head `2524881ad985d8f43e3f7120b1db6bc6e9be95c7`. The repair commit `77b5432cc886132d93a82115d15189a1d0264aa2` is a direct append-only child, was created by control-plane task `cmt4selno01z8mpevo9qhlk6b`, and has `MERGE GATE: PASS 77b5432cc886132d93a82115d15189a1d0264aa2` against main `5b6825c58d325aa64855bd3766361038235e2b18`.

Changes:
1. Adopt the existing remote branch `review-agents-pi-runner` at exact repaired starting head `77b5432cc886132d93a82115d15189a1d0264aa2`; preserve every path except `.chain/review-agents-pi-runner/spec.md` byte-for-byte from that tree.
2. Replace only `.chain/review-agents-pi-runner/spec.md` with this brief and commit that record append-only on the shared branch.
3. Reuse PR #56; do not create another pull request or alter its base, title, or branch.
4. Treat current main `5b6825c58d325aa64855bd3766361038235e2b18` as the implementation review base and the final adoption commit as the review head, so canonical reviews and regression cover the complete PR diff including the official RV-01 repair rather than only the spec-record commit.
5. Let the canonical chain perform dual review, closed must-fix handling, exact-head regression gate only through `scripts/gate-worker/gate-dispatch.sh`, server-owned readiness, any defense-triggered exact-head independent blind review, authorization, and mechanical App merge.

Out of scope: any new product-code change beyond a must-fix produced by this fresh canonical cycle; changing PR identity; modifying credentials, deployment configuration, another goal branch, main, or any other pull request; manufacturing review, gate, authorization, or merge evidence.

Constraints: published branch history remains append-only; fail loudly if the repaired starting head, existing PR identity, or any non-spec path differs; a review or regression must bind the full `5b6825c58d325aa64855bd3766361038235e2b18..HEAD` range; all gate execution uses the dispatcher; only `agentos-merge-executor[bot]` may merge.

Acceptance: the implementation step changes only `.chain/review-agents-pi-runner/spec.md` relative to `77b5432cc886132d93a82115d15189a1d0264aa2`, every other blob remains identical, PR #56 remains the reused OPEN PR, fresh canonical reviews cover the full main-to-head range and leave no open must-fix, regression persists PASS for the exact current head and current main base, any defense-triggered independent review approves the same exact head, the App merge succeeds, and post-merge main contains no `.chain/` path.
