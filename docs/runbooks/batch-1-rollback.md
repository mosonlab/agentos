# Runbook — batch 1 (Settings, i18n and sidebar global status) deploy and rollback

Covers the web localisation and Settings changes, runner telemetry, model/effort
selection, per-agent tool restrictions, the read-only Foundation flow, and the
single additive `Agent.disabledTools` migration.

## Deploy order

The API must be deployed before the new web bundle because the web create form
no longer sends `foundationalPrompt`; the new API supplies it from the project's
first-created agent. The schema change is additive and all four runner telemetry
fields are optional, so old/new API and daemon combinations interoperate during
the rollout.

```bash
npm ci
npm run db:generate
npm run build
npm test
npm run typecheck
npm run db:migrate          # 20260816190000_agent_disabled_tools
# restart the API process
# restart the runner daemon
# deploy the web bundle
```

Run the migration against the intended database only. Never build a test control
plane from a dump of the live database: its reconciler can classify live runs as
orphans and delete their managed workspaces. For rehearsal, build a scratch
database from migrations and fixture rows and do not start a control plane against
the live database or any copy of it.

Both process restarts are operational steps, not migration steps:

- The API restart loads `GET /runners`, the in-process daemon registry, soft
  telemetry parsing, and server-side Foundation fill. Immediately after restart,
  the registry may read `Never seen` until the next daemon poll (normally at most
  five seconds).
- The daemon restart loads version/disk/root/poll telemetry and the CLI deny flags.
  Its default identity contains the process id, so the Settings page may read
  `1 of 2 runner online` for up to 15 minutes after a restart. This is expected;
  setting a stable `RUNNER_ID` removes the duplicate-incarnation window.

This implementation task deliberately did not restart the API, runner, launchd,
or any other service.

## Rollback

### Code-only rollback

Revert the batch commits and rebuild all affected workspaces. Keep the additive
column unless there is a compelling reason to discard the only persistent data
created by this batch.

The Foundation halves have a strict rollback order:

1. **Roll back the web bundle first.** The old web form sends an explicit
   `foundationalPrompt`, which both API versions accept.
2. **Then roll back the API.** Reversing this order leaves the new web bundle
   talking to an API that requires the omitted field, so every UI agent creation
   fails with 400.

The runner and API telemetry contracts can be rolled back in either order because
the fields are optional. An old API ignores the new daemon's extra observations;
a new API accepts an old daemon that omits them. Rolling back the runner removes
CLI enforcement immediately even if `disabledTools` values remain stored. Rolling
back only the web hides the controls but preserves those values and enforcement.

The daemon registry is in process memory. It has no table, backfill or durable
state to undo; restarting the reverted API clears it.

### Schema rollback

**Recommended: leave `Agent.disabledTools` in place.** Old generated clients ignore
the extra column, and retaining it makes a later roll-forward lossless.

Before dropping it, capture every non-empty denied set:

```sql
SELECT name, "disabledTools"
  FROM "Agent"
 WHERE array_length("disabledTools", 1) > 0;
```

Only after preserving that output:

```sql
ALTER TABLE "Agent" DROP COLUMN "disabledTools";
```

Dropping the column loses per-agent denied-tool choices. No other batch-1 state is
stored in the database: locale/theme remain browser-local, runner observations are
in memory, and Foundation revisions are computed from existing prompt content.

## Verified feature branches that affect rollback

### Claude tool enforcement

The implementation took the successful-enforcement branch, not the storage-only
fallback. The real captured session under `--dangerously-skip-permissions` is in:

- `spikes/cli-capabilities/samples/claude-disallowed-bash.command.txt`
- `spikes/cli-capabilities/samples/claude-disallowed-bash.stdout`
- `spikes/cli-capabilities/samples/claude-disallowed-bash.stderr`

`Bash` was absent from the initial tool set, ToolSearch found no replacement, and
the shell marker was not created. Therefore the UI truthfully claims enforcement
for all eight Claude mappings. PI enforces `BASH`, `READ`, `WRITE` and `EDIT`;
CODEX exposes no per-tool restriction and the UI labels all eight choices as not
enforced there.

### Chinese cron prose

The installed `cronstrue` package ships `zh_CN` through `cronstrue/i18n`.
English/Chinese schedule tests passed, so there is no intentional English cron
prose allowlist entry to preserve on rollback.

### Capabilities switch alignment

The 3.00 CSS px regression came from `border-[3px] border-transparent` on the
inline-flex Switch root contributing the thumb's baseline inside a non-flex
`BindingToggle` wrapper. The 3px inset is correct; the fix is the wrapper's `ROW`
flex class. Light/dark fixture re-shoots put the active switch colour intervals at
the same physical rows as baseline, so the measured residual displacement is zero.

## Deliberate behaviour changes worth announcing

- Settings is now a real `/settings` page; the old sidebar Settings link to
  `/secrets` is gone. The sidebar theme-cycle button remains and shares one store
  with Settings.
- UI locale defaults to English, is stored under `agentos.locale`, and syncs across
  tabs. Backend, runner and Feishu text remain untranslated.
- A catalog model selects one concrete runner and supported effort. `Custom…`
  remains the escape hatch; `INHERIT` and `AUTO` still use the runtime name
  heuristic.
- `npm run db:seed` still rewrites agent model and runner choices from
  `agents/roles/*.md`. Settings warns about this; the batch does not change seed.
- Foundation is read-only in the web UI. Creating an agent without any existing
  project agent now returns 400 and names `npm run db:seed`; explicit API create and
  patch Foundation paths remain supported.
- A restarted daemon can appear twice for 15 minutes unless `RUNNER_ID` is stable.
  This is bounded registry retirement, not evidence that two daemons are running.
