import { type ReactNode, useState } from "react";

import { useDismiss } from "../lib/hooks";
import { titleCase } from "../lib/format";
import type { Agent, GoalStatus, InboxStatus, RunStatus, TaskStatus } from "../lib/types";
import { IconChevron, IconDots, IconRobot, IconUser } from "./icons";

export type PillTone = "green" | "amber" | "violet" | "red" | "grey" | "accent";

export const Pill = ({ tone, children }: { tone: PillTone; children: ReactNode }): ReactNode => (
  <span className={`pill ${tone}`}>{children}</span>
);

/** Status semantics follow ui-notes §0: green = succeeded, amber = a human or a
 *  runner is still owed something, red = danger, grey = inert. */
const taskTones: Record<TaskStatus, PillTone> = { TODO: "grey", DOING: "amber", REVIEW: "accent", DONE: "green" };
const runTones: Record<RunStatus, PillTone> = {
  QUEUED: "grey", CLAIMED: "amber", PROVISIONING: "amber", RUNNING: "amber", WAITING_INBOX: "accent",
  SUCCEEDED: "green", FAILED: "red", TIMED_OUT: "red", CANCELLED: "grey", LOST: "red",
};
const goalTones: Record<GoalStatus, PillTone> = {
  ACTIVE: "amber", PAUSED: "grey", COMPLETED: "green",
  STOPPED_SPEND: "red", STOPPED_TIME: "red", STOPPED_STUCK: "red",
};
const inboxTones: Record<InboxStatus, PillTone> = { OPEN: "amber", ANSWERED: "green", CLOSED: "grey" };

export const TaskPill = ({ status }: { status: TaskStatus }): ReactNode =>
  <Pill tone={taskTones[status]}>{status.toLowerCase()}</Pill>;

export const RunPill = ({ status }: { status: RunStatus }): ReactNode =>
  <Pill tone={runTones[status]}>{status.toLowerCase().replace("_", " ")}</Pill>;

export const GoalPill = ({ status }: { status: GoalStatus }): ReactNode =>
  <Pill tone={goalTones[status]}>{status === "ACTIVE" ? "running" : status.toLowerCase().replace("_", " ")}</Pill>;

export const InboxPill = ({ status }: { status: InboxStatus }): ReactNode =>
  <Pill tone={inboxTones[status]}>{status === "OPEN" ? "Awaiting reply" : status.toLowerCase()}</Pill>;

/** Agents are first-class everywhere: same violet chip + robot glyph (ui-notes §"要点提炼" 3). */
export const AgentChip = ({ agent, name }: { agent?: Agent | null; name?: string }): ReactNode => {
  const label = agent?.title ?? agent?.name ?? name;
  if (!label) return <span className="chip human"><IconUser />Unassigned</span>;
  return <span className="chip"><IconRobot />{label}</span>;
};

export const Card = ({ title, extra, children, flush }: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}): ReactNode => (
  <section className={flush ? "card flush" : "card"}>
    {title !== undefined && (
      <div className="cardTitle">
        {title}
        <span className="spacer" />
        {extra}
      </div>
    )}
    {children}
  </section>
);

export const KeyValue = ({ items, columns }: {
  items: Array<{ k: string; v: ReactNode }>;
  columns?: 2 | 3;
}): ReactNode => (
  <div className={columns === 3 ? "kv three" : "kv"}>
    {items.map((item) => (
      <div key={item.k}>
        <div className="k">{item.k}</div>
        <div className="v">{item.v}</div>
      </div>
    ))}
  </div>
);

export const Metric = ({ label, value }: { label: string; value: ReactNode }): ReactNode => (
  <div className="metric"><div className="k">{label}</div><div className="v">{value}</div></div>
);

export const Segmented = <T extends string>({ options, value, onChange, accent }: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  accent?: boolean;
}): ReactNode => (
  <div className={accent ? "segmented accent" : "segmented"}>
    {options.map((option) => (
      <button key={option.value} type="button" className={option.value === value ? "on" : ""} onClick={() => onChange(option.value)}>
        {option.label}
      </button>
    ))}
  </div>
);

export const Tabs = <T extends string>({ options, value, onChange }: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}): ReactNode => (
  <div className="tabs">
    {options.map((option) => (
      <button key={option.value} type="button" className={option.value === value ? "on" : ""} onClick={() => onChange(option.value)}>
        {option.label}
      </button>
    ))}
  </div>
);

export const Toggle = ({ on, onChange, disabled, label }: {
  on: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}): ReactNode => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    className={on ? "toggle on" : "toggle"}
    disabled={disabled === true || onChange === undefined}
    onClick={() => onChange?.(!on)}
  />
);

export const Check = ({ on, onChange, disabled, label }: {
  on: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}): ReactNode => (
  <button
    type="button"
    role="checkbox"
    aria-checked={on}
    aria-label={label}
    className={on ? "check on" : "check"}
    disabled={disabled === true || onChange === undefined}
    onClick={() => onChange?.(!on)}
  >
    {on ? <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.4 6.4 11.6 13 4.8" /></svg> : null}
  </button>
);

export const EmptyState = ({ children }: { children: ReactNode }): ReactNode => <div className="empty">{children}</div>;

/** Rendered whenever the control plane has no endpoint for a v1 surface. The
 *  page still renders so the gap is visible instead of silently missing. */
export const GapNotice = ({ endpoint, what }: { endpoint: string; what: string }): ReactNode => (
  <div className="notice gap">
    <span>
      控制面尚无 <code>{endpoint}</code>，{what}暂无数据来源。页面按真实空响应渲染，端点上线后自动生效。
    </span>
  </div>
);

export const ErrorNotice = ({ message, onRetry }: { message: string; onRetry?: () => void }): ReactNode => (
  <div className="notice error">
    <span>{message}</span>
    {onRetry ? (<><span className="spacer" /><button type="button" className="btn small" onClick={onRetry}>Retry</button></>) : null}
  </div>
);

export const ShowMore = ({ text, lines = 6 }: { text: string; lines?: number }): ReactNode => {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > 480;
  return (
    <div>
      <div className={open || !long ? "longText" : "longText clamped"} style={open ? {} : { WebkitLineClamp: lines }}>{text}</div>
      {long ? (
        <button type="button" className="showMore" onClick={() => setOpen(!open)}>
          <IconChevron open={open} />{open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
};

export const RowMenu = ({ items }: { items: Array<{ label: string; danger?: boolean; onSelect: () => void }> }): ReactNode => {
  const [open, setOpen] = useState(false);
  useDismiss(() => setOpen(false), open);
  return (
    <span className="menuWrap" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="iconBtn" aria-label="More actions" onClick={() => setOpen(!open)}><IconDots /></button>
      {open ? (
        <span className="menu">
          {items.map((item) => (
            <button key={item.label} type="button" className={item.danger === true ? "danger" : ""}
              onClick={() => { setOpen(false); item.onSelect(); }}>
              {item.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
};

const inline = (text: string, keyPrefix: string): ReactNode[] =>
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((part) => part.length > 0).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
    return <span key={key}>{part}</span>;
  });

/** Agents write markdown into inbox bodies and progress logs; this covers the
 *  subset seen in the reference screenshots (headings, lists, bold, code). */
export const Markdown = ({ text }: { text: string }): ReactNode => {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = (): void => {
    if (!list) return;
    const { ordered, items } = list;
    blocks.push(ordered
      ? <ol key={`b${blocks.length}`}>{items.map((item, index) => <li key={index}>{inline(item, `l${index}`)}</li>)}</ol>
      : <ul key={`b${blocks.length}`}>{items.map((item, index) => <li key={index}>{inline(item, `l${index}`)}</li>)}</ul>);
    list = null;
  };
  for (const line of text.split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (bullet) {
      if (list && !list.ordered) list.items.push(bullet[1] ?? "");
      else { flush(); list = { ordered: false, items: [bullet[1] ?? ""] }; }
      continue;
    }
    if (ordered) {
      if (list?.ordered) list.items.push(ordered[1] ?? "");
      else { flush(); list = { ordered: true, items: [ordered[1] ?? ""] }; }
      continue;
    }
    flush();
    if (heading) blocks.push(<p key={`b${blocks.length}`}><strong>{heading[1]}</strong></p>);
    else if (line.trim().length > 0) blocks.push(<p key={`b${blocks.length}`}>{inline(line, `p${blocks.length}`)}</p>);
  }
  flush();
  return <div className="md">{blocks}</div>;
};

export const Label = ({ value }: { value: string }): ReactNode => <span className="dim">{titleCase(value)}</span>;

/** Centred modal — the reference UI reserves it for short confirmations
 *  (`adjust-limits-modal-t1275.jpg`); long forms use FullPanel instead. */
export const Modal = ({ title, onClose, children, footer }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}): ReactNode => (
  <div className="modalScrim" onMouseDown={onClose}>
    <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="cardTitle">{title}<span className="spacer" /><button type="button" className="iconBtn" onClick={onClose} aria-label="Close">✕</button></div>
      <div className="stack">{children}</div>
      {footer === undefined ? null : <div className="row" style={{ justifyContent: "flex-end", marginTop: 18 }}>{footer}</div>}
    </div>
  </div>
);

/** Full-bleed layer over the content area, matching `new-task-modal-blank-t0600.jpg`. */
export const FullPanel = ({ title, onClose, actions, children }: {
  title: string;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
}): ReactNode => (
  <div className="overlay">
    <div className="overlayHead">
      <h1 style={{ fontSize: 16 }}>{title}</h1>
      <span className="spacer" />
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      {actions}
    </div>
    <div className="overlayBody stack">{children}</div>
  </div>
);

export const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactNode => (
  <div className="field">
    <label>{label}</label>
    {children}
    {hint === undefined ? null : <div className="hint">{hint}</div>}
  </div>
);
