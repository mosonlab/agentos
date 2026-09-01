import type { ReactNode } from "react";

import { splitModel } from "@anneal/db/model-routing";

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

/** Cards name the model, not the route that reached it: an `openai-codex/`
 *  prefix repeats what the model name already says, and the card has no room to
 *  say it twice. The detail page keeps the full identifier. */
const cardModelName = (model: string): string => model.slice(model.lastIndexOf("/") + 1);

/** The sole board rendering of a Run: number, dot tone, status word, and merge override. */
export const RunLine = ({
  run,
  mergeOutcome,
  showElapsed = false,
  showModel = false,
  suppressRunningStatus = false,
}: {
  run: BoardLatestRun;
  mergeOutcome?: MergeOutcome | null | undefined;
  showElapsed?: boolean;
  /** Aggregate cards put the claimed model beside the run; task cards retain
   * their dedicated model row and leave this off. */
  showModel?: boolean;
  /** Task cards render a live RUNNING duration in their footer. */
  suppressRunningStatus?: boolean;
}): ReactNode => {
  const t = useT();
  const presentation = runPresentation(run.status, mergeOutcome);
  const elapsed = showElapsed && isActiveRunStatus(run.status) && run.startedAt !== null
    ? duration(run.startedAt, null)
    : null;
  const model = showModel ? splitModel(run.model) : null;
  const badge = mergeBadge(mergeOutcome);
  const hideStatus = run.status === "RUNNING"
    && badge === null
    && (elapsed !== null || suppressRunningStatus);
  const runDetailParts = [
    ...(model === null ? [] : [
      cardModelName(model.model),
      ...(model.effort === null ? [] : [model.effort]),
      ...(run.codexServiceTier === "FAST" ? ["fast"] : []),
    ]),
    // The dot already says a run is live, so a RUNNING row spends its width on
    // the elapsed time rather than on the word. Every other status still names
    // itself: nothing else on the row distinguishes queued from waiting inbox.
    ...(hideStatus ? [] : [t(presentation.key)]),
    ...(elapsed === null ? [] : [elapsed]),
  ];
  const runDetails = runDetailParts
    .map((part) => part.replaceAll(" ", "\u00a0"))
    .join(" · ");
  // The row's live values sit at the end of the details string, so truncating
  // it hid exactly what the row exists to show. Non-breaking spaces keep each
  // logical detail together so normal wrapping prefers the " · " separators;
  // [overflow-wrap:anywhere] catches a token wider than the column.
  return (
    <span data-run-line="" className="inline-flex min-w-0 flex-wrap items-center gap-x-[6px]">
      <span className="inline-flex flex-none items-center gap-[6px] whitespace-nowrap">
        <span className={cn(DOT, DOT_TONE[dotTone(run.status, mergeOutcome)])} />
        <span className="text-primary">{t("tasks.card.run", { n: run.runNumber })}</span>
      </span>
      {runDetails.length === 0 ? null : (
        <span data-run-line-details="" className="min-w-0 [overflow-wrap:anywhere] text-[color:var(--faint)]">
          {` · ${runDetails}`}
        </span>
      )}
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
