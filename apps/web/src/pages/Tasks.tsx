import { type ReactNode, useMemo, useState } from "react";

import { api } from "../lib/api";
import { money, timeAgo } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import { navigate } from "../lib/router";
import type { Agent, Repo, Task, TaskStatus, TaskTemplate } from "../lib/types";
import { IconPlus, IconRobot } from "../components/icons";
import { cn } from "../lib/utils";
import {
  CARD_TITLE, CODE_BLOCK, COUNT, DOT, DOT_TONE, FIELD_ROW, PAGE_ACTIONS, PAGE_HEAD,
  PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, ROW, STACK,
  Card, EmptyState, ErrorNotice, Field, FullPanel, Page, Pill, RowMenu, Segmented, Tabs, Toggle,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";

const BOARD = "grid grid-flow-col auto-cols-[minmax(250px,1fr)] gap-[14px] overflow-x-auto pb-[10px]";
const COLUMN = "flex min-h-[420px] flex-col";
const COLUMN_HEAD = "flex items-center gap-[8px] px-[2px] pt-0 pb-[12px] text-[12.5px] text-secondary-foreground";
/** The 1% tint is the faint drop region the board draws behind every column,
 *  cards or not — it is a declaration, not decoration. */
const COLUMN_BODY = "grid flex-1 grid-cols-[minmax(0,1fr)] content-start gap-[10px] rounded-xl border border-[color:var(--border-soft)] bg-[color-mix(in_srgb,var(--foreground)_1%,transparent)] p-[10px]";
const COLUMN_BODY_OVER = "border-[color:var(--primary-soft)] bg-[color-mix(in_srgb,var(--primary)_4%,transparent)]";
const COLUMN_EMPTY = "px-0 py-[26px] text-center text-[12px] text-[color:var(--faint)]";
const TASK_CARD = "cursor-pointer rounded-xl border border-border bg-card px-[14px] py-[13px] hover:border-[color:var(--border-hover)]";
const TASK_META = "mt-[9px] grid gap-[6px] text-[11.5px] text-muted-foreground";
const TASK_META_ROW = "flex flex-wrap items-center gap-[8px]";
/** `size-[13px]`, not the button base's `[&_svg]:size-4`. */
const TASK_FOOT = "mt-[10px] flex items-center gap-[10px] text-[11.5px] text-muted-foreground [&_svg]:size-[13px] [&_svg]:flex-none [&_svg]:opacity-85";

const COLUMNS: Array<{ status: TaskStatus; label: string }> = [
  { status: "TODO", label: "Todo" },
  { status: "DOING", label: "Doing" },
  { status: "REVIEW", label: "Review" },
  { status: "DONE", label: "Done" },
];

// The board card keeps the run line light — a status dot plus text, as in
// kanban-tasks-board-t1560.jpg; pills are reserved for the task detail header.
const runLabel = (task: Task): ReactNode => {
  const run = task.runs[0];
  if (!run) return <span className="text-[color:var(--faint)]">no runs</span>;
  const tone = run.status === "SUCCEEDED" ? "green" : run.status === "FAILED" || run.status === "TIMED_OUT" || run.status === "LOST" ? "red" : "amber";
  return (
    <span className="inline-flex items-center gap-[6px] whitespace-nowrap">
      <span className={cn(DOT, DOT_TONE[tone])} />
      <span className="text-primary">run {run.runNumber}</span>
      <span className="text-[color:var(--faint)]"> · {run.status.toLowerCase().replace("_", " ")}</span>
    </span>
  );
};

// A retry only lands once the last run is terminal; the API rejects the rest.
export const retryable = (task: Task): boolean => {
  const run = task.runs[0];
  if (!run) return false;
  if (run.status === "QUEUED" || run.status === "CLAIMED" || run.status === "PROVISIONING" || run.status === "RUNNING") return false;
  return task.status === "REVIEW" || task.failureReason !== null || run.status !== "SUCCEEDED";
};

const TaskCard = ({ task, onDelete, onRetry }: {
  task: Task;
  onDelete: (task: Task) => void;
  onRetry: (task: Task) => void;
}): ReactNode => {
  const run = task.runs[0];
  return (
    <article
      className={TASK_CARD}
      draggable
      onDragStart={(event) => event.dataTransfer.setData("text/plain", task.id)}
      onClick={() => navigate(`/tasks/${task.id}`)}
    >
      <div className={cn(ROW, "items-start")}>
        <h3 className="flex-1 text-[13px] leading-[1.45]">{task.name}</h3>
        <RowMenu items={[
          ...(retryable(task) ? [{ label: "Retry", onSelect: () => onRetry(task) }] : []),
          { label: "Delete", danger: true, onSelect: () => onDelete(task) },
        ]} />
      </div>
      <div className={TASK_META}>
        <div className={TASK_META_ROW}>
          <span>{task.scheduleKind === "NOW" ? "Once" : task.scheduleKind.toLowerCase()}</span>
          {task.approvalGate ? <Pill tone="amber">Approval</Pill> : null}
          {task.templateId ? <Pill tone="violet">Template</Pill> : null}
        </div>
        <div className={TASK_META_ROW}>{runLabel(task)}</div>
        {task.failureReason === null ? null : <div className={cn(TASK_META_ROW, "text-[var(--destructive-fg)]")}>{task.failureReason}</div>}
      </div>
      <div className={TASK_FOOT}>
        <span className={cn(ROW, "min-w-0 gap-[6px] overflow-hidden whitespace-nowrap")}>
          <IconRobot />
          <span className="overflow-hidden text-ellipsis">{task.assigneeAgent?.title ?? "Unassigned"}</span>
        </span>
        <span className="flex-1" />
        {run?.session?.costUsd ? <span className="whitespace-nowrap">{money(run.session.costUsd)}</span> : null}
        <span className="whitespace-nowrap">{timeAgo(task.updatedAt)}</span>
      </div>
    </article>
  );
};

const NewTask = ({ projectId, agents, repos, onClose, onCreated }: {
  projectId: string;
  agents: Agent[];
  repos: Repo[];
  onClose: () => void;
  onCreated: () => void;
}): ReactNode => {
  const templates = usePoll<TaskTemplate[]>(`/projects/${projectId}/task-templates`, 30_000);
  const activeAgents = agents.filter((agent) => !agent.archivedAt);
  const [mode, setMode] = useState<"blank" | "template">("blank");
  const [form, setForm] = useState({
    name: "", description: "",
    assigneeAgentId: activeAgents[0]?.id ?? "", repoId: repos[0]?.id ?? "", targetBranch: "",
    assigneeType: "AGENT" as "AGENT" | "HUMAN", approvalGate: false,
    maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 5,
  });
  const [templateId, setTemplateId] = useState("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const { pending, error, run } = useAction();

  const template = (templates.data ?? []).find((candidate) => candidate.id === templateId) ?? templates.data?.[0] ?? null;

  const createBlank = async (): Promise<void> => {
    const ok = await run(() => api.post(`/projects/${projectId}/tasks`, {
      name: form.name,
      description: form.description,
      assigneeType: form.assigneeType,
      assigneeAgentId: form.assigneeType === "AGENT" ? form.assigneeAgentId : null,
      repoId: form.repoId === "" ? null : form.repoId,
      targetBranch: form.targetBranch === "" ? null : form.targetBranch,
      approvalGate: form.approvalGate,
      maxDurationMin: form.maxDurationMin,
      stallTimeoutMin: form.stallTimeoutMin,
      maxSessionsPerTask: form.maxSessionsPerTask,
    }));
    if (ok) { onCreated(); onClose(); }
  };

  const createFromTemplate = async (): Promise<void> => {
    if (!template) return;
    const ok = await run(() => api.post(`/projects/${projectId}/task-templates/${template.id}/instantiate`, {
      repoId: form.repoId,
      variables,
      ...(form.name.trim() === "" ? {} : { name: form.name }),
    }));
    if (ok) { onCreated(); onClose(); }
  };

  return (
    <FullPanel title="New Task" onClose={onClose} actions={
      <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || (mode === "blank" ? form.name.trim() === "" : template === null)}
        onClick={() => void (mode === "blank" ? createBlank() : createFromTemplate())}>
        Create
      </Button>
    }>
      <Tabs value={mode} onChange={setMode} options={[{ value: "blank", label: "Blank task" }, { value: "template", label: "From template" }]} />
      {error === null ? null : <ErrorNotice message={error} />}

      {mode === "blank" ? (
        <Card title="Task">
          <div className={STACK}>
            <Field label="Title"><Input type="text" value={form.name} autoFocus onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Implement feat/inbox-search" /></Field>
            <Field label="Prompt" hint="Handed to the agent verbatim together with its foundation and role prompt.">
              <Textarea rows={10} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </Field>
            <div className={FIELD_ROW}>
              <Field label="Assignee type">
                <Select value={form.assigneeType} onChange={(event) => setForm({ ...form, assigneeType: event.target.value as "AGENT" | "HUMAN" })}>
                  <option value="AGENT">Agent</option>
                  <option value="HUMAN">Human</option>
                </Select>
              </Field>
              <Field label="Agent" hint="Agent tasks need an agent that already holds a grant on the repo.">
                <Select value={form.assigneeAgentId} disabled={form.assigneeType === "HUMAN"}
                  onChange={(event) => setForm({ ...form, assigneeAgentId: event.target.value })}>
                  {activeAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.title} · {agent.model}</option>)}
                </Select>
              </Field>
            </div>
            <div className={FIELD_ROW}>
              <Field label="Repo">
                <Select value={form.repoId} onChange={(event) => setForm({ ...form, repoId: event.target.value })}>
                  <option value="">No repo</option>
                  {repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
                </Select>
              </Field>
              <Field label="Target branch" hint="Empty falls back to the repo default branch.">
                <Input type="text" value={form.targetBranch} onChange={(event) => setForm({ ...form, targetBranch: event.target.value })} placeholder="feat/…" />
              </Field>
            </div>
            <div className={ROW}>
              <Toggle on={form.approvalGate} onChange={(next) => setForm({ ...form, approvalGate: next })} label="Requires approval" />
              <div>
                <div>Requires approval</div>
                <div>Template steps with a gate are decided in the Inbox — the board cannot close them.</div>
              </div>
            </div>
            <div className={FIELD_ROW}>
              <Field label="Wall-clock limit (minutes)" hint="The run is killed and the task moves to review after this many minutes.">
                <Input type="number" min={1} value={form.maxDurationMin} onChange={(event) => setForm({ ...form, maxDurationMin: Number(event.target.value) })} />
              </Field>
              <Field label="Stall timeout (minutes)" hint="No new tool call for this long counts as dead.">
                <Input type="number" min={1} value={form.stallTimeoutMin} onChange={(event) => setForm({ ...form, stallTimeoutMin: Number(event.target.value) })} />
              </Field>
              <Field label="Max runs per task" hint="Retries stop here and the Inbox gets an operator message.">
                <Input type="number" min={1} value={form.maxSessionsPerTask} onChange={(event) => setForm({ ...form, maxSessionsPerTask: Number(event.target.value) })} />
              </Field>
            </div>
          </div>
        </Card>
      ) : (
        <Card title="From template">
          {(templates.data ?? []).length === 0
            ? <EmptyState>No templates in this project yet.</EmptyState>
            : (
              <div className={STACK}>
                <Field label="Template">
                  <Select value={template?.id ?? ""} onChange={(event) => { setTemplateId(event.target.value); setVariables({}); }}>
                    {(templates.data ?? []).map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>{candidate.name} ({candidate.steps.length} steps)</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Repo">
                  <Select value={form.repoId} onChange={(event) => setForm({ ...form, repoId: event.target.value })}>
                    {repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
                  </Select>
                </Field>
                {(template?.variables ?? []).map((variable) => (
                  <Field key={variable} label={variable}>
                    <Input type="text" value={variables[variable] ?? ""}
                      onChange={(event) => setVariables({ ...variables, [variable]: event.target.value })}
                      placeholder={/branch/i.test(variable) ? "feat/…" : ""} />
                  </Field>
                ))}
                {template ? (
                  <div>
                    <div className={CARD_TITLE}>Will create</div>
                    <div className={CODE_BLOCK}>
                      {template.steps.map((step) => [
                        `- ${step.name}`,
                        step.assigneeAgent ? `    agent: ${step.assigneeAgent.title}` : "    agent: (human)",
                        step.approvalGate ? "    (approval gate)" : null,
                      ].filter((line) => line !== null).join("\n")).join("\n")}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
        </Card>
      )}
    </FullPanel>
  );
};

export const TasksPage = (): ReactNode => {
  const { projectId, project } = useProjectScope();
  const tasksPath = projectId === "" ? null : `/tasks?projectId=${encodeURIComponent(projectId)}`;
  const { data, loading, error, reload } = usePoll<Task[]>(tasksPath);
  const { data: agents } = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 15_000);
  const { data: repos } = usePoll<Repo[]>(projectId === "" ? null : `/projects/${projectId}/repos`, 15_000);
  const [creating, setCreating] = useState(false);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  const { error: actionError, run } = useAction();
  const tasks = useMemo(() => data ?? [], [data]);

  const move = (taskId: string, status: TaskStatus): void => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.status === status) return;
    void run(async () => { await api.patch(`/tasks/${taskId}`, { status }); reload(); });
  };
  const remove = (task: Task): void => {
    if (!window.confirm(`Delete task ${task.name}?`)) return;
    void run(async () => { await api.delete(`/tasks/${task.id}`); reload(); });
  };
  const retry = (task: Task): void => {
    void run(async () => { await api.post(`/tasks/${task.id}/retry`, {}); reload(); });
  };

  if (projectId === "") return <Page><EmptyState>Select a project first.</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>Tasks</h1>
          <div className={PAGE_HEAD_SUBTITLE}>Work queued for agents in {project?.name ?? "this project"}</div>
        </div>
        <div className={PAGE_ACTIONS}>
          <Button type="button" variant="legacyPrimary" size="legacy" onClick={() => setCreating(true)}><IconPlus />Create Task</Button>
        </div>
      </div>

      <Segmented options={[{ value: "board", label: "Tasks" }]} value="board" onChange={() => undefined} />

      <div className={cn(STACK, "mt-4")}>
        {error === null ? null : <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} />}
        {actionError === null ? null : <ErrorNotice message={actionError} />}

        <div className={BOARD}>
          {COLUMNS.map((column) => {
            const columnTasks = tasks.filter((task) => task.status === column.status);
            return (
              <div className={COLUMN} key={column.status}>
                <div className={COLUMN_HEAD}>{column.label}<span className={COUNT}>{columnTasks.length}</span></div>
                <div
                  className={cn(COLUMN_BODY, dragOver === column.status && COLUMN_BODY_OVER)}
                  onDragOver={(event) => { event.preventDefault(); setDragOver(column.status); }}
                  onDragLeave={() => setDragOver((current) => (current === column.status ? null : current))}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragOver(null);
                    move(event.dataTransfer.getData("text/plain"), column.status);
                  }}
                >
                  {columnTasks.map((task) => <TaskCard key={task.id} task={task} onDelete={remove} onRetry={retry} />)}
                  {columnTasks.length === 0 ? <div className={COLUMN_EMPTY}>{loading ? "Loading…" : "Drop tasks here"}</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {creating ? (
        <NewTask projectId={projectId} agents={agents ?? []} repos={repos ?? []}
          onClose={() => setCreating(false)} onCreated={reload} />
      ) : null}
    </Page>
  );
};
