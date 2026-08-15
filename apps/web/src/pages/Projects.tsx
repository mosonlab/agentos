import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { formatDate, formatDateTime } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import type { Agent, Project, Repo, Task } from "../lib/types";
import { IconArrowLeft, IconPlus } from "../components/icons";
import {
  Card, EmptyState, ErrorNotice, Field, KeyValue, Metric, Modal, RowMenu, ShowMore,
} from "../components/ui";

const slugify = (value: string): string =>
  value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const NewProject = ({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): ReactNode => {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const { pending, error, run } = useAction();
  const effectiveSlug = slug.length > 0 ? slug : slugify(name);
  const submit = async (): Promise<void> => {
    const ok = await run(() => api.post<Project>("/projects", { name, slug: effectiveSlug, yamlDocument: "" }));
    if (ok) { onCreated(); onClose(); }
  };
  return (
    <Modal title="New Project" onClose={onClose} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={pending || name.trim().length === 0 || effectiveSlug.length === 0}
          onClick={() => void submit()}>Create project</button>
      </>
    }>
      {error === null ? null : <ErrorNotice message={error} />}
      <Field label="Name">
        <input type="text" value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder="MMO Game" />
      </Field>
      <Field label="Slug" hint="Lower-case, dash separated. Used by the CLI and YAML sync.">
        <input type="text" value={effectiveSlug} onChange={(event) => setSlug(slugify(event.target.value))} placeholder="mmo-game" />
      </Field>
    </Modal>
  );
};

export const ProjectsPage = (): ReactNode => {
  const { projects, loading, error, reload, select } = useProjectScope();
  const { data: tasks } = usePoll<Task[]>("/tasks");
  const [creating, setCreating] = useState(false);
  const { error: actionError, run } = useAction();

  const taskCount = (projectId: string): number => (tasks ?? []).filter((task) => task.projectId === projectId).length;

  const remove = (project: Project): void => {
    if (!window.confirm(`Delete project ${project.name}? Agents, tasks and runs cascade.`)) return;
    void run(async () => { await api.delete(`/projects/${project.id}`); reload(); });
  };

  return (
    <div className="page">
      <div className="pageHead">
        <div className="titles">
          <h1>Projects</h1>
          <div className="subtitle">Workspaces that scope agents, repos, tasks and runs</div>
        </div>
        <div className="pageActions">
          <button type="button" className="btn primary" onClick={() => setCreating(true)}><IconPlus />New Project</button>
        </div>
      </div>

      <div className="stack">
        {error === null ? null : <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} />}
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        <Card flush>
          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th><th>Tasks</th><th>Session budget</th><th>Created</th><th>Updated</th><th />
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id} className="clickable" onClick={() => { select(project.id); navigate(`/projects/${project.id}`); }}>
                    <td className="name">{project.name}<span className="sub">{project.slug}</span></td>
                    <td>{taskCount(project.id)}</td>
                    <td>{project.maxDurationMin}m wall · {project.stallTimeoutMin}m stall · {project.maxSessionsPerTask} runs</td>
                    <td>{formatDate(project.createdAt)}</td>
                    <td>{formatDate(project.updatedAt)}</td>
                    <td className="tight"><RowMenu items={[{ label: "Delete", danger: true, onSelect: () => remove(project) }]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {projects.length === 0 ? <EmptyState>{loading ? "Loading…" : "No projects yet. Create one to scope agents and tasks."}</EmptyState> : null}
          </div>
        </Card>
      </div>

      {creating ? <NewProject onClose={() => setCreating(false)} onCreated={reload} /> : null}
    </div>
  );
};

export const ProjectDetailPage = ({ projectId }: { projectId: string }): ReactNode => {
  const { reload: reloadProjects } = useProjectScope();
  const { data: project, error, reload } = usePoll<Project>(`/projects/${projectId}`, 5_000);
  const { data: agents } = usePoll<Agent[]>(`/projects/${projectId}/agents`, 5_000);
  const { data: repos } = usePoll<Repo[]>(`/projects/${projectId}/repos`, 5_000);
  const { data: tasks } = usePoll<Task[]>(`/tasks?projectId=${encodeURIComponent(projectId)}`);
  const [editingYaml, setEditingYaml] = useState<string | null>(null);
  const { pending, error: actionError, run } = useAction();

  if (error !== null && project === null) {
    return <div className="page"><ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /></div>;
  }
  if (!project) return <div className="page"><EmptyState>Loading…</EmptyState></div>;

  const scoped = tasks ?? [];
  const byStatus = (status: string): number => scoped.filter((task) => task.status === status).length;
  const saveYaml = async (): Promise<void> => {
    if (editingYaml === null) return;
    const ok = await run(() => api.patch(`/projects/${projectId}`, { yamlDocument: editingYaml }));
    if (ok) { setEditingYaml(null); reload(); reloadProjects(); }
  };

  return (
    <div className="page">
      <div className="detailHead">
        <Link to="/projects" className="backLink"><IconArrowLeft /></Link>
        <h1>{project.name}</h1>
        <span className="pill grey">{project.slug}</span>
        <span className="spacer" />
        <Link to="/tasks" className="btn">Tasks</Link>
        <Link to="/agents" className="btn">Agents</Link>
        <Link to="/goals" className="btn">Goals</Link>
      </div>

      <div className="stack">
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        <div className="metrics">
          <Metric label="Tasks" value={`${scoped.length}`} />
          <Metric label="Doing · Review" value={`${byStatus("DOING")} · ${byStatus("REVIEW")}`} />
          <Metric label="Agents" value={`${(agents ?? []).length}`} />
          <Metric label="Repos" value={`${(repos ?? []).length}`} />
        </div>

        <Card title="Details">
          <KeyValue items={[
            { k: "Slug", v: project.slug },
            { k: "Project ID", v: <span className="small">{project.id}</span> },
            { k: "Created", v: formatDateTime(project.createdAt) },
            { k: "Updated", v: formatDateTime(project.updatedAt) },
            { k: "Wall-clock limit", v: `${project.maxDurationMin} min` },
            { k: "Stall timeout", v: `${project.stallTimeoutMin} min` },
            { k: "Max runs per task", v: `${project.maxSessionsPerTask}` },
            { k: "Spend cap", v: project.spendCap === null ? "— (subscription runners, DECISIONS #12)" : `$${project.spendCap}` },
          ]} />
        </Card>

        <Card title="Repos" extra={<span className="count">{(repos ?? []).length}</span>}>
          {(repos ?? []).length === 0 ? <EmptyState>No repos. Agent tasks require a repo grant.</EmptyState> : (
            <div className="tableWrap">
              <table className="table">
                <thead><tr><th>Name</th><th>Remote</th><th>Default branch</th><th>Mount</th></tr></thead>
                <tbody>
                  {(repos ?? []).map((repo) => (
                    <tr key={repo.id}>
                      <td className="name">{repo.name}</td>
                      <td>{repo.remoteUrl}</td>
                      <td>{repo.defaultBranch}</td>
                      <td>{repo.mountPath}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="YAML document" extra={
          editingYaml === null
            ? <button type="button" className="btn small" onClick={() => setEditingYaml(project.yamlDocument)}>Edit</button>
            : (
              <>
                <button type="button" className="btn small" onClick={() => setEditingYaml(null)}>Cancel</button>
                <button type="button" className="btn small primary" disabled={pending} onClick={() => void saveYaml()}>Save</button>
              </>
            )
        }>
          {editingYaml === null
            ? (project.yamlDocument.trim().length === 0
              ? <EmptyState>No YAML document. CLI sync arrives in v2 (DECISIONS #10).</EmptyState>
              : <ShowMore text={project.yamlDocument} lines={10} />)
            : <textarea rows={14} value={editingYaml} onChange={(event) => setEditingYaml(event.target.value)} />}
        </Card>
      </div>
    </div>
  );
};
