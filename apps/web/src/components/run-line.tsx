import type { ReactNode } from "react";

import { duration } from "../lib/format";
import { useT } from "../lib/i18n";
import { mergeBadge } from "../lib/merge-outcome";
import { isActiveRunStatus } from "../lib/board";
import type { BoardLatestRun, MergeOutcome, RunStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

export const DOT = "size-[7px] rounded-full bg-[color:var(--faint)]";
export const DOT_TONE = {
  on: "bg-[color:var(--status-green-fg)] shadow-[0_0_8px_color-mix(in_srgb,var(--status-green-fg)_55%,transparent)]",
  off: "bg-destructive",
  green: "bg-[color:var(--status-green-fg)]",
  amber: "bg-[color:var(--status-amber-fg)]",
  red: "bg-[color:var(--destructive-fg)]",
} as const;

type RunTone = "green" | "amber" | "red" | "grey" | "accent";
type RunPresentation = { tone: RunTone; key: string };

const PILL_TONE: Record<RunStatus, RunTone> = {
  QUEUED: "grey", CLAIMED: "amber", PROVISIONING: "amber", RUNNING: "amber", WAITING_INBOX: "accent",
  SUCCEEDED: "green", FAILED: "red", TIMED_OUT: "red", CANCELLED: "grey", LOST: "red",
};

const runPresentation = (
  status: RunStatus,
  mergeOutcome?: MergeOutcome | null | undefined,
): RunPresentation => {
  const badge = mergeBadge(mergeOutcome);
  return badge ?? { tone: PILL_TONE[status], key: `status.run.${status}` };
};

const dotTone = (status: RunStatus, mergeOutcome?: MergeOutcome | null | undefined): keyof typeof DOT_TONE => {
  const badge = mergeBadge(mergeOutcome);
  if (badge) return badge.tone;
  if (status === "SUCCEEDED") return "green";
  if (status === "FAILED" || status === "TIMED_OUT" || status === "LOST") return "red";
  return "amber";
};

/** The sole board rendering of a Run: number, dot tone, status word, and merge override. */
export const RunLine = ({
  run,
  mergeOutcome,
  showElapsed = false,
}: {
  run: BoardLatestRun;
  mergeOutcome?: MergeOutcome | null | undefined;
  showElapsed?: boolean;
}): ReactNode => {
  const t = useT();
  const presentation = runPresentation(run.status, mergeOutcome);
  const elapsed = showElapsed && isActiveRunStatus(run.status) && run.startedAt !== null
    ? t("tasks.card.runningDuration", { duration: duration(run.startedAt, null) })
    : null;
  return (
    <span data-run-line="" className="inline-flex min-w-0 items-center gap-[6px] whitespace-nowrap">
      <span className={cn(DOT, DOT_TONE[dotTone(run.status, mergeOutcome)])} />
      <span className="text-primary">{t("tasks.card.run", { n: run.runNumber })}</span>
      <span className="overflow-hidden text-ellipsis text-[color:var(--faint)]">
        {` · ${t(presentation.key)}${elapsed === null ? "" : ` · ${elapsed}`}`}
      </span>
    </span>
  );
};

/** The detail/list form crosses the same status-to-presentation seam as RunLine. */
export const RunPill = ({ status, mergeOutcome }: {
  status: RunStatus;
  mergeOutcome?: MergeOutcome | null | undefined;
}): ReactNode => {
  const t = useT();
  const presentation = runPresentation(status, mergeOutcome);
  return <Badge variant="outline" shape="pill" tone={presentation.tone}>{t(presentation.key)}</Badge>;
};
