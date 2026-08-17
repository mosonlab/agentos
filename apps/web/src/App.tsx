import type { ReactNode } from "react";

import { Shell } from "./components/Shell";
import { RunnersProvider } from "./components/runner-status";
import { ErrorNotice, NOTICE, Page } from "./components/ui";
import { apiBase } from "./lib/api";
import { useTNodes } from "./lib/i18n";
import { ProjectProvider, useProjectScope } from "./lib/project";
import { matchRoute, navigate, useRoute } from "./lib/router";
import { AgentDetailPage, AgentsPage } from "./pages/Agents";
import { ArchivedPage } from "./pages/Archived";
import { AutomationsPage } from "./pages/Automations";
import { ConnectionsPage } from "./pages/Connections";
import { GoalDetailPage, GoalsPage } from "./pages/Goals";
import { InboxPage, InboxThreadPage } from "./pages/Inbox";
import { ProjectDetailPage, ProjectsPage } from "./pages/Projects";
import { SecretsPage } from "./pages/Secrets";
import { SettingsPage } from "./pages/Settings";
import { SessionDetailPage, SessionsPage } from "./pages/Sessions";
import { TasksPage } from "./pages/Tasks";
import { TriggerDetailPage, TriggersPage } from "./pages/Triggers";
import { TaskDetailPage } from "./pages/TaskDetail";

export const ROUTES: Array<{ pattern: string; render: (params: Record<string, string>) => ReactNode }> = [
  { pattern: "/tasks", render: () => <TasksPage /> },
  { pattern: "/tasks/:taskId", render: (params) => <TaskDetailPage key={params.taskId ?? ""} taskId={params.taskId ?? ""} /> },
  // Siblings of /tasks, not children: matchRoute compares segment counts and
  // /tasks/:taskId already owns the second segment.
  { pattern: "/automations", render: () => <AutomationsPage /> },
  { pattern: "/triggers", render: () => <TriggersPage /> },
  { pattern: "/triggers/:templateId", render: (params) => <TriggerDetailPage templateId={params.templateId ?? ""} /> },
  { pattern: "/archived", render: () => <ArchivedPage /> },
  { pattern: "/sessions", render: () => <SessionsPage /> },
  { pattern: "/sessions/:sessionId", render: (params) => <SessionDetailPage sessionId={params.sessionId ?? ""} /> },
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
  { pattern: "/settings", render: () => <SettingsPage /> },
];

/** The only auth surface: the proxy injects the operator token, so a 401 here
 *  means the repository root .env is missing OPERATOR_TOKEN (DECISIONS #17). */
const ConnectionBanner = (): ReactNode => {
  const { error } = useProjectScope();
  const tn = useTNodes();
  if (error === null) return null;
  if (error.unauthorized) {
    return (
      <Page className="pb-0 [@media(max-width:900px)]:pb-0">
        <ErrorNotice message={<>{tn("errors.unauthorized", {
          status: error.status,
          env: <code>.env</code>,
          token: <code>OPERATOR_TOKEN</code>,
          config: <code>vite.config.ts</code>,
          base: <code>{apiBase}</code>,
        })}</>} />
      </Page>
    );
  }
  if (error.status === 0) {
    return (
      <Page className="pb-0 [@media(max-width:900px)]:pb-0">
        <ErrorNotice message={<>{tn("errors.unreachable", {
          base: apiBase,
          command: <code>npm run dev:api</code>,
        })}</>} />
      </Page>
    );
  }
  return null;
};

const Routed = (): ReactNode => {
  const path = useRoute();
  const tn = useTNodes();
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
      <div className={NOTICE}>{tn("errors.route.unknown", { path: <code>{path}</code> })}</div>
    </Page>
  );
};

export const App = (): ReactNode => (
  <ProjectProvider>
    <RunnersProvider>
      <Shell>
        <ConnectionBanner />
        <Routed />
      </Shell>
    </RunnersProvider>
  </ProjectProvider>
);
