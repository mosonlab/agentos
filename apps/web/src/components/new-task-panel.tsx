import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { useAction, usePoll } from "../lib/hooks";
import type { Agent, Repo, TaskTemplate } from "../lib/types";
import {
  CARD_TITLE, CODE_BLOCK, FIELD_ROW, ROW, STACK,
  Card, EmptyState, ErrorNotice, Field, FullPanel, Tabs, Toggle,
} from "./ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Textarea } from "./ui/textarea";

/* Hoisted verbatim out of pages/Tasks.tsx so all four Tasks tabs can open it:
 * `+ Create Task` lives in the shared page head, and a button that does nothing
 * on three of the four tabs is not a button. The body below is a pure
 * relocation — only the `export` keyword is new. */

export const NewTask = ({ projectId, agents, repos, onClose, onCreated }: {
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
                {/* Same as TaskDetail's status select: no `select:disabled` rule
                    existed, and this one is disabled in the form's default state
                    (assignee HUMAN), so the primitive's dimming would be visible
                    at rest. */}
                <Select className="disabled:opacity-100 disabled:cursor-default" value={form.assigneeAgentId} disabled={form.assigneeType === "HUMAN"}
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
