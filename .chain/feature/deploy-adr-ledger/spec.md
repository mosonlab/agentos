Chain queue: step 1 of 4 (artifact-based deployment). No predecessor. Successor: card 2 binds to this card with afterTaskId at dispatch time. Route: senior-dev-luna (template default).

### Goal

An ADR codifies the narrowed artifact-based deployment target, and every auto-deploy run leaves a durable per-deployment ledger on disk, with zero behavior change to the deploy itself.

### Background

`scripts/deploy/quiet-window-deploy.mjs` executes `executeUpgrade()` as an in-memory ordered procedure. After an interrupted or escalated deploy, the true state must be reconstructed by cross-reading the production checkout HEAD, the live build stamp from `/version`, and Prisma migration history; nothing records which phase committed before the interruption. Escalation markers (`escalated.json`) carry a reason but not the phase evidence trail.

The ADR replaces the broader external architecture package with a deliberately narrowed scope: the builder is the appliance host itself (gate workers are Ubuntu VMs and their build bytes never deploy to the Apple Silicon appliance); there is no artifact signing, no build/deploy/application trust separation, no separate DB migrator role, no restore-rehearsal automation, and no multi-state orchestrator.

### Changes

1. Add an ADR document under `docs/` (follow the existing ADR location and numbering convention in the repo) stating: (a) the deployment unit becomes an immutable release directory `releases/<commit>-<digest>/` activated by an atomic `current` symlink switch, built on the appliance host in a build step separate from activation; (b) a durable per-deployment ledger is the authoritative record of deploy progress; (c) migration policy: ordinary automatic deploys may only apply expand-type migrations (additive columns/tables, nullable or defaulted fields, backfills); destructive migrations (drop/rename/constraint tightening) require explicit manual operator approval and never run in an ordinary quiet-window deploy; (d) the launchd migration order is wrapper-first: stable `current/` entrypoints are installed and verified before activation semantics change; (e) an explicit non-goals list: no artifact signing or provenance attestation, no trust-authority separation, no DB role split, no restore-rehearsal harness, no N/N-1 mechanical compatibility gate (policy plus review only), no containers, no orchestrator, no zero-downtime rollout.
2. Add a ledger module in `scripts/deploy/` used by `quiet-window-deploy.mjs`: each deploy run allocates a `deployment_id` and writes under the existing deploy state directory a per-deployment directory containing `state.json` (written temp-file plus atomic rename) and `events.jsonl` (append-only). Recorded fields per event: deployment id, phase, timestamps, target commit, backup identity when created, migration tail before and after, activated build stamp, machine-readable reason code on failure.
3. Ledger states are exactly: `STARTED`, `BACKED_UP`, `SCHEMA_ADVANCED`, `ACTIVATED`, `VERIFIED`, `SUCCEEDED`, `FAILED`, `MANUAL_RECOVERY`. `MANUAL_RECOVERY` is recorded when the schema has advanced but activation or verification outcome cannot be proven. Map these onto the existing phase boundaries in `executeUpgrade()`; do not add new phases.
4. The ledger is record-only: it must not gate, reorder, or alter any existing control flow, retry, escalation, or rollback behavior. A ledger write failure fails the deploy loudly (no silent skip).
5. Bounded retention for per-deployment ledger directories, consistent with the existing bounded-retention discipline in the deploy state directory.

### Out of scope

- No `releases/` directory, `current` pointer, or launchd path change (card 2).
- No removal of `npm ci` or the source-build fallback in the deploy path (card 3).
- No deletion of the existing publication or rollback mechanism (card 4).
- The ledger does not become a control authority; no resume-from-ledger logic.
- No changes to merge gate, quiet-window logic, deploy barrier, or backup mechanics.

### Constraints

- Zero behavior change to deploy control flow; existing deploy tests must pass unmodified except for additions asserting ledger output.
- Ledger content must not contain secrets: no `DATABASE_URL`, tokens, `.env` values, or raw subprocess output.
- `state.json` writes are atomic (temp plus rename); `events.jsonl` is append-only.

### Acceptance

1. ADR document exists, contains the migration policy, the wrapper-first launchd order, and the non-goals list, and passes `npm run lint` and the docs snapshot scan.
2. Deploy test fixtures for a successful deploy show a per-deployment directory with `state.json` terminal state `SUCCEEDED` and `events.jsonl` covering every phase listed in change 3 that the run passed through.
3. Deploy test fixtures for a failed deploy show terminal state `FAILED` with a machine-readable reason code; a fixture where schema advanced but activation outcome is unproven shows `MANUAL_RECOVERY`.
4. A test asserts a ledger write failure fails the deploy run loudly.
5. All existing deploy tests remain green.


---
Routing Contract: v1.4
Tier: Direct
Implementation Agent: senior-dev-luna
Critical: no
Reason: ADR document plus record-only ledger; zero behavior change; mechanical acceptance.