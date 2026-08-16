import type { ReactNode } from "react";

import { TasksPageHead } from "../components/tasks-tabs";
import { EmptyState, Page } from "../components/ui";

/** Stubs — replaced wholesale in WI-13, for the same reason as Automations. */
export const TriggersPage = (): ReactNode => (
  <Page className="text-foreground">
    <TasksPageHead active="triggers" />
    <EmptyState>Loading…</EmptyState>
  </Page>
);

export const TriggerDetailPage = ({ templateId }: { templateId: string }): ReactNode => (
  <Page className="text-foreground">
    <EmptyState>Loading trigger {templateId}…</EmptyState>
  </Page>
);
