Deploy: a host that keeps only runners follows the control plane's deployed build automatically

Route: implementation=senior-dev - the change splits the deployment phase list by host role and has to keep a runner-only host in lockstep with a control plane on another machine; a wrong quiet-window scope or a restart that races a Run on the other host is not something the fake-service acceptance suite can witness after the fact.

Goal: a host that runs runner units but no API, inbox, or web service upgrades itself to exactly the build the control plane reports, without the operator building, pointing, and kickstarting by hand after every release.

Background: after the 2026-09-04 cutover the Linux VM runs the control plane
and sixteen Codex runners; the Mac keeps six CLAUDE runners (Claude only runs
there) with its API, inbox, and web units booted out and auto-deploy disabled.
Every release on the VM leaves the Mac runners one build behind, and a
claim/complete contract change (`RUN_COMPLETION_CONTRACT_VERSION` in
`packages/db/src/claim-contract.ts:38`, checked at `run-claim.ts:626`) or any
other wire change would break them silently; the merge-executor completion
drift of 2026-09-03 is the precedent.

`scripts/deploy/quiet-window-deploy.mjs` has one shape. `DEPLOY_PHASES` in
`scripts/deploy/deploy-phases.mjs` runs read-revisions through verify-services
unconditionally; `backup`, `guardedMigration`, `generatePrismaClient`,
`syncCanonicalPrompts`, and `verifyRuntimePrismaClient` assume this host owns
the database and the canonical prompts; `restartServices`, `verifyServices`,
and `verifyStableServicePaths` iterate `SERVICE_LABELS` from
`generateServiceInventory` (`quiet-window-lib.mjs:35-58`), which always emits
`com.agentos.api`, `com.agentos.inbox`, the runner labels, and
`com.agentos.web`; verification probes `http://127.0.0.1:<API_PORT>/version`,
which on the Mac is a tunnel to the VM and would verify the wrong host. The
target commit comes from the source remote's main, so a runner host could also
run ahead of the control plane. Quiet detection (`blockingRuns`, through the
database) counts every active Run on every host. Runners register with
`daemonVersion` (`packages/runner/src/config.ts:159`, currently the package
version), reported per daemon by `GET /runners`.

Changes:
1. A host role, configured through one installer key (`AGENTOS_DEPLOY_ROLE`,
   values `control-plane` (default) and `runner`), recorded in the install
   manifest's `renderInputs` and rendered into the auto-deploy unit like the
   runner count is today.
2. `generateServiceInventory` for role `runner` emits only the runner labels
   (with the configured count and id prefix); the installer, service control,
   and the quiet-window verifier all consume that inventory, so a runner host
   never installs, restarts, or verifies `com.agentos.api`, `com.agentos.inbox`,
   or `com.agentos.web`.
3. In role `runner`, the target commit is the `commit` reported by the control
   plane's `GET /version` at the configured API base URL; a `dirty` build, an
   unreachable endpoint, or a commit the source remote does not contain is a
   named preflight failure and no artifact is built. `read-revisions` and
   `check-already-deployed` compare the local `current` pointer against that
   commit, so the host never deploys a build the control plane is not running.
4. In role `runner`, the upgrade phase list omits `backup`, `guarded-migration`,
   `generate-prisma-client`, `canonical-prompt-sync`, and
   `verify-runtime-prisma-client`; the omission is a property of the phase
   table (a role column), not a set of `if` branches inside host methods.
5. In role `runner`, quiet detection counts only active Runs whose `runnerId`
   belongs to this host's inventory (prefix and count), so a busy control-plane
   host does not hold the runner host's window and vice versa.
6. In role `runner`, `verify-services` succeeds only when every runner in this
   host's inventory has registered with the control plane since the restart
   and reports the deployed build; to make that observable, `daemonVersion`
   carries the build commit from the release build stamp (the same
   `build-info.json` provenance the API uses for `/version`), and `GET /runners`
   exposes it per daemon. A verification failure rolls the pointer back and
   restarts the runners on the previous release exactly as the control-plane
   role does, and escalates through the existing path.
7. `docs/runbooks/quiet-window-auto-deploy.md` gains a "Runner-only host"
   section stating the role key, what the role skips, the lockstep rule, and
   the verification signal; `docs/install.md` mentions the role where it
   describes a second host.

Out of scope:
- Any change to how the control-plane role builds, migrates, or verifies.
- A remote artifact download or deploy queue; a runner host still builds its
  own artifact from the source remote at the target commit.
- Changing `RUNNER_SERVED_KINDS`, runner isolation, or which kinds a host
  serves.
- Re-enabling auto-deploy on the current Mac host; that is an operator step
  after this lands.
- The merge executor, which is installed by hand under its own runbook.
- A contract-version negotiation between runner and API beyond what
  `RUN_COMPLETION_CONTRACT_VERSION` already does.

Constraints:
- The default role is a byte-for-byte no-op: with `AGENTOS_DEPLOY_ROLE` unset
  every rendered unit, manifest, phase sequence, and log line is identical to
  today, and the Darwin baseline fixture is neither regenerated nor edited.
- Fail loud: an unknown role value, a manifest whose recorded role disagrees
  with the configured one, a control plane that cannot be read, or a runner
  that does not re-register on the new build each stop the operation with a
  named outcome; there is no fallback to remote main and no partial success.
- A runner host must never run migrations or canonical sync, even if it can
  reach the database.

Acceptance:
1. With `AGENTOS_DEPLOY_ROLE` unset, `scripts/deploy/systemd-installer.test.mjs`
   and `launchd-service-wrapper.test.mjs` pass unmodified, including the
   Darwin baseline fixture.
2. Rendering with `AGENTOS_DEPLOY_ROLE=runner` produces only runner units, the
   manifest records the role, and stage two refuses a manifest whose role
   disagrees with the configured one with a named error.
3. `quiet-window-deploy.test.mjs` has role-`runner` cases: the target commit
   equals the fake control plane's `/version` commit and a `dirty` or
   unreachable `/version` fails preflight with a named reason; the executed
   phase names exclude the five database phases; blocking Runs on foreign
   runner ids do not hold the window while one on a local id does; verification
   passes only when every local runner re-registers with the target commit and
   otherwise rolls back and restarts on the previous release.
4. A runner started from a release build registers a `daemonVersion` equal to
   the build commit, visible in `GET /runners`; covered in
   `packages/api/src/routes/runner.test.ts` or the system routes test.
5. Both runbooks contain the new section; `npm run test:auto-deploy`, the
   `scripts/deploy` suites, `npm run test -w packages/runner`, and
   `npm run test -w packages/api` are green.