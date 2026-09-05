Goal: a transient network failure while cloning the release source no longer escalates auto-deploy.

Background: on 2026-09-04 17:07Z `build-release-artifact` failed its clone with `gnutls_handshake() failed: The TLS connection was non-properly terminated` (git exit 128) and auto-deploy escalated `release-artifact-build-failed`. The escalation is not self-clearing, so one network blip cost a manual artifact rebuild, dry-run and `--clear-escalation` (recorded in records/anneal/astra-rollout-20260904-STATE.md). GitHub from the VM is intermittently flaky; the failure mode recurs.

Changes:
1. `scripts/deploy/release-artifact.mjs` retries the source clone up to three times with backoff when git exits 128 with a network-shaped error (TLS handshake, connection reset, could not resolve host); any other failure is not retried.
2. The builder receipt records the number of clone attempts.
3. After the last failed attempt the existing `release-artifact-source-unavailable` failure and escalation behaviour are unchanged.

Out of scope: allowlisting this reason for automatic self-clear; any quiet-window, ledger or activation change; retrying npm install or build steps.

Acceptance: a unit test with a fake git that fails twice with a TLS-shaped stderr and succeeds on the third attempt produces a built artifact whose receipt records 3 attempts; a fake git that fails three times yields the same failure reason and detail shape as today; a fake git failing with a non-network error (exit 128, "not a git repository") is not retried. Existing deploy tests stay green.

Route: implementation=senior-dev-opus-medium - operator spends Claude capacity on this implementation (2026-09-05 routing decision); the fake-git suite states the retry boundary mechanically