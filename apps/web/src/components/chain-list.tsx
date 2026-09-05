import { type ReactNode, useEffect, useState } from "react";

import { compare, denseOrdinals, layerOf } from "@anneal/db/chain-order";
import { gateToggleRefusal } from "@anneal/db/gate-toggle";

import { sha, titleCase } from "../lib/format";
import { useT } from "../lib/i18n";
import { agentOptionLabel } from "../lib/models";
import { parseRepairCycles, type RepairCycleViewModel } from "../lib/repair-subtimeline";
import { Link } from "../lib/router";
import type { Agent, Chain, ChainStep, TaskActivity } from "../lib/types";
import { IconLock, IconUser } from "./icons";
import { COUNT, HINT, ROW, ROW_WRAP, AgentChip, Card, ErrorNotice, Pill, TaskPill, Toggle } from "./ui";
import { Button } from "./ui/button";
import { Select } from "./ui/select";
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

const REPAIR_TIMELINE = "mt-[10px] grid gap-[7px] border-l-2 border-[color:var(--border-soft)] pl-[12px]";
const REPAIR_CYCLE = "grid gap-[3px] text-[11.5px] leading-[1.45] text-[color:var(--faint)]";
const KNOWN_REPAIR_OUTCOMES = new Set(["failed", "invalid-output", "pending", "succeeded", "unknown"]);

const repairOutcome = (cycle: RepairCycleViewModel, t: ReturnType<typeof useT>): string => {
  return KNOWN_REPAIR_OUTCOMES.has(cycle.outcome)
    ? t(`chain.repair.outcome.${cycle.outcome}`)
    : titleCase(cycle.outcome);
};

/** Presentation-only history for the repair tasks a Regression step spawned.
 * The parser pairs markers by repairTaskId; this component only renders the
 * resulting ordered view models and never mutates chain state. */
export const RepairTimeline = ({ cycles, loading = false, error = null, onRetry }: {
  cycles: readonly RepairCycleViewModel[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}): ReactNode => {
  const t = useT();
  if (cycles.length === 0 && !loading && error === null) return null;
  return (
    <div data-repair-timeline="" aria-label={t("chain.repair.title")} className={REPAIR_TIMELINE}>
      <div className="text-[11.5px] font-bold text-secondary-foreground">{t("chain.repair.title")}</div>
      {loading ? <div data-repair-loading="" className={HINT}>{t("chain.repair.loading")}</div> : null}
      {error === null ? null : (
        <div data-repair-error=""><ErrorNotice message={t("chain.repair.error")} {...(onRetry ? { onRetry } : {})} /></div>
      )}
      {cycles.map((cycle) => (
        <div key={cycle.repairTaskId} data-repair-cycle={cycle.ordinal} className={REPAIR_CYCLE}>
          <div className="flex flex-wrap items-center gap-[7px]">
            <span data-repair-ordinal="" className="font-bold text-secondary-foreground">{t("chain.repair.ordinal", { n: cycle.ordinal })}</span>
            <span data-repair-kind="" className="text-secondary-foreground">{t("chain.repair.kind")}: {cycle.repairKind}</span>
            <span data-repair-heads="" className="font-mono">{t("chain.repair.heads")}: {sha(cycle.startHeadSha)} → {sha(cycle.endHeadSha)}</span>
            <span data-repair-outcome="">{t("chain.repair.outcome")}: {repairOutcome(cycle, t)}</span>
          </div>
          <Link to={cycle.taskHref} className="w-fit text-[11.5px] text-secondary-foreground hover:text-foreground">
            {t("chain.repair.task", { kind: cycle.repairKind })}
          </Link>
        </div>
      ))}
    </div>
  );
};

export type ChainLayerGroup = {
  storedLayer: number;
  ordinal: number;
  steps: ChainStep[];
  blockers: ChainStep[];
};

const chainStepOrder = (left: ChainStep, right: ChainStep): number => compare(
  { layer: left.layer, index: left.chainIndex, id: left.taskId },
  { layer: right.layer, index: right.chainIndex, id: right.taskId },
);

/** The held layer is stored in the same coordinate system as each Step's
 * `layer`; the API owns every per-Step barrier decision. */
export const chainHeldLayer = (chain: Pick<Chain, "control">): number | null => (
  chain.control?.state === "held" ? chain.control.heldLayer : null
);

/** A held Chain is waiting on its operator only after every Step in the held
 * layer is DONE and no active execution remains anywhere in the Chain. */
export const heldChainWaitingOnOperator = (chain: Chain): boolean => {
  const heldLayer = chainHeldLayer(chain);
  if (heldLayer === null) return false;
  if (heldLayer === 0) return chain.steps.every((step) => !step.currentExecution);
  const heldSteps = chainLayerGroups(chain.steps).find((group) => group.ordinal === heldLayer)?.steps ?? [];
  return heldSteps.length > 0
    && heldSteps.every((step) => step.status === "DONE" && !step.currentExecution)
    && chain.steps.every((step) => !step.currentExecution);
};

/**
 * Render order follows the same total execution order as the server surfaces.
 * The returned ordinal is dense so sparse, zero-based, and one-based storage
 * all have the same operator-facing numbering; missing execution metadata is
 * one final unknown layer rather than a layer invented from display position.
 */
export const chainLayerGroups = (steps: readonly ChainStep[]): ChainLayerGroup[] => {
  const ordinals = denseOrdinals(steps.map((step) => ({ layer: step.layer, index: step.chainIndex })));
  const byLayer = new Map<number, ChainStep[]>();
  for (const step of steps) {
    const layer = layerOf({ layer: step.layer, index: step.chainIndex }, { missing: "last" });
    const group = byLayer.get(layer);
    if (group) group.push(step); else byLayer.set(layer, [step]);
  }
  const groups = [...ordinals].map(([storedLayer, ordinal]) => ({
    storedLayer,
    ordinal,
    steps: [...(byLayer.get(storedLayer) ?? [])].sort(chainStepOrder),
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
  return <AgentChip agent={step.agent} />;
};

/** The Agent fields a staffing picker needs: who the role is, and what running
 *  it costs. `ChainStep.agent` and `TaskBase.assigneeAgent` both satisfy it. */
export type ReassignAgent = Pick<Agent, "id" | "title" | "model">;

/**
 * The staffing control for one Task, wherever it is rendered.
 *
 * The value is the server's until an operator changes it. `draft` then holds
 * that choice for exactly the round trip: the poll behind this control keeps
 * answering with the old assignee until the PATCH lands, and reseeding from it
 * meanwhile would snap the select back under the operator's finger. A refusal —
 * the 409 the route answers while a Run is live — drops the draft, so the
 * control never displays a change the control plane rejected.
 *
 * `reassignable` is the server's own fact (`ChainStep.reassignable`), and the
 * disabled state is a courtesy rather than the guard: the PATCH is what decides.
 */
export const ReassignSelect = ({ agents, current, reassignable, pending, label, lockedHint, onReassign }: {
  agents: readonly Agent[];
  current: ReassignAgent | null;
  reassignable: boolean;
  pending: boolean;
  label: string;
  lockedHint: string;
  onReassign: (assigneeAgentId: string) => Promise<boolean>;
}): ReactNode => {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const settled = current?.id ?? "";
  useEffect(() => {
    if (draft !== null && draft === settled) setDraft(null);
  }, [draft, settled]);
  // The merge sentinel and archived roles are not assignable; the Agent already
  // on the Task stays listed whatever it is, or the select would show a blank.
  const assignable = agents.filter((agent) => agent.archivedAt === null && agent.assignable !== false);
  const options: ReassignAgent[] = current !== null && !assignable.some((agent) => agent.id === current.id)
    ? [current, ...assignable]
    : assignable;
  const choose = (next: string): void => {
    if (next === settled) return;
    setDraft(next);
    void onReassign(next).then((ok) => { if (!ok) setDraft(null); });
  };
  return (
    <Select
      data-reassign-select=""
      className="w-[210px] max-w-full"
      aria-label={label}
      title={reassignable ? label : lockedHint}
      value={draft ?? settled}
      disabled={pending || !reassignable}
      onChange={(event) => choose(event.target.value)}
    >
      {current === null ? <option value="">{t("ui.chip.unassigned")}</option> : null}
      {options.map((agent) => <option key={agent.id} value={agent.id}>{agentOptionLabel(agent)}</option>)}
    </Select>
  );
};

export const ChainRow = ({
  step, here, pending, blockedBy, heldLayer, repairCycles = [], repairLoading = false,
  repairError = null, onReloadRepairActivities, onStart,
  onToggleGate, agents = [], onReassign,
}: {
  step: ChainStep;
  here: boolean;
  pending: boolean;
  blockedBy: readonly ChainStep[];
  heldLayer: number | null;
  repairCycles?: readonly RepairCycleViewModel[];
  repairLoading?: boolean;
  repairError?: string | null;
  onReloadRepairActivities?: () => void;
  onStart: (step: ChainStep) => void;
  onToggleGate?: (taskId: string, next: boolean) => void;
  agents?: readonly Agent[];
  onReassign?: (taskId: string, assigneeAgentId: string) => Promise<boolean>;
}): ReactNode => {
  const t = useT();
  const blockedOn = step.blockedOn;
  const note = step.status === "BACKLOG" ? t("chain.parked") : step.failureReason;
  const held = step.holdRefusal !== null;
  const showStart = step.startAction !== null || blockedOn !== null || held;
  const isGateSlot = step.gateSlot !== null && step.gateSlot !== undefined;
  const gateToggleDisabledReason = isGateSlot && step.status !== "TODO"
    ? gateToggleRefusal(step.gateSlot, step.status, {
      nonSlot: t("chain.gate.refusal.nonSlot"),
      pastTodo: (slot, status) => t("chain.gate.refusal.pastTodo", {
        slot: t(slot === "spec" ? "chain.gate.slotName.specification" : "chain.gate.slotName.merge"),
        status,
      }),
    })
    : null;
  const gateToggleLabel = step.gateSlot === "spec"
    ? t("chain.gate.specification")
    : t("chain.gate.merge");
  const gateToggleChange = step.status === "TODO" && onToggleGate !== undefined
    ? { onChange: (next: boolean) => onToggleGate(step.taskId, next) }
    : {};
  const staffable = onReassign !== undefined && step.executionOwner === "agent";
  return (
    <div data-chain-node={step.taskId} className={cn(STEP_ROW, here && STEP_ROW_HERE)}>
      <span className={STEP_POSITION}>{step.position}</span>
      <span className="min-w-0 flex-1">
        <Link to={`/tasks/${step.taskId}`}>{step.stepName}</Link>
        {here ? <span className="ml-[8px] text-[11.5px] text-muted-foreground">{t("chain.viewedHere")}</span> : null}
        {step.currentExecution ? <span className="ml-[8px] text-[11.5px] text-muted-foreground">{t("chain.currentExecution")}</span> : null}
        {note ? <span className={cn(HINT, "mt-[3px] block")}>{note}</span> : null}
        {held ? (
          <span data-chain-held-hint="" className={cn(HINT, "mt-[3px] block")}>
            {heldLayer === 0
              ? t("chain.startHeldBeforeFirstHint")
              : t("chain.startHeldHint", { n: heldLayer ?? "?" })}
          </span>
        ) : null}
        {blockedOn ? (
          <span data-chain-blocked-on="" className={cn(HINT, "mt-[3px] block")}>
            {t("chain.blockedOnPredecessor", { name: blockedOn.name })}
          </span>
        ) : null}
        <RepairTimeline cycles={repairCycles} loading={repairLoading} error={repairError}
          {...(onReloadRepairActivities ? { onRetry: onReloadRepairActivities } : {})} />
        {blockedBy.length > 0 && step.status !== "DONE" ? (
          <span data-chain-join-blocked="" className={cn(HINT, "mt-[3px] block")}>
            {t("chain.blockedBy", { names: blockedBy.map((blocker) => blocker.stepName).join(", ") })}
          </span>
        ) : null}
      </span>
      {/* Only agent-owned Steps get a picker: a human Step's owner is a person
          and the merge tail's Steps are bound to the mechanical sentinel, so
          neither has an Agent an operator may pick. Absent `onReassign` the card
          stays the read-only projection it was. Where the picker renders it
          already names the Agent and its model, so the chip would say the same
          thing twice; the chip stands in for it everywhere else. */}
      {staffable ? null : <ExecutionOwnerChip step={step} />}
      {!staffable ? null : (
        <ReassignSelect
          agents={agents}
          current={step.agent}
          reassignable={step.reassignable}
          pending={pending}
          label={t("chain.reassign.label")}
          lockedHint={t("chain.reassign.locked")}
          onReassign={(assigneeAgentId) => onReassign(step.taskId, assigneeAgentId)}
        />
      )}
      {isGateSlot ? (
        <Toggle
          on={step.approvalGate}
          {...gateToggleChange}
          disabled={pending || step.status !== "TODO"}
          label={gateToggleLabel}
          title={gateToggleDisabledReason ?? t(GATE_TITLE_KEY)}
        />
      ) : step.approvalGate ? (
        <span title={t(GATE_TITLE_KEY)} className="text-muted-foreground"><IconLock /></span>
      ) : null}
      <TaskPill status={step.status} />
      {step.archivedAt === null ? null : <Pill tone="grey">{t("chain.archived")}</Pill>}
      {showStart ? (
        <Button
          type="button"
          variant="legacy"
          size="legacySmall"
          className="shadow-none"
          disabled={pending || !step.startable || blockedOn !== null || held}
          onClick={() => onStart(step)}
        >
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
export const ChainList = ({
  chain, taskId, pending, regressionTaskId, repairActivities, repairActivitiesLoading = false,
  repairActivitiesError = null, onReloadRepairActivities, onStart, onControl,
  onToggleGate, agents = [], onReassign,
}: {
  chain: Chain;
  taskId: string;
  pending: boolean;
  regressionTaskId: string | null;
  repairActivities?: readonly TaskActivity[] | null;
  repairActivitiesLoading?: boolean;
  repairActivitiesError?: string | null;
  onReloadRepairActivities?: () => void;
  onStart: (step: ChainStep) => void;
  onControl?: () => void;
  onToggleGate?: (taskId: string, next: boolean) => void;
  agents?: readonly Agent[];
  onReassign?: (taskId: string, assigneeAgentId: string) => Promise<boolean>;
}): ReactNode => {
  const [all, setAll] = useState(false);
  const t = useT();
  const held = chain.control?.state === "held";
  const heldLayer = chainHeldLayer(chain);
  const waitingOnOperator = heldChainWaitingOnOperator(chain);
  const repairCycles = parseRepairCycles(repairActivities ?? []);
  const headerControl = (
    <div className={ROW_WRAP}>
      {held && heldLayer !== null ? (
        <span data-chain-held-badge=""><Pill tone="amber">
          {heldLayer === 0 ? t("chain.heldBeforeFirst") : t("chain.heldAfter", { n: heldLayer })}
        </Pill></span>
      ) : null}
      {held && chain.control?.holdReason ? (
        <span data-chain-hold-reason="" className={HINT}>{t("chain.holdReason", { reason: chain.control.holdReason })}</span>
      ) : null}
      <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" disabled={pending} onClick={() => onControl?.()}>
        {t(held ? "chain.resume" : "chain.stopAfterLayer")}
      </Button>
      <span className={COUNT}>{t("chain.completed", { done: chain.done, total: chain.total })}</span>
    </div>
  );
  const shown = all ? chain.steps : chain.steps.slice(0, CHAIN_PAGE);
  const shownIds = new Set(shown.map((step) => step.taskId));
  const groups = chainLayerGroups(chain.steps).flatMap((group) => {
    const visibleSteps = group.steps.filter((step) => shownIds.has(step.taskId));
    return visibleSteps.length === 0 ? [] : [{ ...group, steps: visibleSteps }];
  });
  return (
    <Card title={t("chain.title")} extra={headerControl} flush>
      {waitingOnOperator ? (
        <div data-chain-waiting-operator="" className={cn(HINT, "border-t border-[color:var(--border-soft)] px-[20px] py-[11px]")}>
          {t("chain.waitingOperator")}
        </div>
      ) : null}
      {groups.map((group) => (
        <section
          key={group.storedLayer}
          data-chain-layer={group.storedLayer}
          data-chain-layer-ordinal={group.ordinal}
          aria-label={t("chain.layer", { n: group.ordinal })}
          className={cn(
            "border-t border-[color:var(--border-soft)] first:border-t-0",
            group.steps.length > 1 ? "grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))]" : undefined,
          )}
        >
          {group.steps.map((step) => (
            <ChainRow
              key={step.taskId}
              step={step}
              here={step.taskId === taskId}
              pending={pending}
              blockedBy={group.blockers}
              heldLayer={heldLayer}
              repairCycles={step.taskId === regressionTaskId ? repairCycles : []}
              repairLoading={step.taskId === regressionTaskId && repairActivities === null && repairActivitiesLoading}
              repairError={step.taskId === regressionTaskId ? repairActivitiesError : null}
              {...(onReloadRepairActivities ? { onReloadRepairActivities } : {})}
              onStart={onStart}
              {...(onToggleGate ? { onToggleGate } : {})}
              agents={agents}
              {...(onReassign ? { onReassign } : {})}
            />
          ))}
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
