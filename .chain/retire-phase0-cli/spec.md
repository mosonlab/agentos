Retire the approved Phase-0 help-only CLI so the next minor release no longer builds, ships, documents, or verifies an agentos command that has no operational command families.

Background: packages/cli currently implements only help and unknown-command output while announcing future Phase-6 command families. The package nevertheless participates in the workspace lock graph, root build and start scripts, merge-gate expectations, quiet-window deploy artifact validation, public snapshot authority, and release documentation. Leo approved this public CLI removal for the next minor release.

Changes:
1. Delete the packages/cli workspace package, including its source, manifest, and tsconfig.
2. Remove @agentos/cli from the root build pipeline and remove the root agentos script. Regenerate package-lock.json with npm so only the retired workspace entries disappear.
3. Remove CLI dist/help expectations from scripts/merge-gate.sh and scripts/deploy/quiet-window-adapters.mjs, updating their focused tests or fixtures where those exact expectations are asserted. Preserve every non-CLI gate and deploy artifact check.
4. Update README.md, README.zh-CN.md, CONTRIBUTING.md, current release/support documentation, CHANGELOG wording, public-snapshot.json, and snapshot/release verification expectations wherever they claim, include, or require the Phase-0 CLI. Do not rewrite append-only historical records or unrelated release claims.

Out of scope: introducing a replacement CLI; changing API routes, Web UI, provider adapters, runner commands, package manager, Node/npm policy, deployment behavior, merge-gate stages, release authority cryptography, or any other workspace package; modifying frozen private records.

Constraints: remove the CLI contract in one cut with no alias, shim, fallback binary, placeholder package, or silent no-op. All non-CLI build, gate, deploy, snapshot, install, and documentation authority must remain fail-closed and behaviorally unchanged. Preserve package-lock integrity through the adopted npm workflow.

Acceptance: packages/cli is absent from the tracked tree and package-lock workspace graph; package.json has no @agentos/cli build segment or agentos script; git grep restricted to tracked paths outside .chain finds no live instruction or assertion claiming agentos help or packages/cli/dist, except historical text that repository frozen-record rules forbid changing; focused deploy, snapshot, release-doc, clean-install, typecheck, build, and affected tests pass; scripts/merge-gate.sh --expect-head <exact candidate head> reports MERGE GATE: PASS for the final head.

Recovery authority: PR #44 on branch retire-phase0-cli is the existing reviewed candidate. Preserve its product diff. Current candidate at adoption is 6c32444d99600139fee8f87dd740b0202d335319, append-only merged with main@66fdd662e89282bf8edd1b143c24f29c79e59a94. The legacy chain 72b89397-30b0-416f-8319-1a3cecc30ffe has a server-unbound legacy base-drift stop; do not mutate or fabricate its stale evidence. This canonical chain must produce fresh exact-head reviews, gate evidence, confirmation, and App-bot merge through official mechanisms. Any identity drift invalidates the affected evidence and must be refreshed.
