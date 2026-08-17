import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { usePoll, type Poll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { timeAgo } from "../lib/format";
import type { Health, RunnersResponse } from "../lib/types";
import { cn } from "../lib/utils";
import { DOT, DOT_TONE, RUNNER_ROW, RUNNER_STATE } from "./ui";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";

type RunnersContextValue = { runners: Poll<RunnersResponse>; health: Poll<Health>; freshnessNow: number };
const idlePoll = <T,>(): Poll<T> => ({ data: null, error: null, loading: false, missing: false, lastSuccessAt: null, reload: () => undefined });
const IDLE_CONTEXT: RunnersContextValue = { runners: idlePoll<RunnersResponse>(), health: idlePoll<Health>(), freshnessNow: 0 };
const RunnersContext = createContext<RunnersContextValue>(IDLE_CONTEXT);

const useFreshnessClock = (checkedAt: string | undefined): number => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const refresh = (): void => setNow(Date.now());
    refresh();
    document.addEventListener("visibilitychange", refresh);
    const checkedAtMs = checkedAt === undefined ? Number.NaN : Date.parse(checkedAt);
    const delay = Number.isFinite(checkedAtMs) ? Math.max(0, checkedAtMs + 60_001 - Date.now()) : 0;
    const timer = window.setTimeout(refresh, delay);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.clearTimeout(timer);
    };
  }, [checkedAt]);
  return now;
};

export const RunnersProvider = ({ children }: { children: ReactNode }): ReactNode => {
  const runners = usePoll<RunnersResponse>("/runners", 30_000);
  const health = usePoll<Health>("/health", 10_000);
  const freshnessNow = useFreshnessClock(runners.data?.checkedAt);
  return <RunnersContext.Provider value={{ runners, health, freshnessNow }}>{children}</RunnersContext.Provider>;
};

export const useRunners = (): RunnersContextValue => useContext(RunnersContext);

export type RunnerSummary = {
  state: "running" | "busy" | "offline" | "neverSeen" | "unknown";
  tone: "green" | "amber" | "grey";
};

export const runnerSummary = (payload: RunnersResponse | null, now: Date): RunnerSummary => {
  if (!payload || !Number.isFinite(Date.parse(payload.checkedAt)) || now.getTime() - Date.parse(payload.checkedAt) > 60_000) {
    return { state: "unknown", tone: "grey" };
  }
  if (payload.daemons.length === 0) return { state: "neverSeen", tone: "grey" };
  const online = payload.daemons.filter((daemon) => daemon.online);
  if (online.length === 0) return { state: "offline", tone: "grey" };
  return {
    state: online.some((daemon) => daemon.busy) ? "busy" : "running",
    tone: payload.backends.some((backend) => backend.circuitOpen) ? "amber" : "green",
  };
};

const diskLabel = (bytes: number | null): string => bytes === null ? "—" : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const runnerDot = (tone: RunnerSummary["tone"]): string | undefined => tone === "green" ? DOT_TONE.on : tone === "amber" ? DOT_TONE.amber : undefined;

export const RunnerStatusDetails = ({ payload, healthProblem = false, runnersProblem = false }: {
  payload: RunnersResponse | null;
  healthProblem?: boolean;
  runnersProblem?: boolean;
}): ReactNode => {
  const t = useT();
  const daemons = [...(payload?.daemons ?? [])].sort((left, right) => left.runnerId.localeCompare(right.runnerId));
  const backends = [...(payload?.backends ?? [])].sort((left, right) => left.runner.localeCompare(right.runner));
  return (
    <div className="grid gap-[12px] text-[11.5px] leading-[1.45]">
      <div>
        <div className="text-[13px] font-bold text-foreground">{t("runner.title")}</div>
        <div className="mt-[2px] text-muted-foreground">{t("runner.onlineCount", { n: payload?.online ?? 0, m: payload?.total ?? 0 })}</div>
      </div>
      {healthProblem ? <div className="text-destructive">{t("runner.healthProblem")}</div> : null}
      {runnersProblem ? <div className="text-destructive">{t("runner.dataProblem")}</div> : null}
      {daemons.length === 0 ? <div className="text-muted-foreground">{t("runner.neverSeenDetail")}</div> : daemons.map((daemon) => (
        <div key={daemon.runnerId} className="grid gap-[3px] border-t border-border pt-[9px]">
          <div className="flex items-center gap-[7px] font-bold text-foreground">
            <span className="min-w-0 overflow-hidden text-ellipsis">{daemon.runnerId}</span>
            {daemon.busy ? <span className="rounded-md bg-accent px-[5px] py-[1px] text-[10px] font-normal">{t("runner.state.busy")}</span> : null}
          </div>
          <div>{t("runner.lastHeartbeat", { at: timeAgo(daemon.lastSeenAt) })}</div>
          <div>{t("runner.daemonVersion", { version: daemon.daemonVersion ?? "—" })}</div>
          <div className={cn(daemon.diskFreeBytes !== null && daemon.diskFreeBytes < 2 * 1024 ** 3 && "text-destructive")}>{t("runner.diskFree", { amount: diskLabel(daemon.diskFreeBytes) })}</div>
        </div>
      ))}
      <div className="grid gap-[3px] border-t border-border pt-[9px]">
        {backends.map((backend) => (
          <div key={backend.runner}>
            <div>{t("runner.cliVersion", { runner: t(`runner.cli.${backend.runner}`), version: backend.cliVersion ?? "—" })}</div>
            {backend.circuitOpen ? <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[color:var(--status-amber-fg)]" title={backend.circuitReason ?? undefined}>{backend.circuitReason ?? t("runner.circuitOpen")}</div> : null}
          </div>
        ))}
      </div>
      <div className="border-t border-border pt-[9px] text-[color:var(--faint)]">{t("runner.refreshes")}</div>
    </div>
  );
};

export const RunnerRow = (): ReactNode => {
  const { runners, health, freshnessNow } = useRunners();
  const t = useT();
  const summary = runners.error ? { state: "unknown", tone: "grey" } as const : runnerSummary(runners.data, new Date(freshnessNow));
  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button type="button" className={cn(RUNNER_ROW, "w-full border-0 bg-transparent text-left") }>
          <span className={cn(DOT, runnerDot(summary.tone))} />
          {t("runner.row")}
          <span className={RUNNER_STATE}>{t(`runner.state.${summary.state}`)}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="right" align="end" sideOffset={8} className="w-[290px] rounded-lg p-[14px] font-mono">
        <RunnerStatusDetails
          payload={runners.data}
          healthProblem={health.error !== null || (health.data !== null && health.data.status !== "ok")}
          runnersProblem={runners.error !== null}
        />
      </HoverCardContent>
    </HoverCard>
  );
};
