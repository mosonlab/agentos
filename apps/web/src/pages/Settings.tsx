import type { ReactNode } from "react";

import { circuitReasonKey, CodexReadinessNotice, codexReady, runnerSummary, RunnerStateIndicator, useRunners } from "../components/runner-status";
import {
  Card, Field, HINT, KeyValue, NOTICE, PAGE_HEAD, PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, Page, Segmented,
} from "../components/ui";
import { apiBase } from "../lib/api";
import { timeAgo } from "../lib/format";
import { usePoll, type Poll } from "../lib/hooks";
import { useLocale, useT } from "../lib/i18n";
import { fatal } from "../lib/poll-state";
import { useTheme, type ThemeMode } from "../lib/theme";
import type { BackendStatus, DaemonStatus, Health, RunnerKind, RunnersResponse, VersionInfo } from "../lib/types";
import { cn } from "../lib/utils";

const RUNNERS: RunnerKind[] = ["CLAUDE", "CODEX", "PI"];
const none = (value: string | null | undefined): string => value && value.length > 0 ? value : "—";
const disk = (value: number | null): string => value === null ? "—" : `${(value / 1024 ** 3).toFixed(1)} GB`;

const DaemonDetails = ({ daemon, stale }: { daemon: DaemonStatus | null; stale: boolean }): ReactNode => {
  const t = useT();
  const state = stale ? "unknown" : daemon?.online ? "running" : "offline";
  const tone = state === "running" ? "green" : "grey";
  const lowDisk = daemon?.diskFreeBytes !== null && daemon?.diskFreeBytes !== undefined && daemon.diskFreeBytes < 2 * 1024 ** 3;
  return (
    <div className="grid gap-[10px] border-t border-border pt-[12px] first:border-0 first:pt-0">
      <div className="flex items-center gap-[7px] font-bold">
        <span>{daemon?.runnerId ?? t("settings.runner.daemon")}</span>
        {!stale && daemon?.online && daemon.busy ? <span data-runner-busy="" className="rounded-md bg-accent px-[5px] py-[1px] text-[10px] font-normal">{t("runner.state.busy")}</span> : null}
      </div>
      <KeyValue columns={3} items={[
        { k: t("settings.runner.state"), v: daemon === null ? "—" : <RunnerStateIndicator state={state} tone={tone} /> },
        { k: t("settings.runner.lastSeen"), v: daemon ? timeAgo(daemon.lastSeenAt) : "—" },
        { k: t("settings.runner.activeRuns"), v: daemon ? daemon.activeRuns : "—" },
        { k: t("settings.runner.version"), v: none(daemon?.daemonVersion) },
        { k: t("settings.runner.disk"), v: daemon ? <span data-low-disk={lowDisk ? "" : undefined} className={cn(lowDisk && "text-destructive")}>{disk(daemon.diskFreeBytes)}</span> : "—" },
        { k: t("settings.runner.poll"), v: daemon?.pollIntervalMs ? `${daemon.pollIntervalMs} ms` : "—" },
        { k: t("settings.runner.workspace"), v: none(daemon?.workspaceRoot) },
      ]} />
    </div>
  );
};

/**
 * One backend's telemetry, and whether this preview needs it.
 *
 * Codex is the only backend v0.1 requires (plan Step 6). Before this label
 * existed, a machine with no Claude CLI showed "Preflight passed: No, Circuit:
 * Open" beside a working installation, which reads as something broken that the
 * operator must go and fix. The telemetry stays — it is the truth about that
 * backend, and removing it would hide a real failure from anyone who does use
 * Claude or Pi — but it is now labelled with what it means here.
 */
const BackendDetails = ({ backend, runner }: { backend: BackendStatus | null; runner: RunnerKind }): ReactNode => {
  const t = useT();
  const required = runner === "CODEX";
  const failed = backend?.lastPreflightOk === false || backend?.circuitOpen === true;
  return (
    <div className="grid gap-[10px] border-t border-border pt-[12px] first:border-0 first:pt-0" data-backend={runner}>
      <div className="flex flex-wrap items-center gap-[8px]">
        <span className="font-bold">{t(`runner.cli.${runner}`)}</span>
        <span data-backend-role={required ? "required" : "optional"} className="rounded-md bg-accent px-[5px] py-[1px] text-[10px] font-normal">
          {t(required ? "settings.runner.required" : "settings.runner.optional")}
        </span>
      </div>
      {!required && failed ? <div className={HINT}>{t("settings.runner.optionalFailure")}</div> : null}
      <KeyValue columns={3} items={[
        { k: t("settings.runner.cliVersion"), v: none(backend?.cliVersion) },
        { k: t("settings.runner.authMode"), v: none(backend?.authMode) },
        { k: t("settings.runner.lastPreflight"), v: backend?.lastPreflightAt ? timeAgo(backend.lastPreflightAt) : "—" },
        { k: t("settings.runner.preflight"), v: backend?.lastPreflightOk === null || backend?.lastPreflightOk === undefined ? "—" : t(backend.lastPreflightOk ? "common.yes" : "common.no") },
        { k: t("settings.runner.circuit"), v: backend?.circuitOpen === null || backend?.circuitOpen === undefined ? "—" : t(backend.circuitOpen ? "settings.runner.open" : "settings.runner.closed") },
        // The class, not the message. `circuitReason` is written from a fixed
        // set by the control plane; rendering it verbatim would make this card
        // the place an unbounded CLI line — an env var, a URL with a password —
        // surfaces, and this card is in every screenshot an operator sends.
        { k: t("settings.runner.reason"), v: backend?.circuitReason ? t(circuitReasonKey(backend.circuitReason)) : "—" },
      ]} />
    </div>
  );
};

/**
 * The build identity of the product itself, so a report can name the exact
 * commit that produced the behaviour being reported.
 *
 * This is not the runner card: `daemonVersion` and `cliVersion` describe the
 * machines and the backends, and quoting one of those for "which Anneal is
 * this" has already sent a report to the wrong commit. A failed `GET /version`
 * says so rather than falling back to a dash, which would read as a legitimate
 * unbuilt process; `unbuilt`/`unknown` come from the control plane itself and
 * are the truth about a process running from source.
 */
const BuildDetails = ({ version }: { version: Poll<VersionInfo> }): ReactNode => {
  const t = useT();
  if (fatal(version.error, version.data)) return <div data-build-state="error" className={NOTICE}>{t("settings.build.unavailable")}</div>;
  if (version.data === null) return <div data-build-state="loading" className={HINT}>{t("common.loading")}</div>;
  const build = version.data;
  return (
    <div data-build-state="ready" className="grid gap-[12px]">
      <KeyValue columns={3} items={[
        { k: t("settings.build.version"), v: none(build.version) },
        { k: t("settings.build.sha"), v: <code>{build.buildSha}</code> },
        { k: t("settings.build.commit"), v: build.commit ? <code>{build.commit}</code> : "—" },
        { k: t("settings.build.builtAt"), v: build.builtAt ? timeAgo(build.builtAt) : "—" },
      ]} />
      {build.stamped ? null : <div className={HINT}>{t("settings.build.unstamped")}</div>}
      {build.dirty ? <div className={HINT}>{t("settings.build.dirty")}</div> : null}
    </div>
  );
};

export const SettingsContent = ({ runners, health, version, freshnessNow = Date.now() }: { runners: Poll<RunnersResponse>; health: Poll<Health>; version: Poll<VersionInfo>; freshnessNow?: number }): ReactNode => {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const { mode, setMode } = useTheme();
  const daemons = [...(runners.data?.daemons ?? [])].sort((left, right) => left.runnerId.localeCompare(right.runnerId));
  const summary = runners.error ? { state: "unknown" } as const : runnerSummary(runners.data, new Date(freshnessNow));
  const stale = summary.state === "unknown";
  const healthState = health.error ? t("settings.control.unreachable") : health.data ? t(health.data.status === "ok" ? "settings.control.ok" : "settings.control.degraded") : "—";
  return (
    <Page>
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("settings.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>{t("settings.subtitle")}</div>
        </div>
      </div>
      <div className="grid gap-[14px]">
        <Card title={t("settings.appearance.title")}>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-[18px]">
            <Field label={t("settings.appearance.language")}>
              <Segmented value={locale} onChange={setLocale} options={[
                { value: "en", label: t("settings.appearance.language.en") },
                { value: "zh", label: t("settings.appearance.language.zh") },
              ]} />
            </Field>
            <Field label={t("settings.appearance.theme")}>
              <Segmented<ThemeMode> value={mode} onChange={setMode} options={[
                { value: "system", label: t("settings.appearance.theme.system") },
                { value: "light", label: t("settings.appearance.theme.light") },
                { value: "dark", label: t("settings.appearance.theme.dark") },
              ]} />
            </Field>
          </div>
        </Card>
        <Card title={t("settings.runner.title")}>
          <div className="grid gap-[16px]">
            <div className={NOTICE}>
              <CodexReadinessNotice readiness={codexReady(runners.data, new Date(freshnessNow))} />
            </div>
            <div className={HINT}>{t("settings.runner.starterIsCodex")}</div>
            <div className={HINT}>{t("settings.runner.seedWarning")}</div>
            <div className={HINT}>{t("settings.runner.restartWarning")}</div>
            <div className="grid gap-[14px]">
              {daemons.length > 0 ? daemons.map((daemon) => <DaemonDetails key={daemon.runnerId} daemon={daemon} stale={stale} />) : <DaemonDetails daemon={null} stale={stale} />}
            </div>
            <div className="grid gap-[14px] border-t border-border pt-[14px]">
              {RUNNERS.map((runner) => <BackendDetails key={runner} runner={runner} backend={runners.data?.backends.find((item) => item.runner === runner) ?? null} />)}
            </div>
          </div>
        </Card>
        <Card title={t("settings.build.title")}>
          <BuildDetails version={version} />
        </Card>
        <Card title={t("settings.control.title")}>
          <KeyValue items={[
            { k: t("settings.control.status"), v: healthState },
            { k: t("settings.control.apiBase"), v: <code>{apiBase}</code> },
            { k: t("settings.control.lastSuccess"), v: health.lastSuccessAt ? timeAgo(health.lastSuccessAt) : "—" },
          ]} />
        </Card>
      </div>
    </Page>
  );
};

export const SettingsPage = (): ReactNode => {
  const { runners, health, freshnessNow } = useRunners();
  // The build identity of a running process changes only when it restarts, so
  // this rides the slowest poll on the page rather than the heartbeat cadence.
  const version = usePoll<VersionInfo>("/version", 60_000);
  return <SettingsContent runners={runners} health={health} version={version} freshnessNow={freshnessNow} />;
};
