import { type ReactNode, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import { Link, navigate, useRoute } from "../lib/router";
import { initial } from "../lib/format";
import type { Health, InboxMessage } from "../lib/types";
import { useTheme, type ThemeMode } from "../lib/theme";
import { cn } from "../lib/utils";
import {
  BADGE_COUNT, CHEVRON, CONTENT, COUNT, DOT, DOT_TONE, NAV_COUNT, NAV_ITEM, NAV_ITEM_ACTIVE,
  PROJECT_MARK, PROJECT_NAME, PROJECT_SWITCHER, RUNNER_ROW, RUNNER_STATE, SHELL, SIDEBAR, SIDEBAR_FOOT,
} from "./ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import {
  IconActivity, IconAgents, IconChevron, IconConnections, IconGoals, IconInbox,
  IconProjects, IconSecrets, IconTasks,
} from "./icons";

const NAV: Array<{ to: string; label: string; icon: ReactNode; match: string[] }> = [
  { to: "/inbox", label: "Inbox", icon: <IconInbox />, match: ["/inbox"] },
  { to: "/tasks", label: "Tasks", icon: <IconTasks />, match: ["/tasks"] },
  { to: "/goals", label: "Goals", icon: <IconGoals />, match: ["/goals"] },
  { to: "/agents", label: "Agents", icon: <IconAgents />, match: ["/agents"] },
  { to: "/projects", label: "Projects", icon: <IconProjects />, match: ["/projects", "/"] },
  { to: "/connections", label: "Connections", icon: <IconConnections />, match: ["/connections"] },
  { to: "/secrets", label: "Secrets", icon: <IconSecrets />, match: ["/secrets"] },
];

const ProjectSwitcher = (): ReactNode => {
  const { projects, project, select } = useProjectScope();
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild><button type="button" className={PROJECT_SWITCHER}>
        <span className={PROJECT_MARK}>{project ? initial(project.name) : "·"}</span>
        <span className={PROJECT_NAME}>{project?.name ?? (projects.length === 0 ? "No project" : "Select project")}</span>
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
          {projects.length === 0 ? <span className="block px-2 py-1.5 text-[11.5px] text-[color:var(--faint)]">No projects yet</span> : null}
          <DropdownMenuItem className="focus:bg-accent" onSelect={() => navigate("/projects")}>Manage projects…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const Shell = ({ children }: { children: ReactNode }): ReactNode => {
  const path = useRoute();
  const { data: health } = usePoll<Health>("/health", 10_000);
  // GET /inbox/messages is global: the control plane has no project filter on it.
  const { data: inbox } = usePoll<InboxMessage[]>("/inbox/messages", 5_000);
  const openCount = (inbox ?? []).filter((message) => message.status === "OPEN").length;
  const { mode, setMode } = useTheme();
  const nextMode: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" };
  const ThemeIcon = mode === "system" ? Monitor : mode === "light" ? Sun : Moon;

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
              {item.label}
              {item.to === "/inbox" && openCount > 0
                ? <span className={cn(COUNT, NAV_COUNT)}><span className={BADGE_COUNT}>{openCount}</span></span>
                : null}
            </Link>
          ))}
        </nav>
        <div className={SIDEBAR_FOOT}>
          <div className={RUNNER_ROW}>
            <span className={cn(DOT, health?.status === "ok" ? DOT_TONE.on : health ? DOT_TONE.off : undefined)} />
            Control plane
            <span className={RUNNER_STATE}>{health ? (health.status === "ok" ? "online" : "degraded") : "offline"}</span>
          </div>
          <Link to="/secrets" className={NAV_ITEM}><IconActivity />Settings</Link>
          <button type="button" className={cn(NAV_ITEM, "w-full border-0 bg-transparent text-left")} aria-label={`Theme: ${mode}. Switch to ${nextMode[mode]}.`} onClick={() => setMode(nextMode[mode])}>
            <ThemeIcon size={15} strokeWidth={1.7} aria-hidden="true" />Theme: {mode}
          </button>
        </div>
      </aside>
      <main className={CONTENT}>{children}</main>
    </div>
  );
};
