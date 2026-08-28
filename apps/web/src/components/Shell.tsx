import { type ReactNode, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { useProjectScope } from "../lib/project";
import { Link, navigate, useRoute } from "../lib/router";
import { initial } from "../lib/format";
import type { InboxSummary } from "../lib/types";
import { useTheme, type ThemeMode } from "../lib/theme";
import { cn } from "../lib/utils";
import {
  BADGE_COUNT, CHEVRON, CONTENT, COUNT, NAV_COUNT, NAV_ITEM, NAV_ITEM_ACTIVE,
  PROJECT_MARK, PROJECT_NAME, PROJECT_SWITCHER, SHELL, SIDEBAR, SIDEBAR_FOOT,
} from "./ui";
import { RunnerRow } from "./runner-status";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import {
  IconAgents, IconChevron, IconConnections, IconCosts, IconGoals, IconInbox,
  IconProjects, IconSecrets, IconSessions, IconSettings, IconTasks,
} from "./icons";

/** The table keeps its shape; only the label moves from a literal to a key, so a
 *  new nav entry still reads as one row. */
const NAV: Array<{ to: string; labelKey: string; icon: ReactNode; match: string[] }> = [
  { to: "/inbox", labelKey: "sidebar.nav.inbox", icon: <IconInbox />, match: ["/inbox"] },
  { to: "/tasks", labelKey: "sidebar.nav.tasks", icon: <IconTasks />, match: ["/tasks", "/automations", "/triggers", "/archived"] },
  { to: "/sessions", labelKey: "sidebar.nav.sessions", icon: <IconSessions />, match: ["/sessions"] },
  { to: "/costs", labelKey: "sidebar.nav.costs", icon: <IconCosts />, match: ["/costs"] },
  { to: "/goals", labelKey: "sidebar.nav.goals", icon: <IconGoals />, match: ["/goals"] },
  { to: "/agents", labelKey: "sidebar.nav.agents", icon: <IconAgents />, match: ["/agents"] },
  { to: "/projects", labelKey: "sidebar.nav.projects", icon: <IconProjects />, match: ["/projects", "/"] },
  { to: "/connections", labelKey: "sidebar.nav.connections", icon: <IconConnections />, match: ["/connections"] },
  { to: "/secrets", labelKey: "sidebar.nav.secrets", icon: <IconSecrets />, match: ["/secrets"] },
];

const ProjectSwitcher = (): ReactNode => {
  const { projects, project, select } = useProjectScope();
  const [open, setOpen] = useState(false);
  const t = useT();
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild><button type="button" className={PROJECT_SWITCHER}>
        <span className={PROJECT_MARK}>{project ? initial(project.name) : "·"}</span>
        <span className={PROJECT_NAME}>{project?.name ?? t(projects.length === 0 ? "sidebar.project.none" : "sidebar.project.select")}</span>
        <span className={CHEVRON}><IconChevron open={open} /></span>
      </button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[194px] border-sidebar-border bg-popover font-mono text-popover-foreground">
          {projects.map((candidate) => (
            <DropdownMenuItem key={candidate.id} className={candidate.id === project?.id ? "text-primary focus:bg-accent" : "focus:bg-accent"}
              onSelect={() => select(candidate.id)}>
              <span className={cn(PROJECT_MARK, "size-[18px] text-[10px]")}>{initial(candidate.name)}</span>
              {candidate.name}
            </DropdownMenuItem>
          ))}
          {projects.length === 0 ? <span className="block px-2 py-1.5 text-[11.5px] text-[color:var(--faint)]">{t("sidebar.project.empty")}</span> : null}
          <DropdownMenuItem className="focus:bg-accent" onSelect={() => navigate("/projects")}>{t("sidebar.project.manage")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const ThemeCycleButton = (): ReactNode => {
  const { mode, setMode } = useTheme();
  const t = useT();
  const nextMode: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" };
  const ThemeIcon = mode === "system" ? Monitor : mode === "light" ? Sun : Moon;
  const modeWord = (value: ThemeMode): string => t(`sidebar.theme.${value}`);
  return (
    <button type="button" className={cn(NAV_ITEM, "w-full border-0 bg-transparent text-left")} aria-label={t("sidebar.theme.aria", { mode: modeWord(mode), next: modeWord(nextMode[mode]) })} onClick={() => setMode(nextMode[mode])}>
      <ThemeIcon size={15} strokeWidth={1.7} aria-hidden="true" />{t("sidebar.theme.label", { mode: modeWord(mode) })}
    </button>
  );
};

export const Shell = ({ children }: { children: ReactNode }): ReactNode => {
  const path = useRoute();
  /* The badge is one number, so it polls one number. This used to read
   * `GET /inbox/messages` — the complete global message collection, 490 KB
   * across 231 messages, every 5s from whichever page the operator happened to
   * be on — and then counted the rows client-side. The summary route applies the
   * same rule server-side: only cards the operator still owes an answer to.
   * Detached notifications are open too, but nobody is blocked on them, and
   * counting them is what made the badge read 145 with nothing actually waiting;
   * they live in the Inbox's Notices lane instead. */
  const { data: summary } = usePoll<InboxSummary>("/inbox/messages/summary", 5_000);
  const openCount = summary?.needsReply ?? 0;
  const t = useT();

  const active = (item: { to: string; match: string[] }): boolean =>
    item.match.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

  return (
    <div className={SHELL}>
      <aside className={SIDEBAR}>
        <ProjectSwitcher />
        <nav className="grid gap-0.5">
          {NAV.map((item) => (
            <Link key={item.to} to={item.to} className={cn(NAV_ITEM, active(item) && NAV_ITEM_ACTIVE)}>
              {item.icon}
              {t(item.labelKey)}
              {/* Count meaning and cadence unchanged (spec §4.4.4) — only the
                  transport moved. The label is there because a bare number
                  beside "Inbox" reads as nothing at all to a screen reader. */}
              {item.to === "/inbox" && openCount > 0
                ? <span className={cn(COUNT, NAV_COUNT)} aria-label={t("sidebar.inbox.unread", { n: openCount })}><span className={BADGE_COUNT}>{openCount}</span></span>
                : null}
            </Link>
          ))}
        </nav>
        <div className={SIDEBAR_FOOT}>
          <RunnerRow />
          <Link to="/settings" className={cn(NAV_ITEM, path === "/settings" && NAV_ITEM_ACTIVE)}><IconSettings />{t("sidebar.settings")}</Link>
          <ThemeCycleButton />
        </div>
      </aside>
      <main className={CONTENT}>{children}</main>
    </div>
  );
};
