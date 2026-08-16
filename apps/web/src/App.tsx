import type { ReactNode } from "react";

import { Shell } from "./components/Shell";
import { ErrorNotice, NOTICE, Page } from "./components/ui";
import { apiBase } from "./lib/api";
import { ProjectProvider, useProjectScope } from "./lib/project";
import { matchRoute, navigate, useRoute } from "./lib/router";
import { AgentDetailPage, AgentsPage } from "./pages/Agents";
import { ConnectionsPage } from "./pages/Connections";
import { GoalDetailPage, GoalsPage } from "./pages/Goals";
import { InboxPage, InboxThreadPage } from "./pages/Inbox";
import { ProjectDetailPage, ProjectsPage } from "./pages/Projects";
import { SecretsPage } from "./pages/Secrets";
import { TasksPage } from "./pages/Tasks";
import { TaskDetailPage } from "./pages/TaskDetail";

const ROUTES: Array<{ pattern: string; render: (params: Record<string, string>) => ReactNode }> = [
  { pattern: "/tasks", render: () => <TasksPage /> },
  { pattern: "/tasks/:taskId", render: (params) => <TaskDetailPage taskId={params.taskId ?? ""} /> },
  { pattern: "/agents", render: () => <AgentsPage /> },
  { pattern: "/agents/:agentId", render: (params) => <AgentDetailPage agentId={params.agentId ?? ""} /> },
  { pattern: "/inbox", render: () => <InboxPage /> },
  { pattern: "/inbox/:messageId", render: (params) => <InboxThreadPage messageId={params.messageId ?? ""} /> },
  { pattern: "/goals", render: () => <GoalsPage /> },
  { pattern: "/goals/:goalId", render: (params) => <GoalDetailPage goalId={params.goalId ?? ""} /> },
  { pattern: "/projects", render: () => <ProjectsPage /> },
  { pattern: "/projects/:projectId", render: (params) => <ProjectDetailPage projectId={params.projectId ?? ""} /> },
  { pattern: "/connections", render: () => <ConnectionsPage /> },
  { pattern: "/secrets", render: () => <SecretsPage /> },
];

/** The only auth surface: the proxy injects the operator token, so a 401 here
 *  means the repository root .env is missing OPERATOR_TOKEN (DECISIONS #17). */
const ConnectionBanner = (): ReactNode => {
  const { error } = useProjectScope();
  if (error === null) return null;
  if (error.unauthorized) {
    return (
      <Page className="pb-0 [@media(max-width:900px)]:pb-0">
        <ErrorNotice message={<>
          控制面拒绝了操作员身份（{error.status}）。检查仓库根 <code>.env</code> 的 <code>OPERATOR_TOKEN</code>，
          它由 <code>vite.config.ts</code> 的 <code>{apiBase}</code> 代理注入。
        </>} />
      </Page>
    );
  }
  if (error.status === 0) {
    return (
      <Page className="pb-0 [@media(max-width:900px)]:pb-0">
        <ErrorNotice message={<>无法连接控制面（{apiBase}）。先启动 <code>npm run dev:api</code>。</>} />
      </Page>
    );
  }
  return null;
};

const Routed = (): ReactNode => {
  const path = useRoute();
  if (path === "/" || path === "") {
    navigate("/tasks");
    return null;
  }
  for (const route of ROUTES) {
    const params = matchRoute(route.pattern, path);
    if (params !== null) return route.render(params);
  }
  return (
    <Page>
      <div className={NOTICE}>未知路由 <code>{path}</code>。</div>
    </Page>
  );
};

export const App = (): ReactNode => (
  <ProjectProvider>
    <Shell>
      <ConnectionBanner />
      <Routed />
    </Shell>
  </ProjectProvider>
);
