Runner: the first mirror clone of a repository on a machine has its own time budget and a documented pre-seed path

Goal: the first Run of a repository on a new machine finishes provisioning at the exit's real bandwidth instead of failing on the incremental-fetch budget, and an operator can pre-seed the mirror before runners start.

Background: `withRepoMirror` in `packages/runner/src/repo-mirror.ts:440-480`
probes the mirror path and either refreshes a present mirror or creates one
with `createMirror`. Both paths run `git fetch` under the same clone profile:
`CLONE_COMMAND_TIMEOUT_MS = 120_000` per attempt and
`CLONE_OPERATION_BUDGET_MS = 300_000` in total
(`packages/runner/src/network-retry.ts:140-141`, applied at
`repo-mirror.ts:302`). That profile is sized for an incremental fetch on a warm
mirror. A cold mirror is a full clone: on the Linux VM on 2026-09-04 the 46 MB
pack needed 6 to 13 minutes at the exit's 50 to 137 KB/s, every attempt was
killed at 120 s, and the budget expired at 300 s. A retried clone restarts
from zero bytes, so the retry math that protects a fetch only multiplies the
waste for a create.

Runners that arrive while the creating runner holds `<mirror>.lock` poll under
`MIRROR_LOCK_WAIT_MS = 600_000` (`repo-mirror.ts:79`) and then fail with
"Timed out ... waiting for the runner repository mirror lock"; on the VM two
chains lost 2 of 6 Runs each this way. The operator fix was an rsync of the
Mac mirror into `shared/repo-mirrors`, which nothing documents: neither
`docs/install.md` nor any runbook mentions the mirror root, its
`sha256(remoteUrl).git` naming (`repoMirrorPath`), or the lock protocol. Every
new repository on every new host (word-factory next) hits this again.

Changes:
1. Mirror creation runs under its own profile, distinct from refresh: a single
   attempt (no network retry, since a clone cannot resume) bounded by a named
   creation ceiling of at least thirty minutes. Refresh keeps the current
   120 s / 300 s profile unchanged.
2. The mirror lock wait for a waiter is at least the creation ceiling, so a
   runner waiting on a live creating holder does not time out before the
   holder can finish. The existing stale-holder steal (no heartbeat for
   `MIRROR_LOCK_STALE_MINUTES`) is unchanged and still the only way a waiter
   proceeds past a dead holder.
3. The progress report distinguishes the two paths before they start: a
   `creating` event carrying the mirror path is emitted before the full clone
   begins (in addition to the existing `created` on success), so a Run that is
   slow because of a cold mirror says so in its session events.
4. A creation timeout fails the Run with a message that names the mirror path,
   the ceiling, and that this was a first clone, distinct from the refresh
   timeout message.
5. `docs/install.md` gains a "Pre-seed a repository mirror" section stating the
   mirror root (`RUNNER_REPO_MIRROR_ROOT`, default `~/.agentos/repo-mirrors`),
   the exact string hashed to name a mirror directory, and the procedure for a
   host whose runners are not yet started: `git clone --mirror` into that
   path, or copy an existing host's mirror directory. It states that
   pre-seeding a host with running runners is not supported without stopping
   them, because the lock protocol is process-owned.

Out of scope:
- Run budget accounting for provisioning failures (`agentExited: false`
  refunds in `run-completion.ts`); this chain makes the failure not happen, it
  does not change what a failure costs.
- Resumable or shallow clones, pack-size limits, and bandwidth measurement.
- The worktree checkout from the local mirror, which is deliberately unbounded
  (`workspace.ts:472-473`).
- Any automatic pre-seed performed by the installer or auto-deploy.
- The delivery network profile (`NETWORK_*` constants) and the gate worker's
  own mirror handling.

Constraints:
- Fail loud: a creation that exceeds its ceiling is a failure with the named
  message; there is no fallback to a partial mirror and a `.stage-*` left by a
  killed clone is swept exactly as today.
- A warm mirror's behaviour is byte-for-byte unchanged: same commands, same
  timeouts, same events.
- No new environment variable; the creation ceiling is a named constant beside
  the existing clone constants.

Acceptance:
1. `packages/runner/src/repo-mirror.test.ts` covers: a cold mirror whose clone
   runs longer than `CLONE_OPERATION_BUDGET_MS` but shorter than the creation
   ceiling succeeds with a `creating` then `created` event; a warm mirror's
   refresh still fails after the existing 300 s budget with the existing
   message; a cold clone exceeding the creation ceiling fails once with the
   first-clone message and no retry attempt is recorded.
2. A waiter whose holder is alive (heartbeating) for longer than the old
   600 s wait still acquires the lock after the holder releases; a waiter whose
   holder is dead still steals after `MIRROR_LOCK_STALE_MINUTES`.
3. `packages/runner/src/network-retry.test.ts` and
   `packages/runner/src/workspace.test.ts` pass unchanged except where they
   assert the new event name.
4. `docs/install.md` contains the pre-seed section with the hash input stated
   literally, and a test in `repo-mirror.test.ts` asserts that the documented
   naming rule yields the same directory name as `repoMirrorPath` for a sample
   URL.
5. `npm run test -w packages/runner` is green with `RUNNER_WORKSPACE_ROOT`
   pointed at a temporary directory; `npm run test:snapshot-scan` is green.