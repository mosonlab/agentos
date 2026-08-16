import type { ReactNode } from "react";

import { TasksPageHead } from "../components/tasks-tabs";
import { EmptyState, Page } from "../components/ui";

/** Stub — replaced wholesale in WI-12. The route is registered with the rest of
 *  the tab shell so no commit ships a tab that navigates to the unknown-route
 *  notice. */
export const AutomationsPage = (): ReactNode => (
  <Page className="text-foreground">
    <TasksPageHead active="automations" />
    <EmptyState>Loading…</EmptyState>
  </Page>
);
