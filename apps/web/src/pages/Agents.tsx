import { type ReactNode, useEffect, useState } from "react";

import { api } from "../lib/api";
import { formatDate, formatDateTime, titleCase } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import type { Agent, Environment, FilesystemGrant, MCPConnection, RepoPermission, RunnerPreference, Skill, Repo } from "../lib/types";
import { IconArrowLeft, IconPlus, IconRobot } from "../components/icons";
import {
  Card, Check, EmptyState, ErrorNotice, Field, FullPanel, KeyValue, Pill,
  RowMenu, Segmented, Tabs, Toggle,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";

const RUNNERS: RunnerPreference[] = ["INHERIT", "AUTO", "CLAUDE", "CODEX", "PI"];

const NewAgent = ({ projectId, onClose, onCreated }: {
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}): ReactNode => {
  const environments = usePoll<Environment[]>(`/projects/${projectId}/environments`, 30_000);
  const [form, setForm] = useState({
    name: "", title: "", model: "claude", environmentId: "",
    runnerPreference: "INHERIT" as RunnerPreference, inboxAccess: false,
    foundationalPrompt: "You are an AgentOS worker. Work only on the assigned task in the provided working directory.",
    rolePrompt: "",
  });
  const { pending, error, run } = useAction();

  useEffect(() => {
    const first = environments.data?.[0];
    if (first && form.environmentId === "") setForm((current) => ({ ...current, environmentId: first.id }));
  }, [environments.data, form.environmentId]);

  const submit = async (): Promise<void> => {
    const ok = await run(() => api.post<Agent>(`/projects/${projectId}/agents`, form));
    if (ok) { onCreated(); onClose(); }
  };

  return (
    <FullPanel title="New Agent" onClose={onClose} actions={
      <Button type="button" className="btn primary" disabled={pending || form.name.trim() === "" || form.environmentId.trim() === ""}
        onClick={() => void submit()}>Create</Button>
    }>
      {error === null ? null : <ErrorNotice message={error} />}
      <Card title="Setup">
        <div className="stack">
          <div className="fieldRow">
            <Field label="Name" hint="Unique inside the project; used by YAML and the CLI.">
              <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="senior-dev" />
            </Field>
            <Field label="Title">
              <Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Senior Developer" />
            </Field>
          </div>
          <div className="fieldRow">
            <Field label="Model">
              <Input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder="claude" />
            </Field>
            <Field label="Runner" hint="INHERIT falls back to the model heuristic in execution.ts.">
              <select value={form.runnerPreference} onChange={(event) => setForm({ ...form, runnerPreference: event.target.value as RunnerPreference })}>
                {RUNNERS.map((runner) => <option key={runner} value={runner}>{runner.toLowerCase()}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Environment ID" hint={environments.missing
            ? "无环境列表端点，请粘贴 Environment ID（POST /projects/:id/agents 必填）。"
            : "Sandbox and env-var scope for this agent."}>
            {environments.data && environments.data.length > 0
              ? (
                <select value={form.environmentId} onChange={(event) => setForm({ ...form, environmentId: event.target.value })}>
                  {environments.data.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}
                </select>
              )
              : <Input value={form.environmentId} onChange={(event) => setForm({ ...form, environmentId: event.target.value })} placeholder="cuid" />}
          </Field>
          <div className="row">
            <Toggle on={form.inboxAccess} onChange={(next) => setForm({ ...form, inboxAccess: next })} label="Inbox access" />
            <div>
              <div>Inbox access</div>
              <div className="hint">Lets the agent ask questions and post updates through the Inbox MCP.</div>
            </div>
          </div>
        </div>
      </Card>
      <Card title="Prompt">
        <div className="stack">
          <Field label="AgentOS foundation" hint="Prepended above the role prompt for every run.">
            <Textarea rows={4} value={form.foundationalPrompt} onChange={(event) => setForm({ ...form, foundationalPrompt: event.target.value })} />
          </Field>
          <Field label="Your agent instructions">
            <Textarea rows={10} value={form.rolePrompt} onChange={(event) => setForm({ ...form, rolePrompt: event.target.value })}
              placeholder="You are Senior Dev — a senior engineer with strong taste…" />
          </Field>
        </div>
      </Card>
    </FullPanel>
  );
};

export const AgentsPage = (): ReactNode => {
  const { projectId, project } = useProjectScope();
  const { data, loading, error, reload } = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 5_000);
  const [creating, setCreating] = useState(false);
  const { error: actionError, run } = useAction();
  const agents = data ?? [];

  const remove = (agent: Agent): void => {
    if (!window.confirm(`Delete agent ${agent.name}?`)) return;
    void run(async () => { await api.delete(`/agents/${agent.id}`); reload(); });
  };

  if (projectId === "") return <div className="page"><EmptyState>Select a project first.</EmptyState></div>;

  return (
    <div className="page text-foreground">
      <div className="pageHead">
        <div className="titles">
          <h1>Agents</h1>
          <div className="subtitle">Roles, prompts and permission boundaries in {project?.name ?? "this project"}</div>
        </div>
        <div className="pageActions">
          <Button type="button" className="btn primary" onClick={() => setCreating(true)}><IconPlus />Create Agent</Button>
        </div>
      </div>

      <Segmented options={[{ value: "yours", label: "Your Agents" }]} value="yours" onChange={() => undefined} />

      <div className="stack mt-4">
        {error === null ? null : <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} />}
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        <Card flush>
          <div className="tableWrap">
            <Table className="table">
              <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Model</TableHead><TableHead>Runner</TableHead><TableHead>Inbox</TableHead><TableHead>Updated</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {agents.map((agent) => (
                  <TableRow key={agent.id} className="clickable" onClick={() => navigate(`/agents/${agent.id}`)}>
                    <TableCell className="name">{agent.title}<span className="sub">{agent.name}</span></TableCell>
                    <TableCell>{agent.model}</TableCell>
                    <TableCell>{agent.runnerPreference.toLowerCase()}</TableCell>
                    <TableCell>{agent.inboxAccess ? <Pill tone="green">Enabled</Pill> : <Pill tone="grey">Off</Pill>}</TableCell>
                    <TableCell>{formatDate(agent.updatedAt)}</TableCell>
                    <TableCell className="tight"><RowMenu items={[{ label: "Delete", danger: true, onSelect: () => remove(agent) }]} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {agents.length === 0 ? <EmptyState>{loading ? "Loading…" : "No agents in this project yet."}</EmptyState> : null}
          </div>
        </Card>
      </div>

      {creating ? <NewAgent projectId={projectId} onClose={() => setCreating(false)} onCreated={reload} /> : null}
    </div>
  );
};

type AgentTab = "setup" | "prompt" | "capabilities" | "collaborators";

const RepoAccessRow = ({ agent, repo, granted, onDone }: {
  agent: Agent;
  repo: Repo;
  granted: { permissions: RepoPermission; mountPath: string } | null;
  onDone: () => void;
}): ReactNode => {
  const [permissions, setPermissions] = useState<RepoPermission>(granted?.permissions ?? "GIT_WRITE");
  const [mountPath, setMountPath] = useState(granted?.mountPath ?? repo.mountPath);
  const { pending, error, run } = useAction();
  const grant = (): void => {
    void run(async () => {
      await api.post(`/agents/${agent.id}/repos/${repo.id}/access`, { permissions, mountPath });
      onDone();
    });
  };
  return (
    <div className="stack border-t border-[var(--border-soft)] pt-3.5">
      <div className="row">
        <div className="min-w-0 flex-1">
          <div className="strong">{repo.name}</div>
          <div className="hint">{repo.remoteUrl} · default {repo.defaultBranch}</div>
        </div>
        {granted ? <Pill tone="green">granted</Pill> : null}
      </div>
      <div className="fieldRow">
        <Field label="Permission">
          <select value={permissions} onChange={(event) => setPermissions(event.target.value as RepoPermission)}>
            <option value="GIT_READ">git-read</option>
            <option value="GIT_WRITE">git-write</option>
          </select>
        </Field>
        <Field label="Mount path">
          <Input value={mountPath} onChange={(event) => setMountPath(event.target.value)} />
        </Field>
        <div className="field">
          <label>&nbsp;</label>
          <Button type="button" className="btn primary" disabled={pending} onClick={grant}>Grant / update access</Button>
        </div>
      </div>
      {error === null ? null : <ErrorNotice message={error} />}
    </div>
  );
};

const BindingToggle = ({ on, label, add, remove, onDone }: {
  on: boolean;
  label: string;
  add: () => Promise<unknown>;
  remove: () => Promise<unknown>;
  onDone: () => void;
}): ReactNode => {
  const { pending, error, run } = useAction();
  const change = (next: boolean): void => {
    void run(async () => {
      if (next) await add();
      else await remove();
      onDone();
    });
  };
  return <div>{error === null ? null : <ErrorNotice message={error} />}<Toggle on={on} onChange={change} disabled={pending} label={label} /></div>;
};

const FilesystemGrantRow = ({ agentId, grant, onDone }: { agentId: string; grant: FilesystemGrant; onDone: () => void }): ReactNode => {
  const { pending, error, run } = useAction();
  const patch = (key: "canRead" | "canWrite" | "canDelete", value: boolean): void => {
    void run(async () => {
      await api.patch(`/agents/${agentId}/filesystem-grants/${grant.id}`, {
        canRead: grant.canRead, canWrite: grant.canWrite, canDelete: grant.canDelete, [key]: value,
      });
      onDone();
    });
  };
  const remove = (): void => {
    void run(async () => {
      await api.delete(`/agents/${agentId}/filesystem-grants/${grant.id}`);
      onDone();
    });
  };
  return (
    <TableRow>
      <TableCell className="name">{grant.folderPath}{error === null ? null : <span className="sub">{error}</span>}</TableCell>
      <TableCell><Check on={grant.canRead} onChange={(value) => patch("canRead", value)} disabled={pending} label={`Read ${grant.folderPath}`} /></TableCell>
      <TableCell><Check on={grant.canWrite} onChange={(value) => patch("canWrite", value)} disabled={pending} label={`Write ${grant.folderPath}`} /></TableCell>
      <TableCell><Check on={grant.canDelete} onChange={(value) => patch("canDelete", value)} disabled={pending} label={`Delete in ${grant.folderPath}`} /></TableCell>
      <TableCell className="tight"><RowMenu items={[{ label: "Remove", danger: true, onSelect: remove }]} /></TableCell>
    </TableRow>
  );
};

const NewFilesystemGrant = ({ agentId, onDone }: { agentId: string; onDone: () => void }): ReactNode => {
  const [folderPath, setFolderPath] = useState("");
  const [permissions, setPermissions] = useState({ canRead: true, canWrite: false, canDelete: false });
  const { pending, error, run } = useAction();
  const submit = async (): Promise<void> => {
    const ok = await run(() => api.post(`/agents/${agentId}/filesystem-grants`, { folderPath, ...permissions }));
    if (ok) { setFolderPath(""); setPermissions({ canRead: true, canWrite: false, canDelete: false }); onDone(); }
  };
  const any = permissions.canRead || permissions.canWrite || permissions.canDelete;
  return (
    <div className="stack mb-3.5">
      {error === null ? null : <ErrorNotice message={error} />}
      <div className="fieldRow">
        <Field label="Folder path"><Input value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="/absolute/path" /></Field>
        <Field label="Permissions">
          <div className="row min-h-[34px]">
            {(["canRead", "canWrite", "canDelete"] as const).map((key) => (
              <span className="row" key={key}><Check on={permissions[key]} onChange={(value) => setPermissions({ ...permissions, [key]: value })} label={key} />{key.slice(3)}</span>
            ))}
          </div>
        </Field>
        <div className="field"><label>&nbsp;</label><Button type="button" className="btn primary" disabled={pending || folderPath.trim() === "" || !any} onClick={() => void submit()}>Grant access</Button></div>
      </div>
    </div>
  );
};

const CapabilitiesTab = ({ agent, projectId, onSaved }: { agent: Agent; projectId: string; onSaved: () => void }): ReactNode => {
  const repos = usePoll<Repo[]>(`/projects/${projectId}/repos`, 10_000);
  const skills = usePoll<Skill[]>(`/projects/${projectId}/skills`, 30_000);
  const connections = usePoll<MCPConnection[]>(`/projects/${projectId}/mcp-connections`, 30_000);
  const grantedRepos = agent.repoAccess ?? null;

  return (
    <div className="stack">
      <Card title="Repositories" extra={<span className="count">{(repos.data ?? []).length}</span>}>
        {(repos.data ?? []).length === 0
          ? <EmptyState>No repos in this project.</EmptyState>
          : (repos.data ?? []).map((repo) => (
            <RepoAccessRow key={repo.id} agent={agent} repo={repo} onDone={onSaved}
              granted={grantedRepos?.find((access) => access.repoId === repo.id) ?? null} />
          ))}
      </Card>

      <Card title="Skills" extra={<span className="count">{(skills.data ?? []).length}</span>}>
        {(skills.data ?? []).length === 0
          ? <EmptyState>No skills defined in this project.</EmptyState>
          : (skills.data ?? []).map((skill) => {
            const mounted = (agent.skills ?? []).some((entry) => entry.skillId === skill.id);
            return (
              <div key={skill.id} className="row border-t border-[var(--border-soft)] py-2.5">
                <div className="flex-1">
                  <div className="strong">{skill.name}</div>
                  <div className="hint">{skill.kind.toLowerCase()} · {skill.slug}</div>
                </div>
                <BindingToggle on={mounted} label={`Mount ${skill.name}`}
                  add={() => api.post(`/agents/${agent.id}/skills`, { skillId: skill.id })}
                  remove={() => api.delete(`/agents/${agent.id}/skills/${skill.id}`)} onDone={onSaved} />
              </div>
            );
          })}
      </Card>

      <Card title="MCP Connections" extra={<span className="count">{(connections.data ?? []).length}</span>}>
        {(connections.data ?? []).length === 0 ? <EmptyState>No MCP connections in this project.</EmptyState> : (connections.data ?? []).map((connection) => {
          const bound = (agent.mcpConnections ?? []).some((entry) => entry.mcpConnectionId === connection.id);
          return (
            <div key={connection.id} className="row border-t border-[var(--border-soft)] py-2.5">
              <div className="flex-1">
                <div className="strong">{connection.name}</div>
                <div className="hint">{connection.transport}</div>
              </div>
              <BindingToggle on={bound} label={`Bind ${connection.name}`}
                add={() => api.post(`/agents/${agent.id}/mcp-connections`, { mcpConnectionId: connection.id })}
                remove={() => api.delete(`/agents/${agent.id}/mcp-connections/${connection.id}`)} onDone={onSaved} />
            </div>
          );
        })}
      </Card>

      <Card title="Secrets" extra={<span className="count">{(agent.secretGrants ?? []).length}</span>}>
        {(agent.secretGrants ?? []).length === 0
          ? <EmptyState>No secrets granted to this agent.</EmptyState>
          : (agent.secretGrants ?? []).map((grant) => (
            <div key={`${grant.secretId}:${grant.envVar}`} className="row border-t border-[var(--border-soft)] py-2.5">
              <div className="flex-1"><div className="strong">{grant.secret?.name ?? grant.secretId}</div><div className="hint">{grant.envVar}</div></div>
            </div>
          ))}
      </Card>

      <Card title="Filesystem grants" extra={<span className="count">{(agent.filesystemGrants ?? []).length}</span>}>
        <NewFilesystemGrant agentId={agent.id} onDone={onSaved} />
        <div className="tableWrap">
              <Table className="table">
                <TableHeader><TableRow><TableHead>Folder</TableHead><TableHead>Read</TableHead><TableHead>Write</TableHead><TableHead>Delete</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>
                  {(agent.filesystemGrants ?? []).map((grant) => (
                    <FilesystemGrantRow key={grant.id} agentId={agent.id} grant={grant} onDone={onSaved} />
                  ))}
                </TableBody>
              </Table>
              {(agent.filesystemGrants ?? []).length === 0 ? <EmptyState>No filesystem grants.</EmptyState> : null}
            </div>
      </Card>
    </div>
  );
};

export const AgentDetailPage = ({ agentId }: { agentId: string }): ReactNode => {
  const { data: agent, error, reload } = usePoll<Agent>(`/agents/${agentId}`, 5_000);
  const [tab, setTab] = useState<AgentTab>("setup");
  const [draft, setDraft] = useState<Agent | null>(null);
  const { pending, error: actionError, run } = useAction();
  const projectId = agent?.projectId ?? "";
  const { data: siblings } = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 15_000);

  if (error !== null && agent === null) {
    return <div className="page"><ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /></div>;
  }
  if (!agent) return <div className="page"><EmptyState>Loading…</EmptyState></div>;

  const view = draft ?? agent;
  const patch = (changes: Partial<Agent>): void => setDraft({ ...view, ...changes });
  const save = async (): Promise<void> => {
    if (!draft) return;
    const ok = await run(() => api.patch(`/agents/${agentId}`, {
      name: draft.name, title: draft.title, model: draft.model,
      runnerPreference: draft.runnerPreference, inboxAccess: draft.inboxAccess,
      foundationalPrompt: draft.foundationalPrompt, rolePrompt: draft.rolePrompt,
    }));
    if (ok) { setDraft(null); reload(); }
  };

  return (
    <div className="page text-foreground">
      <div className="detailHead">
        <Link to="/agents" className="backLink"><IconArrowLeft /></Link>
        <span className="text-[var(--status-violet-fg)]"><IconRobot /></span>
        <h1>{view.title}</h1>
        <Pill tone="grey">{view.model}</Pill>
        <Pill tone="violet">runner {view.runnerPreference.toLowerCase()}</Pill>
        <span className="spacer" />
        {draft === null
          ? <Button type="button" className="btn" onClick={() => setDraft(agent)}>Edit</Button>
          : (
            <>
              <Button type="button" className="btn" onClick={() => setDraft(null)}>Cancel</Button>
              <Button type="button" className="btn primary" disabled={pending} onClick={() => void save()}>Save</Button>
            </>
          )}
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "setup", label: "Setup" },
          { value: "prompt", label: "Prompt" },
          { value: "capabilities", label: "Capabilities" },
          { value: "collaborators", label: "Collaborators" },
        ]}
      />

      <div className="stack">
        {actionError === null ? null : <ErrorNotice message={actionError} />}

        {tab === "setup" ? (
          <Card title="Details">
            {draft === null ? (
              <KeyValue items={[
                { k: "Name", v: view.name },
                { k: "Title", v: view.title },
                { k: "Model", v: view.model },
                { k: "Runner preference", v: view.runnerPreference.toLowerCase() },
                { k: "Environment", v: <span className="small">{view.environmentId}</span> },
                { k: "Inbox access", v: view.inboxAccess ? "Enabled" : "Off" },
                { k: "Created", v: formatDateTime(view.createdAt) },
                { k: "Updated", v: formatDateTime(view.updatedAt) },
              ]} />
            ) : (
              <div className="stack">
                <div className="fieldRow">
                  <Field label="Name"><Input value={view.name} onChange={(event) => patch({ name: event.target.value })} /></Field>
                  <Field label="Title"><Input value={view.title} onChange={(event) => patch({ title: event.target.value })} /></Field>
                </div>
                <div className="fieldRow">
                  <Field label="Model"><Input value={view.model} onChange={(event) => patch({ model: event.target.value })} /></Field>
                  <Field label="Runner preference" hint="INHERIT 时按 execution.ts 的模型名启发式选 runner。">
                    <select value={view.runnerPreference} onChange={(event) => patch({ runnerPreference: event.target.value as RunnerPreference })}>
                      {RUNNERS.map((runner) => <option key={runner} value={runner}>{runner.toLowerCase()}</option>)}
                    </select>
                  </Field>
                </div>
                <div className="row">
                  <Toggle on={view.inboxAccess} onChange={(next) => patch({ inboxAccess: next })} label="Inbox access" />
                  <div>
                    <div>Inbox access</div>
                    <div className="hint">Lets this agent ask questions and post updates through the Inbox.</div>
                  </div>
                </div>
              </div>
            )}
          </Card>
        ) : null}

        {tab === "prompt" ? (
          <>
            <Card title="AgentOS Foundation" extra={<Pill tone="grey">prepended</Pill>}>
              {draft === null
                ? <div className="codeBlock">{view.foundationalPrompt}</div>
                : <Textarea rows={6} value={view.foundationalPrompt} onChange={(event) => patch({ foundationalPrompt: event.target.value })} />}
              <div className="hint mt-2.5">This text is placed above the agent instructions for every run.</div>
            </Card>
            <Card title="Your agent instructions">
              {draft === null
                ? <div className="codeBlock">{view.rolePrompt}</div>
                : <Textarea rows={18} value={view.rolePrompt} onChange={(event) => patch({ rolePrompt: event.target.value })} />}
            </Card>
          </>
        ) : null}

        {tab === "capabilities" ? <CapabilitiesTab agent={agent} projectId={projectId} onSaved={reload} /> : null}

        {tab === "collaborators" ? (
          <Card title="Collaborators">
            <div className="hint mb-3">
              Agents this agent may spawn for subtasks. Bindings live in AgentCollaboration.
            </div>
            <div className="mt-3">
              {(siblings ?? []).filter((candidate) => candidate.id !== agent.id).map((candidate) => (
                <div key={candidate.id} className="row border-t border-[var(--border-soft)] py-2.5">
                  <div className="flex-1">
                    <div className="strong">{candidate.title}</div>
                    <div className="hint">{titleCase(candidate.name)} · {candidate.model}</div>
                  </div>
                  <BindingToggle on={(agent.collaborators ?? []).some((entry) => entry.allowedAgentId === candidate.id)} label={`Allow ${candidate.name}`}
                    add={() => api.post(`/agents/${agent.id}/collaborators`, { allowedAgentId: candidate.id })}
                    remove={() => api.delete(`/agents/${agent.id}/collaborators/${candidate.id}`)} onDone={reload} />
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
};
