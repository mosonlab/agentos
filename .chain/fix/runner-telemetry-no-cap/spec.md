API: the runner telemetry registry keeps every daemon seen inside the forget window

After this chain, GET /runners lists every runner daemon and merge executor that reported within the last fifteen minutes, however many there are, so a fleet larger than sixteen principals no longer loses a rotating row in the operator view.

Route: implementation=senior-dev - the change is one deleted eviction rule in a single in-memory registry, fully witnessed by unit tests; it is also the first chain to run on the Linux VM after the cutover and exercises the VM's first real deployment.

Background:

`packages/api/src/runners.ts` keeps daemon telemetry in a process-local Map. `RUNNER_MAX_ENTRIES = 16` (line 10) makes `note` evict the least recently seen entry whenever a new runner id arrives while the map is full (line 33). Separately, `snapshot` already deletes every entry older than `RUNNER_FORGET_MS` (fifteen minutes, line 46).

On 2026-09-04 production moved to a Linux VM running sixteen `vm-runner-N` daemons plus `merge-executor-linux-1`, with six Mac `runner-N` daemons still attached over an ssh tunnel: twenty-three principals. Four consecutive samples of GET /runners on the VM returned exactly sixteen rows with a different `vm-runner-*` missing each time. Claiming and data safety are unaffected (they rest on `fencingToken` and the database), but the board runner view is permanently short, and the runbook health check that looks for the merge executor row in GET /runners fails intermittently. The cap never bit on the Mac because the fleet there was eleven.

The forget window is the bound that matters: a runner id that stops reporting disappears after fifteen minutes, and only daemons holding `RUNNER_TOKEN` can report at all. The entry cap adds nothing but the truncation.

Changes:

1. In `packages/api/src/runners.ts`, delete `RUNNER_MAX_ENTRIES` and `evictOldest`, and remove the eviction branch at the top of `note`. `RUNNER_FORGET_MS` and the expiry sweep in `snapshot` stay exactly as they are.
2. In `packages/api/src/runners.test.ts`, replace the test that asserts the registry keeps at most `RUNNER_MAX_ENTRIES` entries with one proving that after twenty-three distinct runner ids report within the window, `snapshot` returns all twenty-three; keep a case proving an id whose last report is older than `RUNNER_FORGET_MS` is dropped by `snapshot`.
3. If `docs/operator-api.md` or any runbook under `docs/runbooks/` states a sixteen-entry limit for GET /runners, update that sentence to describe the forget window as the only bound. Do not add a new section.

Out of scope:

- Runner id namespacing, `AGENTOS_RUNNER_ID_PREFIX`, and the systemd or launchd installers.
- The `online` computation in `snapshot`, `RUNNER_FORGET_MS`, and the backend availability rows in GET /runners.
- Persisting telemetry to the database or making the bound configurable through the environment.
- Any change under `packages/runner`.

Constraints:

- The write set is `packages/api/src/runners.ts`, `packages/api/src/runners.test.ts`, and at most one sentence in `docs/operator-api.md` or a runbook if it states the limit.
- No new configuration key, no new export, no compatibility alias for the removed constant; anything that imported `RUNNER_MAX_ENTRIES` is updated in the same change.
- Behaviour for fleets of sixteen or fewer daemons is unchanged byte for byte in the GET /runners response.

Acceptance:

1. `packages/api/src/runners.test.ts` proves twenty-three distinct ids reporting within the window all appear in `snapshot`, and an id last seen more than fifteen minutes ago does not.
2. `grep -rn RUNNER_MAX_ENTRIES packages docs` returns nothing.
3. `npm run lint -w packages/api`, `npm run typecheck -w packages/api`, and `npm run test -w packages/api` are green; `test:db` evidence comes from the merge gate.
