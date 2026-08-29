Route: implementation=senior-dev

Chain queue: step 2 of 4 (artifact-based deployment). Predecessor: card 1 (ADR plus ledger) must be delivered first; bind with afterTaskId at dispatch. Successor: card 3 has a HUMAN checkpoint before it (see its brief). Route: senior-dev — activation and rollback windows, launchd service lifecycle semantics, and interrupted-activation recovery are hazards the acceptance suite cannot fully witness.

### Goal

Deployment activation becomes a single atomic `current` symlink switch over immutable versioned release directories, and all launchd services start from stable `current/` entrypoints, replacing the multi-directory rename publication.

### Background

Today `publishDirectories()` in the deploy path renames multiple `dist/` directories and `node_modules` one by one into the live checkout, with compensating rollback in a catch block. This creates a window of mixed filesystem state, and rollback restores `previous-*` copies directory by directory. The production git checkout doubles as the serving runtime, so checkout HEAD and serving version can diverge after interruption.

The target layout, per the ADR from card 1:

- `releases/<commit>-<digest>/` — complete immutable release trees (application dist, web dist, runtime node_modules, Prisma migration material, build stamps).
- `shared/` — `.env` and persistent operator data, outside release trees.
- `current` and `previous` — symlinks; `current` is the only activation authority.

The build step (materializing a release directory) is separated from activation and runs on the appliance host; the existing snapshot-or-build logic remains the source of build outputs in this card.

### Changes

1. Extend the deploy pipeline so that after build/snapshot materialization it assembles a complete release directory `releases/<commit>-<digest>/` containing everything the services need at runtime, verifies its digest and build stamp, then marks it immutable (no writes after verification).
2. `shared/` holds `.env` and persistent data; release trees contain no secrets and no mutable state. Services resolve shared config through a stable path, not through the release tree.
3. Wrapper-first launchd migration, in this order within the card: (a) install wrapper entrypoints (or updated plists) that resolve through `current/`; (b) verify every service in the service inventory starts and passes readiness through the wrapper path while activation still uses the existing mechanism; (c) only then switch publication to atomic pointer activation. Each sub-step must be independently revertible.
4. Activation becomes: atomic swap of the `current` symlink to the verified release directory, update `previous`, restart services, verify readiness and exact target version via `/version`. Rollback becomes: point `current` back at `previous` and restart, replacing `previous-*` directory restoration for the new path.
5. The card-1 ledger records release directory identity, pointer transitions (old target, new target), and rollback pointer outcomes.
6. Bounded retention of release directories, consistent with the existing previous-build retention discipline.

### Out of scope

- Do not remove `npm ci` or the source-build fallback (card 3); the build step may still install and build as today.
- Do not delete `publishDirectories()`, `previous-*` handling, or production checkout requirements (card 4); the old path remains in the codebase as the retreat path.
- No changes to backup, migration execution, quiet-window, or deploy barrier logic.
- No artifact signing, no remote artifact store.

### Constraints

- At every intermediate commit within the card, a production deploy must still be possible through one coherent path; no state where neither path works.
- Release directories are immutable after verification; any post-verification mutation is a deploy failure.
- Pointer swap is a single atomic filesystem operation; there must be no intermediate state where `current` is absent or dangling.
- Fail loudly: a service failing readiness from the `current/` path aborts and rolls back via pointer; no silent fallback to old paths.

### Acceptance

1. Deploy tests cover: successful pointer activation; rollback via pointer to `previous`; interruption between pointer swap and service restart leaves a state the ledger plus filesystem can explain (test asserts ledger records the swap before restarts begin).
2. A fixture proves every service in the service inventory starts via the wrapper/`current/` path and reports the target release identity.
3. A test asserts release-tree immutability is enforced (post-verification write attempt fails the deploy).
4. A test asserts `.env` and persistent data resolve from `shared/` and are absent from release trees.
5. All existing deploy tests remain green; `npm run lint` passes.


---
Routing Contract: v1.4
Tier: Direct
Implementation Agent: senior-dev
Critical: no
Reason: Activation/rollback windows and launchd lifecycle are review-tail blind spots; no schema or persisted-data mutation.
Depends on: deploy1 chain - True dependency - consumes the ADR contract and ledger from deploy1