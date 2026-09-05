import type { ReactNode } from "react";

import { Shell } from "./components/Shell";
import { RunnersProvider } from "./components/runner-status";
import { type Bootstrap, StartupGate } from "./components/startup-gate";
import { ErrorNotice, NOTICE, Page } from "./components/ui";
import { apiBase } from "./lib/api";
import { useTNodes } from "./lib/i18n";
import { ProjectProvider, useProjectScope } from "./lib/project";
import { matchRoute, navigate, useRoute } from "./lib/router";
import { storage } from "./lib/storage";
import { OnboardingPage } from "./pages/Onboarding";
import { AgentDetailPage, AgentsPage } from "./pages/Agents";
import { ArchivedPage } from "./pages/Archived";
import { AutomationsPage } from "./pages/Automations";
import { ConnectionsPage } from "./pages/Connections";
import { CostsPage } from "./pages/Costs";
import { GoalDetailPage, GoalsPage } from "./pages/Goals";
import { InboxPage, InboxThreadPage } from "./pages/Inbox";
import { ProjectDetailPage, ProjectsPage } from "./pages/Projects";
import { SecretsPage } from "./pages/Secrets";
import { SettingsPage } from "./pages/Settings";
import { SessionDetailPage, SessionsPage } from "./pages/Sessions";
import { TasksPage } from "./pages/Tasks";
import { TriggerDetailPage, TriggersPage } from "./pages/Triggers";
import { TaskDetailPage } from "./pages/TaskDetail";
import { StaffingProfilePage, WorkflowDetailPage, WorkflowsPage } from "./pages/Workflows";

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
  { pattern: "/costs", render: () => <CostsPage /> },
  { pattern: "/agents", render: () => <AgentsPage /> },
  { pattern: "/agents/:agentId", render: (params) => <AgentDetailPage agentId={params.agentId ?? ""} /> },
  { pattern: "/workflows", render: () => <WorkflowsPage /> },
  { pattern: "/workflows/:templateId", render: (params) => <WorkflowDetailPage templateId={params.templateId ?? ""} /> },
  { pattern: "/workflows/:templateId/profiles/:profileId", render: (params) => (
    <StaffingProfilePage templateId={params.templateId ?? ""} profileId={params.profileId ?? ""} />
  ) },
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

/**
 * The mid-session failure surface, not the first-load one.
 *
 * `StartupGate` owns the bootstrap: a control plane that refuses or does not
 * answer the *first* protected request never gets as far as mounting this tree.
 * What is left for the banner is the case the gate cannot cover — a token
 * rotated, a control plane stopped, an hour after the application was already
 * running — where the routed page is on screen and its poll starts failing.
 */
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

/** The application proper. Nothing in here mounts — and so nothing in here polls
 *  a protected route — until the gate's own request has succeeded. */
export const Installed = ({ projects }: { projects: Bootstrap["projects"] }): ReactNode => (
  <ProjectProvider initialProjects={projects}>
    <RunnersProvider>
      <Shell>
        <ConnectionBanner />
        <Routed />
      </Shell>
    </RunnersProvider>
  </ProjectProvider>
);

/**
 * A fresh installation has no Project, so the wizard is what the operator sees
 * instead of an empty board they cannot fill.
 *
 * The created Project is selected before `ProjectProvider` mounts, because that
 * provider reads the selection from storage at mount: writing it first is what
 * makes the first frame after an install the operator's own project rather than
 * whatever sorted first. A 409 hands back no id — an installation already
 * existed — and then the selection is left exactly as it was.
 */
export const Bootstrapped = ({ projects, reload, attempt }: Bootstrap): ReactNode => {
  if (projects.length > 0) return <Installed projects={projects} />;
  return (
    <OnboardingPage
      // `GET /onboarding` is the control plane's own answer about whether an
      // installation exists, and it outranks the empty list that mounted this
      // page: `/projects` can be read a moment before another installer
      // commits. Acting on it means asking the gate to look again, and both
      // endpoints read the same database, so the second look sees what the
      // first missed. A control plane that disagreed with itself would bounce
      // the two forever, so the automatic recovery is offered on the first
      // bootstrap only; after that the wizard stays put and a POST gets the
      // same answer through 409.
      recoverCompleted={attempt === 0}
      onInstalled={(projectId) => {
        if (projectId !== null) storage.set("agentos.projectId", projectId);
        navigate("/tasks");
        reload();
      }}
    />
  );
};

export const App = (): ReactNode => (
  <StartupGate>{(bootstrap) => <Bootstrapped {...bootstrap} />}</StartupGate>
);
