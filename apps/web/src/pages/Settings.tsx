import type { ReactNode } from "react";

import { useRunners } from "../components/runner-status";
import {
  Card, Field, HINT, KeyValue, PAGE_HEAD, PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, Page, Segmented,
} from "../components/ui";
import { apiBase } from "../lib/api";
import { timeAgo } from "../lib/format";
import type { Poll } from "../lib/hooks";
import { useLocale, useT } from "../lib/i18n";
import { useTheme, type ThemeMode } from "../lib/theme";
import type { BackendStatus, DaemonStatus, Health, RunnerKind, RunnersResponse } from "../lib/types";

const RUNNERS: RunnerKind[] = ["CLAUDE", "CODEX", "PI"];
const none = (value: string | null | undefined): string => value && value.length > 0 ? value : "—";
const disk = (value: number | null): string => value === null ? "—" : `${(value / 1024 ** 3).toFixed(1)} GB`;

const DaemonDetails = ({ daemon }: { daemon: DaemonStatus | null }): ReactNode => {
  const t = useT();
  const state = daemon === null ? "—" : t(daemon.online ? (daemon.busy ? "runner.state.busy" : "runner.state.running") : "runner.state.offline");
  return (
    <div className="grid gap-[10px] border-t border-border pt-[12px] first:border-0 first:pt-0">
      <div className="font-bold">{daemon?.runnerId ?? t("settings.runner.daemon")}</div>
      <KeyValue columns={3} items={[
        { k: t("settings.runner.state"), v: state },
        { k: t("settings.runner.lastSeen"), v: daemon ? timeAgo(daemon.lastSeenAt) : "—" },
        { k: t("settings.runner.activeRuns"), v: daemon ? daemon.activeRuns : "—" },
        { k: t("settings.runner.version"), v: none(daemon?.daemonVersion) },
        { k: t("settings.runner.disk"), v: daemon ? disk(daemon.diskFreeBytes) : "—" },
        { k: t("settings.runner.poll"), v: daemon?.pollIntervalMs ? `${daemon.pollIntervalMs} ms` : "—" },
        { k: t("settings.runner.workspace"), v: none(daemon?.workspaceRoot) },
      ]} />
    </div>
  );
};

const BackendDetails = ({ backend, runner }: { backend: BackendStatus | null; runner: RunnerKind }): ReactNode => {
  const t = useT();
  return (
    <div className="grid gap-[10px] border-t border-border pt-[12px] first:border-0 first:pt-0">
      <div className="font-bold">{t(`runner.cli.${runner}`)}</div>
      <KeyValue columns={3} items={[
        { k: t("settings.runner.cliVersion"), v: none(backend?.cliVersion) },
        { k: t("settings.runner.authMode"), v: none(backend?.authMode) },
        { k: t("settings.runner.lastPreflight"), v: backend?.lastPreflightAt ? timeAgo(backend.lastPreflightAt) : "—" },
        { k: t("settings.runner.preflight"), v: backend?.lastPreflightOk === null || backend?.lastPreflightOk === undefined ? "—" : t(backend.lastPreflightOk ? "common.yes" : "common.no") },
        { k: t("settings.runner.circuit"), v: backend?.circuitOpen === null || backend?.circuitOpen === undefined ? "—" : t(backend.circuitOpen ? "settings.runner.open" : "settings.runner.closed") },
        { k: t("settings.runner.reason"), v: none(backend?.circuitReason) },
      ]} />
    </div>
  );
};

export const SettingsContent = ({ runners, health }: { runners: Poll<RunnersResponse>; health: Poll<Health> }): ReactNode => {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const { mode, setMode } = useTheme();
  const daemons = [...(runners.data?.daemons ?? [])].sort((left, right) => left.runnerId.localeCompare(right.runnerId));
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
            <div className={HINT}>{t("settings.runner.seedWarning")}</div>
            <div className={HINT}>{t("settings.runner.restartWarning")}</div>
            <div className="grid gap-[14px]">
              {daemons.length > 0 ? daemons.map((daemon) => <DaemonDetails key={daemon.runnerId} daemon={daemon} />) : <DaemonDetails daemon={null} />}
            </div>
            <div className="grid gap-[14px] border-t border-border pt-[14px]">
              {RUNNERS.map((runner) => <BackendDetails key={runner} runner={runner} backend={runners.data?.backends.find((item) => item.runner === runner) ?? null} />)}
            </div>
          </div>
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
  const { runners, health } = useRunners();
  return <SettingsContent runners={runners} health={health} />;
};
