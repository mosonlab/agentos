import { type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

import { usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import { Link, navigate, useRoute } from "../lib/router";
import { initial } from "../lib/format";
import type { Health, InboxMessage } from "../lib/types";
import { useTheme, type ThemeMode } from "../lib/theme";
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><button type="button" className="projectSwitcher hover:bg-sidebar-accent">
        <span className="projectMark">{project ? initial(project.name) : "·"}</span>
        <span className="projectName">{project?.name ?? (projects.length === 0 ? "No project" : "Select project")}</span>
        <span className="chevron"><IconChevron /></span>
      </button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[194px] border-sidebar-border bg-popover font-mono text-popover-foreground">
          {projects.map((candidate) => (
            <DropdownMenuItem key={candidate.id} className={candidate.id === project?.id ? "text-primary focus:bg-accent" : "focus:bg-accent"}
              onSelect={() => select(candidate.id)}>
              <span className="projectMark size-[18px] text-[10px]">{initial(candidate.name)}</span>
              {candidate.name}
            </DropdownMenuItem>
          ))}
          {projects.length === 0 ? <span className="faint small block px-2 py-1.5">No projects yet</span> : null}
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
    <div className="shell min-h-screen bg-background text-foreground">
      <aside className="sidebar border-sidebar-border bg-sidebar text-sidebar-foreground">
        <ProjectSwitcher />
        <nav className="grid gap-0.5">
          {NAV.map((item) => (
            <Link key={item.to} to={item.to} className={`${active(item) ? "navItem active" : "navItem"} hover:bg-sidebar-accent hover:text-sidebar-accent-foreground`}>
              {item.icon}
              {item.label}
              {item.to === "/inbox" && openCount > 0 ? <span className="count"><span className="badge">{openCount}</span></span> : null}
            </Link>
          ))}
        </nav>
        <div className="sidebarFoot">
          <div className="runnerRow">
            <span className={health?.status === "ok" ? "dot on" : health ? "dot off" : "dot"} />
            Control plane
            <span className="state">{health ? (health.status === "ok" ? "online" : "degraded") : "offline"}</span>
          </div>
          <Link to="/secrets" className="navItem"><IconActivity />Settings</Link>
          <button type="button" className="navItem w-full border-0 bg-transparent text-left" aria-label={`Theme: ${mode}. Switch to ${nextMode[mode]}.`} onClick={() => setMode(nextMode[mode])}>
            <ThemeIcon size={15} strokeWidth={1.7} aria-hidden="true" />Theme: {mode}
          </button>
        </div>
      </aside>
      <main className="content bg-popover">{children}</main>
    </div>
  );
};
