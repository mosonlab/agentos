import { type ReactNode, useState } from "react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card as ShadCard } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Switch } from "./ui/switch";
import { titleCase } from "../lib/format";
import { cn } from "../lib/utils";
import type { Agent, GoalStatus, InboxStatus, RunStatus, TaskStatus } from "../lib/types";
import { IconChevron, IconDots, IconRobot, IconUser } from "./icons";

/* ------------------------------------------------------------------ layout
 *
 * Shared class strings for the shapes that recur across pages, so a shape is
 * defined once rather than re-typed at each of its call sites.
 *
 * The breakpoint is written `[@media(max-width:900px)]:` rather than Tailwind's
 * `max-[900px]:`, which compiles to `not all and (min-width:900px)` and so stops
 * one pixel short of the retired `@media (max-width: 900px)` at a viewport of
 * exactly 900px.
 *
 * Pixel geometry is written as arbitrary utilities, not scale steps: `:root`
 * sets `font-size: 13px`, which makes Tailwind's spacing unit 3.25px, so `px-4`
 * would be 13px rather than the 16px the retired stylesheet used. Radii are the
 * exception — `--radius: 8px` and `--radius-card: 10px` feed `--radius-sm` (4px),
 * `--radius-md` (6px), `--radius-lg` (8px) and `--radius-xl` (10px) directly.
 */

export const PAGE = "max-w-[1240px] px-[34px] pt-[26px] pb-[80px] [@media(max-width:900px)]:px-[16px] [@media(max-width:900px)]:pt-[20px] [@media(max-width:900px)]:pb-[60px]";
export const STACK = "grid grid-cols-[minmax(0,1fr)] gap-[16px]";
export const ROW = "flex items-center gap-[10px]";
export const ROW_WRAP = "flex flex-wrap items-center gap-[8px]";

export const PAGE_HEAD = "mb-[18px] flex items-start gap-[20px]";
export const PAGE_HEAD_TITLES = "min-w-0 flex-1";
export const PAGE_HEAD_H1 = "text-[22px] tracking-[-.01em]";
export const PAGE_HEAD_SUBTITLE = "mt-[5px] text-[12.5px] text-muted-foreground";
export const PAGE_ACTIONS = "flex items-center gap-[9px]";
export const DETAIL_HEAD = "mb-[18px] flex items-center gap-[12px]";
export const DETAIL_HEAD_H1 = "text-[20px]";
export const BACK_LINK = "inline-flex items-center gap-[8px] text-[12.5px] text-muted-foreground hover:text-foreground";
export const TOOLBAR = "mb-[16px] flex items-center gap-[10px]";

/** `.fieldRow` — `align-items: start` keeps a hint-less control from stretching to
 *  the height of a neighbour that carries a hint line. */
export const FIELD = "grid grid-cols-[minmax(0,1fr)] gap-[6px]";
export const FIELD_LABEL = "text-[12.5px] text-secondary-foreground";
export const FIELD_ROW = "grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] items-start gap-[14px]";

/** The status dot and its tones, as a lookup rather than a built class string
 *  (plan B13). `.dot.on` carries a glow; `.dot.green` deliberately does not. */
export const DOT = "size-[7px] rounded-full bg-[color:var(--faint)]";
export const DOT_TONE = {
  on: "bg-[color:var(--status-green-fg)] shadow-[0_0_8px_color-mix(in_srgb,var(--status-green-fg)_55%,transparent)]",
  off: "bg-destructive",
  green: "bg-[color:var(--status-green-fg)]",
  amber: "bg-[color:var(--status-amber-fg)]",
  red: "bg-[color:var(--destructive-fg)]",
} as const;

export const CARD_TITLE = "mb-[14px] flex items-center gap-[9px] text-[13.5px]";
export const COUNT = "inline-grid h-[19px] min-w-[20px] place-items-center rounded-md bg-accent px-[6px] text-[11.5px] text-muted-foreground";
export const HINT = "text-[11.5px] leading-[1.5] text-[color:var(--faint)]";
export const METRICS = "grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-[14px]";
export const STAT_PILLS = "flex flex-wrap gap-[8px]";
export const STAT_PILL = "inline-flex items-center gap-[7px] rounded-lg border border-border bg-card px-[11px] py-[5px] text-[12px] text-secondary-foreground";
export const CODE_BLOCK = "max-h-[460px] overflow-auto rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--code-background)] px-[16px] py-[14px] text-[12px] leading-[1.65] whitespace-pre-wrap text-secondary-foreground [overflow-wrap:anywhere]";

export const TABLE_NAME = "font-bold text-foreground";
export const TABLE_SUB = "mt-[3px] block text-[11.5px] font-normal text-muted-foreground";
export const TABLE_TIGHT = "w-[1%] whitespace-nowrap";

/** The sidebar entry is one shape hosted on three different elements, so it is a
 *  string rather than a component; `.active` is applied at the call site. */
export const NAV_ITEM = "flex items-center gap-[11px] rounded-lg px-[10px] py-[8px] text-[13px] text-muted-foreground hover:bg-secondary hover:text-secondary-foreground [&_svg]:flex-none [&_svg]:opacity-85";
/** The hover pair is restated, not redundant: `.navItem.active` sits *after*
 *  `.navItem:hover` in the retired stylesheet and ties on specificity, so an
 *  active item keeps its own background and colour while hovered. Utilities
 *  have no such source-order guarantee — `hover:` beats the unprefixed form —
 *  so the active state has to win the hover explicitly. */
export const NAV_ITEM_ACTIVE = "bg-accent text-foreground hover:bg-accent hover:text-foreground";
export const NAV_COUNT = "ml-auto";
export const BADGE_COUNT = "inline-grid h-[18px] min-w-[20px] place-items-center rounded-full bg-destructive px-[6px] text-[11px] font-bold text-[color:var(--badge-foreground)]";

/* The three narrow-viewport rules come from the retired stylesheet's single
 * `@media (max-width: 900px)` block, which collapsed the sidebar into a wrapping
 * row across the top and hid its footer. `flex-flow: wrap` is a shorthand, so it
 * also reset `flex-direction` to `row` — hence `flex-row` alongside `flex-wrap`. */
export const SHELL = "grid min-h-screen grid-cols-[214px_minmax(0,1fr)] [@media(max-width:900px)]:grid-cols-[1fr]";
export const SIDEBAR = "sticky top-0 flex h-screen flex-col gap-[2px] overflow-y-auto border-r border-[color:var(--border-soft)] bg-sidebar px-[10px] pt-[10px] pb-[12px] [@media(max-width:900px)]:static [@media(max-width:900px)]:h-auto [@media(max-width:900px)]:flex-row [@media(max-width:900px)]:flex-wrap";
export const SIDEBAR_FOOT = "mt-auto grid gap-[2px] pt-[10px] [@media(max-width:900px)]:hidden";
export const PROJECT_SWITCHER = "flex w-full items-center gap-[9px] rounded-lg border border-transparent bg-transparent p-[8px] mb-[10px] text-left hover:bg-secondary";
export const PROJECT_MARK = "grid flex-none place-items-center size-[26px] rounded-[7px] bg-primary text-[12px] font-bold text-primary-foreground";
export const PROJECT_NAME = "min-w-0 flex-1 overflow-hidden text-[13px] text-ellipsis whitespace-nowrap";
export const CHEVRON = "flex-none text-[color:var(--faint)]";
export const RUNNER_ROW = "flex items-center gap-[10px] px-[10px] py-[8px] text-[12.5px] text-secondary-foreground whitespace-nowrap";
export const RUNNER_STATE = "ml-auto text-[11.5px] text-[color:var(--faint)]";
export const CONTENT = "min-w-0 bg-popover";

export const Page = ({ className, children }: { className?: string; children: ReactNode }): ReactNode => (
  <div className={cn(PAGE, className)}>{children}</div>
);

/* ------------------------------------------------------------------- pills */

export type PillTone = "green" | "amber" | "violet" | "red" | "grey" | "accent";

export const Pill = ({ tone, children }: { tone: PillTone; children: ReactNode }): ReactNode => (
  <Badge variant="outline" shape="pill" tone={tone}>{children}</Badge>
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

const CHIP = "inline-flex items-center gap-[6px] rounded-full border px-[9px] py-[2px] text-[11.5px] leading-[19px]";

/** Agents are first-class everywhere: same violet chip + robot glyph (ui-notes §"要点提炼" 3). */
export const AgentChip = ({ agent, name }: { agent?: Agent | null; name?: string }): ReactNode => {
  const label = agent?.title ?? agent?.name ?? name;
  if (!label) {
    return <span className={cn(CHIP, "border-border bg-secondary text-secondary-foreground")}><IconUser />Unassigned</span>;
  }
  return (
    <span className={cn(CHIP, "border-[color:var(--status-violet-line)] bg-[color:var(--status-violet-bg)] text-[color:var(--status-violet-fg)]")}>
      <IconRobot />{label}
    </span>
  );
};

/* ------------------------------------------------------------------- cards */

/** `border-border` is not redundant next to the primitive's `border`: Tailwind
 *  v4's preflight resets every element to `border: 0 solid` with no colour, so a
 *  width-only `border` utility paints in `currentColor`. The retired
 *  retired `.card` rule was supplying that colour with its own 1px border. */
export const Card = ({ title, extra, children, flush }: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}): ReactNode => (
  <ShadCard className={cn("border-border", flush === true ? "px-0 pt-[18px] pb-0" : "px-[20px] py-[18px]")}>
    {title !== undefined && (
      <div className={cn(CARD_TITLE, flush === true && "px-[20px]")}>
        {title}
        <span className="flex-1" />
        {extra}
      </div>
    )}
    {children}
  </ShadCard>
);

export const KeyValue = ({ items, columns }: {
  items: Array<{ k: string; v: ReactNode }>;
  columns?: 2 | 3;
}): ReactNode => (
  <div className={cn(
    "grid gap-x-[40px] gap-y-[16px] [&>div]:min-w-0",
    columns === 3 ? "grid-cols-[repeat(3,minmax(0,1fr))]" : "grid-cols-[repeat(2,minmax(0,1fr))]",
  )}>
    {items.map((item) => (
      <div key={item.k}>
        <div className="text-[12px] text-muted-foreground">{item.k}</div>
        <div className="mt-[3px] text-[13px] [overflow-wrap:anywhere]">{item.v}</div>
      </div>
    ))}
  </div>
);

export const Metric = ({ label, value }: { label: string; value: ReactNode }): ReactNode => (
  <div className="rounded-xl border border-border bg-card px-[16px] py-[14px]">
    <div className="text-[12px] text-muted-foreground">{label}</div>
    <div className="mt-[6px] text-[15px] font-bold">{value}</div>
  </div>
);

/* ---------------------------------------------------------------- controls */

/** `.segmented button:hover` and `.segmented button.on` had equal specificity,
 *  and `.on` came second — so the selected button did not react to hover. As
 *  utilities the hover variant would sort last and win, so the hover colour is
 *  attached to the unselected buttons only. */
const SEGMENTED_BUTTON = "rounded-[7px] border-0 bg-transparent px-[13px] py-[6px] text-[12.5px]";

export const Segmented = <T extends string>({ options, value, onChange, accent }: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  accent?: boolean;
}): ReactNode => (
  <div className="inline-flex gap-[3px] rounded-[9px] border border-[color:var(--border-soft)] bg-card p-[3px]">
    {options.map((option) => (
      <button
        type="button"
        key={option.value}
        className={cn(
          SEGMENTED_BUTTON,
          option.value !== value && "text-muted-foreground hover:text-secondary-foreground",
          option.value === value && (accent === true
            ? "bg-primary font-bold text-primary-foreground"
            : "bg-accent text-foreground"),
        )}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </button>
    ))}
  </div>
);

/** `.tabs button` had no hover rule, unlike `.segmented button`. */
const TABS_BUTTON = "rounded-[7px] border-0 bg-transparent px-[14px] py-[7px] text-[12.5px] whitespace-nowrap";

export const Tabs = <T extends string>({ options, value, onChange }: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}): ReactNode => (
  <div className="mb-[16px] flex w-fit max-w-full gap-[3px] overflow-x-auto rounded-[9px] border border-[color:var(--border-soft)] bg-card p-[3px]">
    {options.map((option) => (
      <button
        type="button"
        key={option.value}
        className={cn(TABS_BUTTON, option.value === value ? "bg-accent text-foreground" : "text-muted-foreground")}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </button>
    ))}
  </div>
);

/** The knob the operator sees was `.toggle::after`, drawn while the real Radix
 *  thumb was hidden. Deleting the legacy rule would delete the knob, so the thumb
 *  is un-hidden and resized instead. `border-[3px] border-transparent` reproduces
 *  the 3px inset: the track background paints under a transparent border, so the
 *  pill still measures 38x21 while the thumb sits in a 32x15 content box that
 *  `items-center` centres vertically. `[&>span]:…` selectors are (0,1,1)/(0,2,1)
 *  and so outrank the thumb's own (0,1,0)/(0,2,0) classes inside the utilities
 *  layer. The root keeps the primitive's `shadow-sm` — nothing unlayered ever set
 *  box-shadow on `.toggle`, so it renders today — while the thumb takes
 *  `shadow-none`, because a hidden element's `shadow-lg` has never rendered and
 *  un-hiding it must not introduce one. */
export const Toggle = ({ on, onChange, disabled, label }: {
  on: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}): ReactNode => (
  <Switch
    checked={on}
    aria-label={label}
    className={cn(
      "relative h-[21px] w-[38px] flex-none rounded-full border-[3px] border-transparent p-0 duration-[140ms]",
      "data-[state=unchecked]:bg-[color:var(--toggle-background)] data-[state=checked]:bg-primary",
      "[&>span]:size-[15px] [&>span]:rounded-full [&>span]:bg-[color:var(--toggle-knob)] [&>span]:shadow-none [&>span]:duration-[140ms]",
      "[&>span]:data-[state=checked]:bg-[color:var(--toggle-knob-active)]",
      "[&>span]:data-[state=checked]:translate-x-[17px] [&>span]:data-[state=unchecked]:translate-x-0",
    )}
    disabled={disabled === true || onChange === undefined}
    {...(onChange === undefined ? {} : { onCheckedChange: onChange })}
  />
);

/** The primitive already carries `data-[state=checked]:bg-primary`, so only the
 *  resting colours, the 17px box and the checked border need restating. Its
 *  `shadow` stays: `.check` never set box-shadow, so that shadow renders today. */
export const Check = ({ on, onChange, disabled, label }: {
  on: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}): ReactNode => (
  <Checkbox
    checked={on}
    aria-label={label}
    className={cn(
      "size-[17px] flex-none place-items-center rounded-sm border-[color:var(--check-border)] bg-secondary p-0 text-primary-foreground",
      "data-[state=checked]:border-primary",
    )}
    disabled={disabled === true || onChange === undefined}
    onCheckedChange={(checked) => onChange?.(checked === true)}
  />
);

/* ---------------------------------------------------------------- notices */

export const EmptyState = ({ children }: { children: ReactNode }): ReactNode =>
  <div className="px-[10px] py-[40px] text-center text-[12.5px] text-[color:var(--faint)]">{children}</div>;

export const NOTICE = "flex gap-[10px] rounded-lg border border-border bg-card px-[14px] py-[11px] text-[12px] leading-[1.6] text-muted-foreground [&_code]:text-inherit [&_code]:opacity-90";
const NOTICE_GAP = "border-[color:var(--status-amber-line)] bg-[color-mix(in_srgb,var(--status-amber-fg)_5%,transparent)] text-[color:var(--status-amber-fg)]";
const NOTICE_ERROR = "border-[color:var(--destructive-line)] bg-[color:var(--destructive-bg)] text-[color:var(--destructive-fg)]";

/** Rendered whenever the control plane has no endpoint for a v1 surface. The
 *  page still renders so the gap is visible instead of silently missing. */
export const GapNotice = ({ endpoint, what }: { endpoint: string; what: string }): ReactNode => (
  <div className={cn(NOTICE, NOTICE_GAP)}>
    <span>
      控制面尚无 <code>{endpoint}</code>，{what}暂无数据来源。页面按真实空响应渲染，端点上线后自动生效。
    </span>
  </div>
);

/** `NOTICE` is a flex row, so the wrapper decides the layout: each element child
 *  and each contiguous text run of a bare fragment is its own flex item with a
 *  10px gap, where a single `<span>` is one item and reflows as a paragraph.
 *  The baseline took `message: string` in a `<span>`; this batch widened it to
 *  `ReactNode` so App.tsx's rich banner could route through it, and that banner
 *  laid out 9 flex items unwrapped at 3f712b5. Both shapes are preserved by
 *  wrapping only what was a string. */
export const ErrorNotice = ({ message, onRetry }: { message: ReactNode; onRetry?: () => void }): ReactNode => (
  <div className={cn(NOTICE, NOTICE_ERROR)}>
    {typeof message === "string" ? <span>{message}</span> : message}
    {onRetry ? (
      <>
        <span className="flex-1" />
        {/* `shadow-none`: `.btn small` on a bare <button> never picked up the
            primitive's shadow, and R-1 keeps the appearance identical. */}
        <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" onClick={onRetry}>Retry</Button>
      </>
    ) : null}
  </div>
);

/** The message card is shared by the Inbox thread and the Goals progress log.
 *  `.msgCard + .msgCard`'s 12px is applied per call site, because in the progress
 *  log the first card follows a form rather than another card. */
export const MSG_CARD = "rounded-xl border border-border bg-card px-[18px] py-[14px]";
export const MSG_HEAD = "mb-[10px] flex items-center gap-[8px] text-[12.5px] text-secondary-foreground";
export const MSG_TIME = "ml-auto text-[11.5px] text-[color:var(--faint)]";

export const LONG_TEXT = "text-[12.5px] leading-[1.75] whitespace-pre-wrap text-secondary-foreground [overflow-wrap:anywhere]";

export const ShowMore = ({ text, lines = 6 }: { text: string; lines?: number }): ReactNode => {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > 480;
  return (
    <div>
      {/* The clamp height stays an inline style: it is driven by the `lines`
          prop, so it is data, not a cascade escape hatch. */}
      <div
        className={cn(LONG_TEXT, !open && long && "overflow-hidden [-webkit-box-orient:vertical] [display:-webkit-box]")}
        style={open ? {} : { WebkitLineClamp: lines }}
      >
        {text}
      </div>
      {long ? (
        <button
          type="button"
          className="mt-[10px] inline-flex items-center gap-[6px] border-0 bg-transparent p-0 text-[12px] text-muted-foreground hover:text-foreground"
          onClick={() => setOpen(!open)}
        >
          <IconChevron open={open} />{open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
};

export const RowMenu = ({ items }: { items: Array<{ label: string; danger?: boolean; onSelect: () => void }> }): ReactNode => {
  return (
    <DropdownMenu>
      <span className="relative" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="icon" size="legacyIcon" aria-label="More actions"><IconDots /></Button>
        </DropdownMenuTrigger>
      </span>
      <DropdownMenuContent align="end" className="min-w-32 border-border bg-popover font-mono text-popover-foreground" onClick={(event) => event.stopPropagation()}>
        {items.map((item) => (
          <DropdownMenuItem key={item.label} className={item.danger === true ? "text-destructive focus:bg-destructive/10 focus:text-destructive" : "focus:bg-accent focus:text-accent-foreground"} onSelect={item.onSelect}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/* --------------------------------------------------------------- markdown */

const MD_CODE = "rounded-sm bg-[color:var(--code-background)] px-[5px] py-[1px] text-[11.5px] text-primary";
const MD_PARAGRAPH = "mb-[10px] [overflow-wrap:anywhere]";
/** `list-disc` / `list-decimal` as utilities rather than a descendant rule:
 *  Tailwind's preflight resets `ol, ul, menu` to `list-style: none` in
 *  `@layer base`, and a utility outranks a base rule by layer order. */
const MD_LIST = "mb-[10px] pl-[22px]";

const inline = (text: string, keyPrefix: string): ReactNode[] =>
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((part) => part.length > 0).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={key} className="text-foreground">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={key} className={MD_CODE}>{part.slice(1, -1)}</code>;
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
      ? <ol key={`b${blocks.length}`} className={cn(MD_LIST, "list-decimal")}>{items.map((item, index) => <li key={index} className="my-[3px]">{inline(item, `l${index}`)}</li>)}</ol>
      : <ul key={`b${blocks.length}`} className={cn(MD_LIST, "list-disc")}>{items.map((item, index) => <li key={index} className="my-[3px]">{inline(item, `l${index}`)}</li>)}</ul>);
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
    if (heading) blocks.push(<p key={`b${blocks.length}`} className={MD_PARAGRAPH}><strong className="text-foreground">{heading[1]}</strong></p>);
    else if (line.trim().length > 0) blocks.push(<p key={`b${blocks.length}`} className={MD_PARAGRAPH}>{inline(line, `p${blocks.length}`)}</p>);
  }
  flush();
  return <div className="text-[12.5px] leading-[1.75] text-secondary-foreground [&>*:last-child]:mb-0">{blocks}</div>;
};

export const Label = ({ value }: { value: string }): ReactNode => <span className="text-muted-foreground">{titleCase(value)}</span>;

/* --------------------------------------------------------------- overlays */

/** Centred modal — the reference UI reserves it for short confirmations
 *  (`adjust-limits-modal-t1275.jpg`); long forms use FullPanel instead.
 *  `sm:rounded-[12px]` restates the radius at the breakpoint so the primitive's
 *  `sm:rounded-lg` — which sorts after an unprefixed utility — cannot win. */
export const Modal = ({ title, onClose, children, footer }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}): ReactNode => (
  <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[86vh] w-[min(560px,100%)] max-w-none gap-0 overflow-y-auto rounded-[12px] border-border bg-card p-[22px] font-mono text-card-foreground shadow-[0_30px_90px_var(--modal-shadow)] sm:rounded-[12px]">
      {/* `font-bold leading-none` restores two properties W13 handed to the
          utilities. `h1,h2,h3,h4 { font-weight: 700 }` was unlayered, so it beat
          DialogTitle's `font-semibold`; in `@layer base` it loses, and the title
          drops to 600. And tailwind-merge treats a font-size utility as
          conflicting with `leading-*` — Tailwind v3 sized text set both — so
          CARD_TITLE's `text-[13.5px]` deletes the primitive's `leading-none`
          and the title grows from 13.5px to 20.25px. Measured on the New
          Project and New Secret dialogs. */}
      <DialogHeader><DialogTitle className={cn(CARD_TITLE, "font-bold leading-none")}>{title}</DialogTitle></DialogHeader>
      <div className={STACK}>{children}</div>
      {footer === undefined ? null : <DialogFooter className={cn(ROW, "mt-[18px] justify-end")}>{footer}</DialogFooter>}
    </DialogContent>
  </Dialog>
);

/** Full-bleed layer over the content area, matching `new-task-modal-blank-t0600.jpg`:
 *  the sidebar stays visible beside it, which is why it starts at 214px. */
export const FullPanel = ({ title, onClose, actions, children }: {
  title: string;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
}): ReactNode => (
  <div className="fixed inset-y-0 right-0 left-[214px] z-40 overflow-y-auto bg-popover [@media(max-width:900px)]:left-0">
    <div className="sticky top-0 z-[1] flex items-center gap-[12px] border-b border-[color:var(--border-soft)] bg-popover px-[34px] py-[16px] [@media(max-width:900px)]:px-[16px]">
      <h1 className="text-[16px]">{title}</h1>
      <span className="flex-1" />
      <Button type="button" variant="legacy" size="legacy" className="shadow-none" onClick={onClose}>Cancel</Button>
      {actions}
    </div>
    <div className={cn(STACK, "max-w-[1020px] px-[34px] pt-[24px] pb-[80px] [@media(max-width:900px)]:px-[16px]")}>{children}</div>
  </div>
);

export const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactNode => (
  <div className={FIELD}>
    <label className={FIELD_LABEL}>{label}</label>
    {children}
    {hint === undefined ? null : <div className={HINT}>{hint}</div>}
  </div>
);
