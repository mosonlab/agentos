import { type ReactNode, useState } from "react";

import { usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import { navigate } from "../lib/router";
import type { Agent, Repo } from "../lib/types";
import { IconPlus } from "./icons";
import { NewTask } from "./new-task-panel";
import {
  PAGE_ACTIONS, PAGE_HEAD, PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, Segmented,
} from "./ui";
import { Button } from "./ui/button";

export type TasksTab = "tasks" | "automations" | "triggers" | "archived";

const TABS: Array<{ value: TasksTab; label: string }> = [
  { value: "tasks", label: "Tasks" },
  { value: "automations", label: "Automations" },
  { value: "triggers", label: "Triggers" },
  { value: "archived", label: "Archived" },
];

/**
 * The head shared by all four Tasks routes: title, `+ Create Task`, and the tab
 * strip.
 *
 * It owns the creation panel outright — the button is rendered on every tab, so
 * exactly one component may hold `creating`, and it is this one. `onCreated` is
 * optional because a task made from the Triggers tab has nowhere to appear
 * there; the board passes its `reload`, the other three pass nothing.
 */
export const TasksPageHead = ({ active, onCreated }: {
  active: TasksTab;
  onCreated?: () => void;
}): ReactNode => {
  const { projectId, project } = useProjectScope();
  const { data: agents } = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 15_000);
  const { data: repos } = usePoll<Repo[]>(projectId === "" ? null : `/projects/${projectId}/repos`, 15_000);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>Tasks</h1>
          <div className={PAGE_HEAD_SUBTITLE}>Work queued for agents in {project?.name ?? "this project"}</div>
        </div>
        <div className={PAGE_ACTIONS}>
          <Button type="button" variant="legacyPrimary" size="legacy" onClick={() => setCreating(true)}><IconPlus />Create Task</Button>
        </div>
      </div>

      <Segmented options={TABS} value={active} onChange={(value) => navigate(`/${value}`)} />

      {creating && projectId !== "" ? (
        <NewTask projectId={projectId} agents={agents ?? []} repos={repos ?? []}
          onClose={() => setCreating(false)} onCreated={() => onCreated?.()} />
      ) : null}
    </>
  );
};
