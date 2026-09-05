import { type ReactNode, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { useMediaQuery, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { projectScopedPath, useProjectScope } from "../lib/project";
import { Link, navigate, useRoute } from "../lib/router";
import { initial } from "../lib/format";
import type { InboxSummary } from "../lib/types";
import { useTheme, type ThemeMode } from "../lib/theme";
import { cn } from "../lib/utils";
import {
  BADGE_COUNT, CHEVRON, CONTENT, COUNT, MOBILE_TAB, MOBILE_TAB_ACTIVE, MOBILE_TAB_BADGE, MOBILE_TABBAR,
  MOBILE_TOPBAR, NAV_COUNT, NAV_ITEM, NAV_ITEM_ACTIVE, PROJECT_MARK, PROJECT_NAME, PROJECT_SWITCHER,
  SHEET, SHEET_ITEM, SHEET_ITEM_ACTIVE, SHEET_RULE, SHEET_TITLE, SHELL, SIDEBAR, SIDEBAR_FOOT,
} from "./ui";
import { RunnerRow } from "./runner-status";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import {
  IconAgents, IconChevron, IconConnections, IconCosts, IconGoals, IconInbox, IconMore,
  IconProjects, IconSecrets, IconSessions, IconSettings, IconTasks,
} from "./icons";

type NavEntry = { to: string; labelKey: string; icon: ReactNode; match: string[] };

/** The table keeps its shape; only the label moves from a literal to a key, so a
 *  new nav entry still reads as one row. Order matters twice: it is the sidebar
 *  order, and the first `PRIMARY_COUNT` entries are the phone's tab bar. */
const NAV: NavEntry[] = [
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
const PRIMARY_COUNT = 4;
const SETTINGS: NavEntry = { to: "/settings", labelKey: "sidebar.settings", icon: <IconSettings />, match: ["/settings"] };

const isActive = (path: string, item: { match: string[] }): boolean =>
  item.match.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

const ProjectSwitcher = ({ className }: { className?: string }): ReactNode => {
  const { projects, project, select } = useProjectScope();
  const [open, setOpen] = useState(false);
  const t = useT();
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild><button type="button" className={cn(PROJECT_SWITCHER, className)}>
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

export const ThemeCycleButton = ({ className }: { className?: string }): ReactNode => {
  const { mode, setMode } = useTheme();
  const t = useT();
  const nextMode: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" };
  const ThemeIcon = mode === "system" ? Monitor : mode === "light" ? Sun : Moon;
  const modeWord = (value: ThemeMode): string => t(`sidebar.theme.${value}`);
  return (
    <button type="button" className={cn(className ?? cn(NAV_ITEM, "w-full border-0 bg-transparent text-left"))} aria-label={t("sidebar.theme.aria", { mode: modeWord(mode), next: modeWord(nextMode[mode]) })} onClick={() => setMode(nextMode[mode])}>
      <ThemeIcon size={15} strokeWidth={1.7} aria-hidden="true" />{t("sidebar.theme.label", { mode: modeWord(mode) })}
    </button>
  );
};

/** Count meaning and cadence unchanged (spec §4.4.4) — only the transport moved.
 *  The label is there because a bare number beside "Inbox" reads as nothing at
 *  all to a screen reader. */
const InboxBadge = ({ summaryError, openCount, className }: {
  summaryError: unknown;
  openCount: number | undefined;
  className: string;
}): ReactNode => {
  const t = useT();
  if (summaryError !== null) {
    return <span className={cn(COUNT, className)} aria-label={t("sidebar.inbox.unavailable")}><span className={BADGE_COUNT}>!</span></span>;
  }
  if (openCount === undefined || openCount === 0) return null;
  return <span className={cn(COUNT, className)} aria-label={t("sidebar.inbox.unread", { n: openCount })}><span className={BADGE_COUNT}>{openCount}</span></span>;
};

const Sidebar = ({ path, badge }: { path: string; badge: ReactNode }): ReactNode => {
  const t = useT();
  return (
    <aside className={SIDEBAR}>
      <ProjectSwitcher />
      <nav className="grid gap-0.5">
        {NAV.map((item) => (
          <Link key={item.to} to={item.to} className={cn(NAV_ITEM, isActive(path, item) && NAV_ITEM_ACTIVE)}>
            {item.icon}
            {t(item.labelKey)}
            {item.to === "/inbox" ? badge : null}
          </Link>
        ))}
      </nav>
      <div className={SIDEBAR_FOOT}>
        <RunnerRow />
        <Link to={SETTINGS.to} className={cn(NAV_ITEM, isActive(path, SETTINGS) && NAV_ITEM_ACTIVE)}>{SETTINGS.icon}{t(SETTINGS.labelKey)}</Link>
        <ThemeCycleButton />
      </div>
    </aside>
  );
};

/**
 * The phone chrome: a sticky top bar, a fixed tab bar, and the "More" sheet.
 *
 * The sheet closes itself on navigation, and it is the one place on a phone
 * where the runner row, Settings and the theme switch live — the desktop
 * sidebar's footer used to be hidden outright below 900px, so a phone had no
 * way to reach any of the three.
 */
const MobileChrome = ({ path, badge, children }: { path: string; badge: ReactNode; children: ReactNode }): ReactNode => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const primary = NAV.slice(0, PRIMARY_COUNT);
  const secondary = NAV.slice(PRIMARY_COUNT);
  const moreActive = [...secondary, SETTINGS].some((item) => isActive(path, item));
  const go = (to: string): void => { setOpen(false); navigate(to); };
  return (
    <>
      <header className={MOBILE_TOPBAR}>
        <ProjectSwitcher className="mb-0 min-w-0 flex-1 p-[6px]" />
        <RunnerRow compact />
      </header>
      <main className={CONTENT}>{children}</main>
      <nav className={MOBILE_TABBAR} aria-label={t("sidebar.nav.aria")}>
        {primary.map((item) => (
          <Link key={item.to} to={item.to} className={cn(MOBILE_TAB, isActive(path, item) && MOBILE_TAB_ACTIVE)}>
            {item.icon}
            {t(item.labelKey)}
            {item.to === "/inbox" ? badge : null}
          </Link>
        ))}
        <button type="button" className={cn(MOBILE_TAB, moreActive && MOBILE_TAB_ACTIVE)} aria-expanded={open} onClick={() => setOpen(true)}>
          <IconMore />{t("sidebar.nav.more")}
        </button>
      </nav>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={SHEET}>
          <DialogTitle className={SHEET_TITLE}>{t("sidebar.nav.more")}</DialogTitle>
          <nav className="grid gap-[2px]">
            {secondary.map((item) => (
              <button key={item.to} type="button" className={cn(SHEET_ITEM, isActive(path, item) && SHEET_ITEM_ACTIVE)} onClick={() => go(item.to)}>
                {item.icon}{t(item.labelKey)}
              </button>
            ))}
            <div className={SHEET_RULE} />
            <RunnerRow className={SHEET_ITEM} onNavigate={() => setOpen(false)} />
            <button type="button" className={cn(SHEET_ITEM, isActive(path, SETTINGS) && SHEET_ITEM_ACTIVE)} onClick={() => go(SETTINGS.to)}>
              {SETTINGS.icon}{t(SETTINGS.labelKey)}
            </button>
            <ThemeCycleButton className={SHEET_ITEM} />
          </nav>
        </DialogContent>
      </Dialog>
    </>
  );
};

export const Shell = ({ children }: { children: ReactNode }): ReactNode => {
  const path = useRoute();
  const { projectId } = useProjectScope();
  /* The badge is one number, so it polls one number. This used to read
   * `GET /inbox/messages` — the complete global message collection, 490 KB
   * across 231 messages, every 5s from whichever page the operator happened to
   * be on — and then counted the rows client-side. The summary route applies the
   * same rule server-side: only cards the operator still owes an answer to.
   * Detached notifications are open too, but nobody is blocked on them, and
   * counting them is what made the badge read 145 with nothing actually waiting;
   * they live in the Inbox's Notices lane instead. */
  const summaryPath = projectScopedPath("/inbox/messages/summary", projectId);
  const { data: summary, error: summaryError } = usePoll<InboxSummary>(summaryPath, 5_000);
  const openCount = summary?.needsReply;
  // One chrome or the other, never both, on the same 900px line the stylesheet
  // and the Tasks board use.
  const narrow = useMediaQuery("(max-width: 900px)");

  if (narrow) {
    return (
      <div className={SHELL}>
        <MobileChrome path={path} badge={<InboxBadge summaryError={summaryError} openCount={openCount} className={MOBILE_TAB_BADGE} />}>
          {children}
        </MobileChrome>
      </div>
    );
  }
  return (
    <div className={SHELL}>
      <Sidebar path={path} badge={<InboxBadge summaryError={summaryError} openCount={openCount} className={NAV_COUNT} />} />
      <main className={CONTENT}>{children}</main>
    </div>
  );
};
