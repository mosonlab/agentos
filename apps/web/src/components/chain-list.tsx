import { type ReactNode, useState } from "react";

import { Link } from "../lib/router";
import type { Chain, ChainStep } from "../lib/types";
import { IconLock } from "./icons";
import { COUNT, HINT, ROW, AgentChip, Card, Pill, TaskPill } from "./ui";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

/** E3: a chain long enough to bury the current step is a scrolling problem, not
 *  a data problem — so the tail is hidden behind one press rather than paged. */
export const CHAIN_PAGE = 50;

const STEP_ROW = "flex flex-wrap items-center gap-[10px] border-l-2 border-transparent px-[20px] py-[11px] text-[12.5px] [&+&]:border-t [&+&]:border-t-[color:var(--border-soft)]";
const STEP_ROW_HERE = "border-l-[color:var(--primary)] bg-accent";
const STEP_POSITION = "w-[18px] shrink-0 text-[11.5px] text-[color:var(--faint)]";

/** The gate's meaning, spelled out rather than implied by a glyph. */
export const GATE_TITLE = "requires approval before unblocking dependents";

export const ChainRow = ({ step, here, pending, onStart }: {
  step: ChainStep;
  here: boolean;
  pending: boolean;
  onStart: (step: ChainStep) => void;
}): ReactNode => {
  const note = step.status === "BACKLOG" ? "Parked in Backlog" : step.failureReason;
  return (
    <div className={cn(STEP_ROW, here && STEP_ROW_HERE)}>
      <span className={STEP_POSITION}>{step.position}</span>
      <span className="min-w-0 flex-1">
        <Link to={`/tasks/${step.taskId}`}>{step.stepName}</Link>
        {here ? <span className="ml-[8px] text-[11.5px] text-muted-foreground">You are here</span> : null}
        {note ? <span className={cn(HINT, "mt-[3px] block")}>{note}</span> : null}
      </span>
      {/* `AgentChip` renders its Unassigned state when it has no label at all,
          which is exactly the case for an agent step with no agent. */}
      {step.assigneeType === "HUMAN"
        ? <AgentChip agent={null} name="Human" />
        : <AgentChip agent={null} {...(step.agent ? { name: step.agent.title } : {})} />}
      {step.approvalGate ? <span title={GATE_TITLE} className="text-muted-foreground"><IconLock /></span> : null}
      <TaskPill status={step.status} />
      {step.archivedAt === null ? null : <Pill tone="grey">archived</Pill>}
      {step.startable ? (
        <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" disabled={pending} onClick={() => onStart(step)}>
          Start now
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
  const shown = all ? chain.steps : chain.steps.slice(0, CHAIN_PAGE);
  return (
    <Card title="Chain" extra={<span className={COUNT}>{chain.done}/{chain.total}</span>} flush>
      {shown.map((step) => (
        <ChainRow key={step.taskId} step={step} here={step.taskId === taskId} pending={pending} onStart={onStart} />
      ))}
      {all || chain.steps.length <= CHAIN_PAGE ? null : (
        <div className={cn(ROW, "px-[20px] py-[11px]")}>
          <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" onClick={() => setAll(true)}>
            Show all {chain.steps.length} steps
          </Button>
        </div>
      )}
    </Card>
  );
};
