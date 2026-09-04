Gate: local gate slots are accounted per runner account, not per Codex session

Goal: `AGENTOS_GATE_LOCAL_SLOTS=N` bounds the local gates a runner account can run at once, regardless of how many Codex sessions that account has.

Background: `packages/runner/runtime-tools/gate-worker/gate-dispatch.sh:88`
derives its slot directory as
`SLOT_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/gate-dispatch"`, and the comment at
lines 19-20 says the slots "belong to the machines". Slot ownership is a hard
link created in that directory (`gate_slot_try`, `lib.sh:159-247`). The Codex
adapter relocates `HOME` for every session: `codexChildEnvironment` in
`packages/runner/src/adapters/codex.ts:285-293` sets `HOME` and `CODEX_HOME` to
`scratch.configRoot`, a per-session directory under the session scratch
(`workspace.ts:134,300`). Each Codex Run therefore gets a fresh, empty slot
directory and `AGENTOS_GATE_LOCAL_SLOTS=N` grants every Run its own N slots. On
a sixteen-runner host with `RUNNER_GATE_LOCAL_SLOTS=1` that is sixteen
concurrent local gates, each a PostgreSQL container plus a full build and test
run; the remote path bounds itself (`run-gate.sh:226` holds a worker-wide
`flock` against `worker-capacity`), the local path does not.

The runner already exports the account's real home to every child as
`AGENTOS_RUNNER_HOME` (`packages/runner/src/adapters.ts`, `buildChildEnvironment`,
forwarded through `COMMON_LAUNCHER_ENVIRONMENT` in `adapters/runtime.ts:266-270`)
precisely for tooling that a relocated `HOME` would cut off. The Claude adapter
does not relocate `HOME` (`adapters/claude.ts`), so its slots were already
per account. `docs/runbooks/gate-worker.md` ("First deployment") documents
`RUNNER_GATE_LOCAL_SLOTS` as a per-runner-owned choice without stating the
accounting unit.

Changes:
1. `gate-dispatch.sh` derives `SLOT_ROOT` from `AGENTOS_RUNNER_HOME` when it is
   set (`$AGENTOS_RUNNER_HOME/.cache/gate-dispatch`), and only otherwise from
   `XDG_CACHE_HOME` / `HOME`, so every session of one runner account contends
   for the same slot files whatever `HOME` the adapter gave it.
2. The startup log line that names the slot directory (or a new one, if none
   exists) prints the resolved `SLOT_ROOT` and which variable it came from, so
   a gate excerpt shows which accounting unit applied.
3. `docs/runbooks/gate-worker.md` states the accounting unit: local slots are
   per runner account (the account that owns `AGENTOS_RUNNER_HOME`); on a host
   with one account and many runners, `RUNNER_GATE_LOCAL_SLOTS` is the host
   ceiling; on a host with one account per runner it is a per-runner ceiling
   and the host ceiling is the sum. The runbook's first-deployment guidance
   recommends the remote worker (`RUNNER_GATE_SERVER`) for multi-runner hosts.

Out of scope:
- A cross-account, host-wide slot root (would need a world-writable directory
  and a different stale-holder reclaim); hosts with per-runner accounts route
  through `RUNNER_GATE_SERVER`.
- Any change to the runner's child environment, `AGENTOS_RUNNER_HOME`, or the
  Codex `HOME` relocation.
- `run-gate.sh`, `remote-gate.sh`, the worker-capacity file, and slot-count
  limits.
- The slot acquisition mechanism in `lib.sh` (hard link, witness, reclaim).

Constraints:
- Outside a Run (`AGENTOS_RUNNER_HOME` unset), behaviour is byte-identical to
  today.
- The runtime-tools bundle is built from these sources; no hand-edited copy is
  introduced and the byte-identity checks stay green.

Acceptance:
1. `scripts/gate-worker/gate-dispatch.test.mjs` has a test that runs two
   dispatches with different `HOME` values and the same `AGENTOS_RUNNER_HOME`
   under `AGENTOS_GATE_LOCAL_SLOTS=1`, and asserts the second waits for (or is
   refused by) the slot held by the first; and a test that with
   `AGENTOS_RUNNER_HOME` unset the slot directory resolves under `HOME`
   exactly as before.
2. The dispatch log names the resolved slot directory and its source variable.
3. `packages/runner/src/runner.test.ts` and `workspace.test.ts` runtime-tools
   materialization tests are green against the rebuilt bundle.
4. `docs/runbooks/gate-worker.md` contains the accounting-unit paragraph;
   `npm run test:snapshot-scan` is green.
5. `npm run test -w packages/runner` and the `scripts/gate-worker` suites are
   green.