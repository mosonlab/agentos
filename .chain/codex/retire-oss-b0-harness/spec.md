Contract ID: SIM-OPS-001
Contract Version: 1.0

The next Anneal minor no longer publishes or maintains the historical OSS-B0 verification harness, while every current verification, release, and smoke-test authority remains intact.

Background: package.json still exposes verify:oss-b0 and test:oss-b0-harness, backed by scripts/verify-oss-b0.mjs, scripts/verify-oss-b0-review.mjs, and scripts/verify-oss-b0.test.mjs. Repository-wide consumer and history review at 7ac3bdac found no current production, CI, merge-gate, install, or release workflow consumer; the files mainly verify their own historical OSS-B0 evidence workflow. The operator approved SIM-OPS-001 as a next-minor breaking removal on 2026-08-29. Revalidate this premise against current main before editing because the surface historically carried release-assurance semantics.

Changes:
1. Remove the verify:oss-b0 and test:oss-b0-harness package scripts and delete scripts/verify-oss-b0.mjs, scripts/verify-oss-b0-review.mjs, and scripts/verify-oss-b0.test.mjs.
2. Remove only those three files from the closed public-snapshot include set; keep the manifest closed and valid for every surviving tracked file.
3. Add an Unreleased changelog entry that names the public CLI removal as breaking in the next pre-1.0 minor and points operators to the surviving current verification authorities without claiming a replacement that does not exist.
4. Preserve docs/release/fixtures/oss-b0-smoke-task.json, every goal-5a0-* check, scripts/merge-gate.sh, gate-worker, merge-integrator real/system checks, templates release demo, and all immutable or internal historical records unchanged.

Out of scope: THEME-WEB-01 and any unrelated dead export; migration-and-recovery or security documentation corrections; redesigning the merge gate; creating a generalized replacement harness; changing release, deploy, database, lease, ownership, security, or production-service behavior; editing frozen/internal historical records; production activation or restart.

Constraints: fail loudly and stop before deletion if current main reveals any active CI, release-authority, operator-runbook, or dynamic consumer of the OSS-B0 harness. Do not retain a compatibility command, deprecated wrapper, alias, or silent fallback. The approved scope is exactly SIM-OPS-001; new deletion opportunities return to a later simplification report.

Acceptance:
1. package.json contains neither removed script name, and the three harness files no longer exist.
2. public-snapshot.json contains no include for the removed files; npm run test:snapshot-scan and npm run snapshot:scan pass at the committed implementation head.
3. CHANGELOG.md Unreleased records the breaking public removal and accurately names surviving verification paths.
4. Repository search finds no surviving live code, package script, CI, current runbook, or current release-doc reference that requires the deleted harness; historical/internal records remain untouched.
5. npm run test:release-docs, npm run test:dependency-gate, npm run verify:secret-hygiene, focused affected tests, repository typecheck/lint as required by the implementation proof, and the exact-head merge gate pass.

Risks and stopping conditions: public CLI removal with historical release-assurance adjacency. Stop if revalidation finds a current authority consumer, if removal would require changing a defense-list path, or if the scope cannot be completed without a replacement compatibility surface.

Dependencies and prerequisites: independent of every current Backlog card and chain; no afterTaskId dependency. Start from freshly fetched current main, which must contain merged PR #260 at 60153baaa8bfced1eb46e426fae4c98d86e08be9 or a descendant.

Routing Contract: v1.7
Tier: Direct
Implementation Agent: senior-dev
Critical: no
Reason: change points fit one implementation window, but the public CLI and unresolved historical release-authority classification require the Sol High implementation route while the ordinary Direct reviews and exact-head merge authorization remain intact.
Route: implementation=senior-dev