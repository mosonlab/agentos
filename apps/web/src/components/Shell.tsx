import { type ReactNode, useState } from "react";

import { useDismiss, usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import { Link, navigate, useRoute } from "../lib/router";
import { initial } from "../lib/format";
import type { Health, InboxMessage } from "../lib/types";
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
  useDismiss(() => setOpen(false), open);
  return (
    <>
      <button type="button" className="projectSwitcher" onClick={(event) => { event.stopPropagation(); setOpen(!open); }}>
        <span className="projectMark">{project ? initial(project.name) : "·"}</span>
        <span className="projectName">{project?.name ?? (projects.length === 0 ? "No project" : "Select project")}</span>
        <span className="chevron"><IconChevron open={open} /></span>
      </button>
      {open ? (
        <div className="projectMenu" onClick={(event) => event.stopPropagation()}>
          {projects.map((candidate) => (
            <button key={candidate.id} type="button" className={candidate.id === project?.id ? "current" : ""}
              onClick={() => { select(candidate.id); setOpen(false); }}>
              <span className="projectMark" style={{ width: 18, height: 18, fontSize: 10 }}>{initial(candidate.name)}</span>
              {candidate.name}
            </button>
          ))}
          {projects.length === 0 ? <span className="faint small" style={{ padding: "6px 8px" }}>No projects yet</span> : null}
          <button type="button" onClick={() => { setOpen(false); navigate("/projects"); }}>Manage projects…</button>
        </div>
      ) : null}
    </>
  );
};

export const Shell = ({ children }: { children: ReactNode }): ReactNode => {
  const path = useRoute();
  const { data: health } = usePoll<Health>("/health", 10_000);
  // GET /inbox/messages is global: the control plane has no project filter on it.
  const { data: inbox } = usePoll<InboxMessage[]>("/inbox/messages", 5_000);
  const openCount = (inbox ?? []).filter((message) => message.status === "OPEN").length;

  const active = (item: { to: string; match: string[] }): boolean =>
    item.match.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

  return (
    <div className="shell">
      <aside className="sidebar">
        <ProjectSwitcher />
        <nav style={{ display: "grid", gap: 2 }}>
          {NAV.map((item) => (
            <Link key={item.to} to={item.to} className={active(item) ? "navItem active" : "navItem"}>
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
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
};
