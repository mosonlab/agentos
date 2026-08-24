import { type ReactNode, useState } from "react";

import { useT } from "../lib/i18n";
import { Link } from "../lib/router";
import type { Chain, ChainStep } from "../lib/types";
import { IconLock, IconUser } from "./icons";
import { COUNT, HINT, ROW, AgentChip, Card, Pill, TaskPill } from "./ui";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

/** E3: a chain long enough to bury the current step is a scrolling problem, not
 *  a data problem — so the tail is hidden behind one press rather than paged. */
export const CHAIN_PAGE = 50;

const STEP_ROW = "flex flex-wrap items-center gap-[10px] border-l-2 border-transparent px-[20px] py-[11px] text-[12.5px] [&+&]:border-t [&+&]:border-t-[color:var(--border-soft)]";
const STEP_ROW_HERE = "border-l-[color:var(--primary)] bg-accent";
const STEP_POSITION = "w-[18px] shrink-0 text-[11.5px] text-[color:var(--faint)]";

/** The gate's meaning, spelled out rather than implied by a glyph. Exported as the
 *  key rather than the sentence so the tooltip and the test that asserts it read
 *  the same dictionary entry. */
export const GATE_TITLE_KEY = "chain.gate";

const OWNER_CHIP = "inline-flex items-center gap-[6px] rounded-full border border-border bg-secondary px-[9px] py-[2px] text-[11.5px] leading-[19px] text-secondary-foreground";

export type ChainLayerGroup = {
  storedLayer: number;
  ordinal: number;
  steps: ChainStep[];
  blockers: ChainStep[];
};

/**
 * Render order is a node concern (`position`), while execution order is a
 * layer concern. The API normally supplies a stored layer, but falling back to
 * the node ordinal keeps a legacy/expand-migration response visibly linear.
 * The returned ordinal is dense so sparse, zero-based, and one-based storage
 * all have the same operator-facing numbering.
 */
export const chainLayerGroups = (steps: readonly ChainStep[]): ChainLayerGroup[] => {
  const effectiveLayer = (step: ChainStep): number => step.layer ?? step.chainIndex ?? step.position;
  const values = [...new Set(steps.map(effectiveLayer))].sort((left, right) => left - right);
  const ordinals = new Map(values.map((value, index) => [value, index + 1]));
  const byLayer = new Map<number, ChainStep[]>();
  for (const step of steps) {
    const layer = effectiveLayer(step);
    const group = byLayer.get(layer);
    if (group) group.push(step); else byLayer.set(layer, [step]);
  }
  const groups = values.map((storedLayer) => ({
    storedLayer,
    ordinal: ordinals.get(storedLayer) ?? 1,
    steps: [...(byLayer.get(storedLayer) ?? [])].sort((left, right) => (
      left.position - right.position || (left.chainIndex ?? 0) - (right.chainIndex ?? 0) || left.taskId.localeCompare(right.taskId)
    )),
    blockers: [] as ChainStep[],
  }));
  for (const [index, group] of groups.entries()) {
    const previous = groups[index - 1];
    // A linear predecessor is already communicated by the existing chain
    // ordering. The explicit join callout is for the new fan-in boundary, where
    // naming the unfinished parallel sibling makes the dependency visible.
    group.blockers = previous !== undefined && previous.steps.length > 1
      ? previous.steps.filter((step) => step.status !== "DONE")
      : [];
  }
  return groups;
};

export const ExecutionOwnerChip = ({ step }: { step: ChainStep }): ReactNode => {
  const t = useT();
  if (step.executionOwner === "human") {
    return <span data-execution-owner="human" aria-label={t("chain.humanAssignee")} className={OWNER_CHIP}><IconUser />{t("executionOwner.human")}</span>;
  }
  if (step.executionOwner === "control-plane" || step.executionOwner === "merge-executor") {
    return <span data-execution-owner={step.executionOwner} className={OWNER_CHIP}>{t(`executionOwner.${step.executionOwner}`)}</span>;
  }
  return <AgentChip agent={null} {...(step.agent ? { name: step.agent.title } : {})} />;
};

export const ChainRow = ({ step, here, pending, onStart }: {
  step: ChainStep;
  here: boolean;
  pending: boolean;
  onStart: (step: ChainStep) => void;
}): ReactNode => {
  const t = useT();
  const note = step.status === "BACKLOG" ? t("chain.parked") : step.failureReason;
  return (
    <div data-chain-node={step.taskId} className={cn(STEP_ROW, here && STEP_ROW_HERE)}>
      <span className={STEP_POSITION}>{step.position}</span>
      <span className="min-w-0 flex-1">
        <Link to={`/tasks/${step.taskId}`}>{step.stepName}</Link>
        {here ? <span className="ml-[8px] text-[11.5px] text-muted-foreground">{t("chain.viewedHere")}</span> : null}
        {step.currentExecution ? <span className="ml-[8px] text-[11.5px] text-muted-foreground">{t("chain.currentExecution")}</span> : null}
        {note ? <span className={cn(HINT, "mt-[3px] block")}>{note}</span> : null}
      </span>
      <ExecutionOwnerChip step={step} />
      {step.approvalGate ? <span title={t(GATE_TITLE_KEY)} className="text-muted-foreground"><IconLock /></span> : null}
      <TaskPill status={step.status} />
      {step.archivedAt === null ? null : <Pill tone="grey">{t("chain.archived")}</Pill>}
      {step.startAction ? (
        <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" disabled={pending} onClick={() => onStart(step)}>
          {t(step.startAction === "recover" ? "chain.recoverParked" : "chain.startNext")}
        </Button>
      ) : null}
    </div>
  );
};

/**
 * The chain the open task belongs to, in template-step order.
 *
 * The counts and `startable` come from the API verbatim — the card must not be
 * able to disagree with the board about how far along a chain is, nor with the
 * route about whether a step may be started.
 */
export const ChainList = ({ chain, taskId, pending, onStart }: {
  chain: Chain;
  taskId: string;
  pending: boolean;
  onStart: (step: ChainStep) => void;
}): ReactNode => {
  const [all, setAll] = useState(false);
  const t = useT();
  const shown = all ? chain.steps : chain.steps.slice(0, CHAIN_PAGE);
  const shownIds = new Set(shown.map((step) => step.taskId));
  const groups = chainLayerGroups(chain.steps).flatMap((group) => {
    const visibleSteps = group.steps.filter((step) => shownIds.has(step.taskId));
    return visibleSteps.length === 0 ? [] : [{ ...group, steps: visibleSteps }];
  });
  return (
    <Card title={t("chain.title")} extra={<span className={COUNT}>{t("chain.completed", { done: chain.done, total: chain.total })}</span>} flush>
      {groups.map((group) => (
        <section
          key={group.storedLayer}
          data-chain-layer={group.storedLayer}
          data-chain-layer-ordinal={group.ordinal}
          aria-label={t("chain.layer", { n: group.ordinal })}
        >
          <div className="flex flex-wrap items-center gap-[8px] border-t border-[color:var(--border-soft)] bg-secondary/40 px-[20px] py-[7px] text-[11.5px] text-muted-foreground first:border-t-0">
            <span className="font-medium text-secondary-foreground">{t("chain.layer", { n: group.ordinal })}</span>
            {group.steps.length > 1 ? <span data-chain-parallel="">{t("chain.parallel", { n: group.steps.length })}</span> : null}
            {group.blockers.length > 0 && group.steps.some((step) => step.status !== "DONE") ? (
              <span data-chain-join-blocked="">{t("chain.blockedBy", { names: group.blockers.map((step) => step.stepName).join(", ") })}</span>
            ) : null}
          </div>
          <div className={group.steps.length > 1 ? "grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))]" : undefined}>
            {group.steps.map((step) => (
              <ChainRow key={step.taskId} step={step} here={step.taskId === taskId} pending={pending} onStart={onStart} />
            ))}
          </div>
        </section>
      ))}
      {all || chain.steps.length <= CHAIN_PAGE ? null : (
        <div className={cn(ROW, "px-[20px] py-[11px]")}>
          <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" onClick={() => setAll(true)}>
            {t("chain.showAll", { n: chain.steps.length })}
          </Button>
        </div>
      )}
    </Card>
  );
};
