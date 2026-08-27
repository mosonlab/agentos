A delivering step that must open a pull request fails loudly when it cannot, instead of succeeding silently.

Background: delivery in packages/runner/src/delivery.ts degrades to a manual pull-request advisory when gh is unavailable or PR creation and lookup fail, while the run still records succeeded. Chain 1fdde2fe's delivering run recorded no pullRequestNumber this way, and the merge tail later stopped with pull-request target is none: the strict chain-recorded-PR identity held correctly, but the upstream degradation was silent and cost an operator repair cycle.

Changes:
1. When the run's opensPullRequest is true and delivery cannot record an open pull request on the head branch (creation failed and no open PR exists to reuse), the run fails with the delivery error preserved; existing retry machinery owns re-attempts.
2. The manual advisory path remains only where a pull request is impossible by design (non-GitHub remote), recorded distinctly from a network failure.

Out of scope: the merge-tail target-identity rule (stays strict); pull-request timing (stays at delivery); readiness and correction endpoints.

Constraints: a successful push stays pushed; failing the run must not roll back branch publication.

Acceptance: tests prove (a) opensPullRequest true with failed PR creation fails the run with evidence, (b) a non-GitHub remote still yields the distinct advisory outcome without failing, (c) successful creation or reuse records pullRequestNumber; delivery suites stay green.
