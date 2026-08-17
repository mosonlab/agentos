import { type ReactNode, useEffect, useState } from "react";

import { api } from "../lib/api";
import { formatDate, formatDateTime, titleCase } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import type { Agent, Environment, FilesystemGrant, MCPConnection, RepoPermission, RunnerPreference, Skill, Repo } from "../lib/types";
import { IconArrowLeft, IconPlus, IconRobot } from "../components/icons";
import { ModelLabel, ModelPicker, modelForSave } from "../components/model-picker";
import { runnerForModel, validateModelPair } from "../lib/models";
import { cn } from "../lib/utils";
import {
  BACK_LINK, CODE_BLOCK, COUNT, DETAIL_HEAD, DETAIL_HEAD_H1, FIELD, FIELD_LABEL, FIELD_ROW,
  PAGE_ACTIONS, PAGE_HEAD, PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, ROW, STACK,
  TABLE_NAME, TABLE_SUB, TABLE_TIGHT,
  Card, Check, EmptyState, ErrorNotice, Field, FullPanel, KeyValue, Page, Pill,
  RowMenu, Segmented, Tabs, Toggle,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";

export const NewAgent = ({ projectId, onClose, onCreated, initial }: {
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
  /** Deterministic starting values for focused form tests; production omits it. */
  initial?: Partial<{ name: string; model: string; environmentId: string; runnerPreference: RunnerPreference }>;
}): ReactNode => {
  const environments = usePoll<Environment[]>(`/projects/${projectId}/environments`, 30_000);
  const [form, setForm] = useState({
    name: initial?.name ?? "", title: "", model: initial?.model ?? "claude-opus-5:high", environmentId: initial?.environmentId ?? "",
    runnerPreference: initial?.runnerPreference ?? "CLAUDE" as RunnerPreference, inboxAccess: false,
    foundationalPrompt: "You are an AgentOS worker. Work only on the assigned task in the provided working directory.",
    rolePrompt: "",
  });
  const { pending, error, run } = useAction();
  const t = useT();

  useEffect(() => {
    const first = environments.data?.[0];
    if (first && form.environmentId === "") setForm((current) => ({ ...current, environmentId: first.id }));
  }, [environments.data, form.environmentId]);

  const submit = async (): Promise<void> => {
    const ok = await run(() => api.post<Agent>(`/projects/${projectId}/agents`, {
      ...form,
      model: modelForSave(form.model),
      runnerPreference: runnerForModel(form.model) ?? form.runnerPreference,
    }));
    if (ok) { onCreated(); onClose(); }
  };

  return (
    <FullPanel title={t("agents.new.title")} onClose={onClose} actions={
      <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || form.name.trim() === "" || form.environmentId.trim() === "" || validateModelPair(form.model, form.runnerPreference) !== null}
        onClick={() => void submit()}>{t("agents.new.create")}</Button>
    }>
      {error === null ? null : <ErrorNotice message={error} />}
      <Card title={t("agents.tab.setup")}>
        <div className={STACK}>
          <div className={FIELD_ROW}>
            <Field label={t("agents.field.name.label")} hint={t("agents.field.name.hint")}>
              <Input type="text" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="senior-dev" />
            </Field>
            <Field label={t("agents.field.title")}>
              <Input type="text" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder={t("agents.field.title.placeholder")} />
            </Field>
          </div>
          <ModelPicker model={form.model} runnerPreference={form.runnerPreference} onChange={(next) => setForm({ ...form, ...next })} />
          <div><Link to="/settings" className="text-[var(--accent)] hover:underline">{t("agents.model.settingsHint")}</Link></div>
          <Field label={t("agents.field.environment.label")} hint={t(environments.missing
            ? "agents.field.environment.hint.missing"
            : "agents.field.environment.hint")}>
            {environments.data && environments.data.length > 0
              ? (
                <Select value={form.environmentId} onChange={(event) => setForm({ ...form, environmentId: event.target.value })}>
                  {environments.data.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}
                </Select>
              )
              : <Input type="text" value={form.environmentId} onChange={(event) => setForm({ ...form, environmentId: event.target.value })} placeholder="cuid" />}
          </Field>
          <div className={ROW}>
            <Toggle on={form.inboxAccess} onChange={(next) => setForm({ ...form, inboxAccess: next })} label={t("agents.inbox.label")} />
            <div>
              <div>{t("agents.inbox.label")}</div>
              <div>{t("agents.inbox.hint.new")}</div>
            </div>
          </div>
        </div>
      </Card>
      <Card title={t("agents.tab.prompt")}>
        <div className={STACK}>
          <Field label={t("agents.field.foundation.label")} hint={t("agents.field.foundation.hint")}>
            <Textarea rows={4} value={form.foundationalPrompt} onChange={(event) => setForm({ ...form, foundationalPrompt: event.target.value })} />
          </Field>
          <Field label={t("agents.field.rolePrompt")}>
            <Textarea rows={10} value={form.rolePrompt} onChange={(event) => setForm({ ...form, rolePrompt: event.target.value })}
              placeholder={t("agents.field.rolePrompt.placeholder")} />
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
  const t = useT();
  const agents = data ?? [];

  const remove = (agent: Agent): void => {
    if (!window.confirm(t("agents.confirm.delete", { name: agent.name }))) return;
    void run(async () => { await api.delete(`/agents/${agent.id}`); reload(); });
  };
  const toggleArchived = (agent: Agent): void => {
    const action = agent.archivedAt ? "unarchive" : "archive";
    void run(async () => { await api.post(`/agents/${agent.id}/${action}`); reload(); });
  };

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("agents.head.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>{t("agents.head.subtitle", { project: project?.name ?? t("agents.head.thisProject") })}</div>
        </div>
        <div className={PAGE_ACTIONS}>
          <Button type="button" variant="legacyPrimary" size="legacy" onClick={() => setCreating(true)}><IconPlus />{t("agents.create")}</Button>
        </div>
      </div>

      <Segmented options={[{ value: "yours", label: t("agents.segmented.yours") }]} value="yours" onChange={() => undefined} />

      <div className={cn(STACK, "mt-4")}>
        {error === null ? null : <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} />}
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        <Card flush>
          <Table>
            <TableHeader><TableRow><TableHead>{t("agents.table.name")}</TableHead><TableHead>{t("agents.field.model")}</TableHead><TableHead>{t("agents.field.runner")}</TableHead><TableHead>{t("agents.table.inbox")}</TableHead><TableHead>{t("common.updated")}</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {agents.map((agent) => (
                <TableRow key={agent.id} className="cursor-pointer" onClick={() => navigate(`/agents/${agent.id}`)}>
                  <TableCell className={TABLE_NAME}>
                    <span className={ROW}>{agent.title}{agent.archivedAt ? <Pill tone="grey">{t("tasks.tab.archived")}</Pill> : null}</span>
                    <span className={TABLE_SUB}>{agent.name}</span>
                  </TableCell>
                  <TableCell><ModelLabel model={agent.model} /></TableCell>
                  <TableCell>{agent.runnerPreference.toLowerCase()}</TableCell>
                  <TableCell>{agent.inboxAccess ? <Pill tone="green">{t("agents.inbox.on")}</Pill> : <Pill tone="grey">{t("agents.inbox.off")}</Pill>}</TableCell>
                  <TableCell>{formatDate(agent.updatedAt)}</TableCell>
                  <TableCell className={TABLE_TIGHT}><RowMenu items={[
                    { label: t(agent.archivedAt ? "archived.menu.unarchive" : "tasks.menu.archive"), onSelect: () => toggleArchived(agent) },
                    { label: t("common.delete"), danger: true, onSelect: () => remove(agent) },
                  ]} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {agents.length === 0 ? <EmptyState>{t(loading ? "common.loading" : "agents.empty")}</EmptyState> : null}
        </Card>
      </div>

      {creating ? <NewAgent projectId={projectId} onClose={() => setCreating(false)} onCreated={reload} /> : null}
    </Page>
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
  const t = useT();
  const grant = (): void => {
    void run(async () => {
      await api.post(`/agents/${agent.id}/repos/${repo.id}/access`, { permissions, mountPath });
      onDone();
    });
  };
  return (
    <div className={cn(STACK, "border-t border-[var(--border-soft)] pt-3.5")}>
      <div className={ROW}>
        <div className="min-w-0 flex-1">
          <div className="text-foreground">{repo.name}</div>
          <div>{t("agents.repo.default", { remote: repo.remoteUrl, branch: repo.defaultBranch })}</div>
        </div>
        {granted ? <Pill tone="green">{t("agents.repo.granted")}</Pill> : null}
      </div>
      <div className={FIELD_ROW}>
        <Field label={t("agents.repo.permission")}>
          <Select value={permissions} onChange={(event) => setPermissions(event.target.value as RepoPermission)}>
            <option value="GIT_READ">git-read</option>
            <option value="GIT_WRITE">git-write</option>
          </Select>
        </Field>
        <Field label={t("agents.repo.mountPath")}>
          <Input type="text" value={mountPath} onChange={(event) => setMountPath(event.target.value)} />
        </Field>
        <div className={FIELD}>
          <label className={FIELD_LABEL}>&nbsp;</label>
          <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending} onClick={grant}>{t("agents.repo.grant")}</Button>
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
  /* The wrapper is a `ROW`, not a bare block, for the same reason the other four
   * `Toggle` call sites are: inside a block container the switch is an inline-flex
   * box whose baseline is now its thumb's bottom margin edge — 3px above the root's
   * bottom border edge, because of the `border-[3px]` that reproduces the legacy
   * knob inset (ui.tsx:280). Baseline alignment then drops the whole switch by
   * exactly 3.00 px, which is the drift the batch-1 screenshot re-shoot measured on
   * `agents-toggle-*`. As a flex item the switch is blockified and no baseline
   * applies. The 3px border itself is correct and stays. */
  return <div className={ROW}>{error === null ? null : <ErrorNotice message={error} />}<Toggle on={on} onChange={change} disabled={pending} label={label} /></div>;
};

const FilesystemGrantRow = ({ agentId, grant, onDone }: { agentId: string; grant: FilesystemGrant; onDone: () => void }): ReactNode => {
  const { pending, error, run } = useAction();
  const t = useT();
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
      <TableCell className={TABLE_NAME}>{grant.folderPath}{error === null ? null : <span className={TABLE_SUB}>{error}</span>}</TableCell>
      <TableCell><Check on={grant.canRead} onChange={(value) => patch("canRead", value)} disabled={pending} label={t("agents.fs.read", { path: grant.folderPath })} /></TableCell>
      <TableCell><Check on={grant.canWrite} onChange={(value) => patch("canWrite", value)} disabled={pending} label={t("agents.fs.write", { path: grant.folderPath })} /></TableCell>
      <TableCell><Check on={grant.canDelete} onChange={(value) => patch("canDelete", value)} disabled={pending} label={t("agents.fs.delete", { path: grant.folderPath })} /></TableCell>
      <TableCell className={TABLE_TIGHT}><RowMenu items={[{ label: t("agents.fs.remove"), danger: true, onSelect: remove }]} /></TableCell>
    </TableRow>
  );
};

const NewFilesystemGrant = ({ agentId, onDone }: { agentId: string; onDone: () => void }): ReactNode => {
  const [folderPath, setFolderPath] = useState("");
  const [permissions, setPermissions] = useState({ canRead: true, canWrite: false, canDelete: false });
  const { pending, error, run } = useAction();
  const t = useT();
  const submit = async (): Promise<void> => {
    const ok = await run(() => api.post(`/agents/${agentId}/filesystem-grants`, { folderPath, ...permissions }));
    if (ok) { setFolderPath(""); setPermissions({ canRead: true, canWrite: false, canDelete: false }); onDone(); }
  };
  const any = permissions.canRead || permissions.canWrite || permissions.canDelete;
  return (
    <div className={cn(STACK, "mb-3.5")}>
      {error === null ? null : <ErrorNotice message={error} />}
      <div className={FIELD_ROW}>
        <Field label={t("agents.fs.folderPath")}><Input type="text" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="/absolute/path" /></Field>
        <Field label={t("agents.fs.permissions")}>
          <div className={cn(ROW, "min-h-[34px]")}>
            {(["canRead", "canWrite", "canDelete"] as const).map((key) => (
              <span className={ROW} key={key}><Check on={permissions[key]} onChange={(value) => setPermissions({ ...permissions, [key]: value })} label={t(`agents.fs.${key}`)} />{t(`agents.fs.${key}`)}</span>
            ))}
          </div>
        </Field>
        <div className={FIELD}><label className={FIELD_LABEL}>&nbsp;</label><Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || folderPath.trim() === "" || !any} onClick={() => void submit()}>{t("agents.fs.grant")}</Button></div>
      </div>
    </div>
  );
};

const CapabilitiesTab = ({ agent, projectId, onSaved }: { agent: Agent; projectId: string; onSaved: () => void }): ReactNode => {
  const repos = usePoll<Repo[]>(`/projects/${projectId}/repos`, 10_000);
  const skills = usePoll<Skill[]>(`/projects/${projectId}/skills`, 30_000);
  const connections = usePoll<MCPConnection[]>(`/projects/${projectId}/mcp-connections`, 30_000);
  const grantedRepos = agent.repoAccess ?? null;
  const t = useT();

  return (
    <div className={STACK}>
      <Card title={t("agents.cap.repos")} extra={<span className={COUNT}>{(repos.data ?? []).length}</span>}>
        {(repos.data ?? []).length === 0
          ? <EmptyState>{t("connections.repos.empty")}</EmptyState>
          : (repos.data ?? []).map((repo) => (
            <RepoAccessRow key={repo.id} agent={agent} repo={repo} onDone={onSaved}
              granted={grantedRepos?.find((access) => access.repoId === repo.id) ?? null} />
          ))}
      </Card>

      <Card title={t("agents.cap.skills")} extra={<span className={COUNT}>{(skills.data ?? []).length}</span>}>
        {(skills.data ?? []).length === 0
          ? <EmptyState>{t("agents.cap.skills.empty")}</EmptyState>
          : (skills.data ?? []).map((skill) => {
            const mounted = (agent.skills ?? []).some((entry) => entry.skillId === skill.id);
            return (
              <div key={skill.id} className={cn(ROW, "border-t border-[var(--border-soft)] py-2.5")}>
                <div className="flex-1">
                  <div className="text-foreground">{skill.name}</div>
                  <div>{skill.kind.toLowerCase()} · {skill.slug}</div>
                </div>
                <BindingToggle on={mounted} label={t("agents.cap.mount", { name: skill.name })}
                  add={() => api.post(`/agents/${agent.id}/skills`, { skillId: skill.id })}
                  remove={() => api.delete(`/agents/${agent.id}/skills/${skill.id}`)} onDone={onSaved} />
              </div>
            );
          })}
      </Card>

      <Card title={t("connections.mcp.title")} extra={<span className={COUNT}>{(connections.data ?? []).length}</span>}>
        {(connections.data ?? []).length === 0 ? <EmptyState>{t("agents.cap.mcp.empty")}</EmptyState> : (connections.data ?? []).map((connection) => {
          const bound = (agent.mcpConnections ?? []).some((entry) => entry.mcpConnectionId === connection.id);
          return (
            <div key={connection.id} className={cn(ROW, "border-t border-[var(--border-soft)] py-2.5")}>
              <div className="flex-1">
                <div className="text-foreground">{connection.name}</div>
                <div>{connection.transport}</div>
              </div>
              <BindingToggle on={bound} label={t("agents.cap.bind", { name: connection.name })}
                add={() => api.post(`/agents/${agent.id}/mcp-connections`, { mcpConnectionId: connection.id })}
                remove={() => api.delete(`/agents/${agent.id}/mcp-connections/${connection.id}`)} onDone={onSaved} />
            </div>
          );
        })}
      </Card>

      <Card title={t("secrets.head.title")} extra={<span className={COUNT}>{(agent.secretGrants ?? []).length}</span>}>
        {(agent.secretGrants ?? []).length === 0
          ? <EmptyState>{t("agents.cap.secrets.empty")}</EmptyState>
          : (agent.secretGrants ?? []).map((grant) => (
            <div key={`${grant.secretId}:${grant.envVar}`} className={cn(ROW, "border-t border-[var(--border-soft)] py-2.5")}>
              <div className="flex-1"><div className="text-foreground">{grant.secret?.name ?? grant.secretId}</div><div>{grant.envVar}</div></div>
            </div>
          ))}
      </Card>

      <Card title={t("agents.cap.filesystem")} extra={<span className={COUNT}>{(agent.filesystemGrants ?? []).length}</span>}>
        <NewFilesystemGrant agentId={agent.id} onDone={onSaved} />
        <Table>
          <TableHeader><TableRow><TableHead>{t("agents.fs.folder")}</TableHead><TableHead>{t("agents.fs.canRead")}</TableHead><TableHead>{t("agents.fs.canWrite")}</TableHead><TableHead>{t("agents.fs.canDelete")}</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {(agent.filesystemGrants ?? []).map((grant) => (
              <FilesystemGrantRow key={grant.id} agentId={agent.id} grant={grant} onDone={onSaved} />
            ))}
          </TableBody>
        </Table>
        {(agent.filesystemGrants ?? []).length === 0 ? <EmptyState>{t("agents.cap.filesystem.empty")}</EmptyState> : null}
      </Card>
    </div>
  );
};

export const AgentDetailPage = ({ agentId }: { agentId: string }): ReactNode => {
  const { data: agent, error, reload } = usePoll<Agent>(`/agents/${agentId}`, 5_000);
  const [tab, setTab] = useState<AgentTab>("setup");
  const [draft, setDraft] = useState<Agent | null>(null);
  const { pending, error: actionError, run } = useAction();
  const t = useT();
  const projectId = agent?.projectId ?? "";
  const { data: siblings } = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 15_000);

  if (error !== null && agent === null) {
    return <Page><ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /></Page>;
  }
  if (!agent) return <Page><EmptyState>{t("common.loading")}</EmptyState></Page>;

  const view = draft ?? agent;
  const patch = (changes: Partial<Agent>): void => setDraft({ ...view, ...changes });
  const save = async (): Promise<void> => {
    if (!draft) return;
    const ok = await run(() => api.patch(`/agents/${agentId}`, {
      name: draft.name, title: draft.title, model: modelForSave(draft.model),
      runnerPreference: runnerForModel(draft.model) ?? draft.runnerPreference, inboxAccess: draft.inboxAccess,
      foundationalPrompt: draft.foundationalPrompt, rolePrompt: draft.rolePrompt,
    }));
    if (ok) { setDraft(null); reload(); }
  };

  return (
    <Page className="text-foreground">
      <div className={DETAIL_HEAD}>
        <Link to="/agents" className={BACK_LINK}><IconArrowLeft /></Link>
        <span className="text-[var(--status-violet-fg)]"><IconRobot /></span>
        <h1 className={DETAIL_HEAD_H1}>{view.title}</h1>
        <Pill tone="grey"><ModelLabel model={view.model} /></Pill>
        <Pill tone="violet">{t("agents.runnerPill", { runner: view.runnerPreference.toLowerCase() })}</Pill>
        <span className="flex-1" />
        {draft === null
          ? <Button type="button" variant="legacy" size="legacy" onClick={() => setDraft(agent)}>{t("common.edit")}</Button>
          : (
            <>
              <Button type="button" variant="legacy" size="legacy" onClick={() => setDraft(null)}>{t("common.cancel")}</Button>
              <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || validateModelPair(view.model, view.runnerPreference) !== null} onClick={() => void save()}>{t("common.save")}</Button>
            </>
          )}
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "setup", label: t("agents.tab.setup") },
          { value: "prompt", label: t("agents.tab.prompt") },
          { value: "capabilities", label: t("agents.tab.capabilities") },
          { value: "collaborators", label: t("agents.tab.collaborators") },
        ]}
      />

      <div className={STACK}>
        {actionError === null ? null : <ErrorNotice message={actionError} />}

        {tab === "setup" ? (
          <Card title={t("projects.details.title")}>
            {draft === null ? (
              <KeyValue items={[
                { k: t("agents.field.name.label"), v: view.name },
                { k: t("agents.field.title"), v: view.title },
                { k: t("agents.field.model"), v: <ModelLabel model={view.model} /> },
                { k: t("agents.field.runnerPreference"), v: view.runnerPreference.toLowerCase() },
                { k: t("agents.field.environment"), v: <span className="text-[11.5px]">{view.environmentId}</span> },
                { k: t("agents.inbox.label"), v: t(view.inboxAccess ? "agents.inbox.on" : "agents.inbox.off") },
                { k: t("common.created"), v: formatDateTime(view.createdAt) },
                { k: t("common.updated"), v: formatDateTime(view.updatedAt) },
              ]} />
            ) : (
              <div className={STACK}>
                <div className={FIELD_ROW}>
                  <Field label={t("agents.field.name.label")}><Input type="text" value={view.name} onChange={(event) => patch({ name: event.target.value })} /></Field>
                  <Field label={t("agents.field.title")}><Input type="text" value={view.title} onChange={(event) => patch({ title: event.target.value })} /></Field>
                </div>
                <ModelPicker model={view.model} runnerPreference={view.runnerPreference} onChange={patch} />
                <div><Link to="/settings" className="text-[var(--accent)] hover:underline">{t("agents.model.settingsHint")}</Link></div>
                <div className={ROW}>
                  <Toggle on={view.inboxAccess} onChange={(next) => patch({ inboxAccess: next })} label={t("agents.inbox.label")} />
                  <div>
                    <div>{t("agents.inbox.label")}</div>
                    <div>{t("agents.inbox.hint.detail")}</div>
                  </div>
                </div>
              </div>
            )}
          </Card>
        ) : null}

        {tab === "prompt" ? (
          <>
            <Card title={t("agents.foundation.title")} extra={<Pill tone="grey">{t("agents.foundation.pill")}</Pill>}>
              {draft === null
                ? <div className={CODE_BLOCK}>{view.foundationalPrompt}</div>
                : <Textarea rows={6} value={view.foundationalPrompt} onChange={(event) => patch({ foundationalPrompt: event.target.value })} />}
              <div className="mt-2.5">{t("agents.foundation.hint")}</div>
            </Card>
            <Card title={t("agents.field.rolePrompt")}>
              {draft === null
                ? <div className={CODE_BLOCK}>{view.rolePrompt}</div>
                : <Textarea rows={18} value={view.rolePrompt} onChange={(event) => patch({ rolePrompt: event.target.value })} />}
            </Card>
          </>
        ) : null}

        {tab === "capabilities" ? <CapabilitiesTab agent={agent} projectId={projectId} onSaved={reload} /> : null}

        {tab === "collaborators" ? (
          <Card title={t("agents.tab.collaborators")}>
            <div className="mb-3">{t("agents.collaborators.hint")}</div>
            <div className="mt-3">
              {(siblings ?? []).filter((candidate) => candidate.id !== agent.id).map((candidate) => (
                <div key={candidate.id} className={cn(ROW, "border-t border-[var(--border-soft)] py-2.5")}>
                  <div className="flex-1">
                    <div className="text-foreground">{candidate.title}</div>
                    <div>{titleCase(candidate.name)} · {candidate.model}</div>
                  </div>
                  <BindingToggle on={(agent.collaborators ?? []).some((entry) => entry.allowedAgentId === candidate.id)} label={t("agents.collaborators.allow", { name: candidate.name })}
                    add={() => api.post(`/agents/${agent.id}/collaborators`, { allowedAgentId: candidate.id })}
                    remove={() => api.delete(`/agents/${agent.id}/collaborators/${candidate.id}`)} onDone={reload} />
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    </Page>
  );
};
