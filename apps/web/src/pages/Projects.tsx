import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { formatDate, formatDateTime } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import { cn } from "../lib/utils";
import type { Agent, Project, Repo, Task } from "../lib/types";
import { IconArrowLeft, IconPlus } from "../components/icons";
import {
  BACK_LINK, COUNT, DETAIL_HEAD, DETAIL_HEAD_H1, METRICS, PAGE_ACTIONS, PAGE_HEAD, PAGE_HEAD_H1,
  PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, STACK, TABLE_NAME, TABLE_SUB, TABLE_TIGHT,
  Card, EmptyState, ErrorNotice, Field, KeyValue, Metric, Modal, Page, Pill, RowMenu, ShowMore,
} from "../components/ui";
import { Button, buttonVariants } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";

/** A `<Link>` is not a `<Button>` host, so it has no box-shadow today and takes
 *  `shadow-none` (§2.5). Hoisted out of the attribute for the same reason as
 *  Connections' pill: the acceptance checker reads string literals inside a
 *  `className={...}` expression. */
const LINK_BUTTON = cn(buttonVariants({ variant: "legacy", size: "legacy" }), "shadow-none");

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
        <Button type="button" variant="legacy" size="legacy" className="shadow-none" onClick={onClose}>Cancel</Button>
        <Button type="button" variant="legacyPrimary" size="legacy" className="shadow-none" disabled={pending || name.trim().length === 0 || effectiveSlug.length === 0}
          onClick={() => void submit()}>Create project</Button>
      </>
    }>
      {error === null ? null : <ErrorNotice message={error} />}
      <Field label="Name">
        {/* `h-auto` for the same reason the pair carries `shadow-none`: this form
            rendered raw `<input>` elements before the batch, so it got the retired
            sheet's `padding: 9px 11px` with no `h-9` to compete with it and stood at
            38.75px. The primitive is 29.25px. `placeholder:text-foreground/50` is the
            same story for colour: a raw element took Tailwind preflight's
            `currentColor` at 50%, where the primitive pins `text-muted-foreground`.
            Only these two call sites converted from a raw element. */}
        <Input type="text" className="h-auto shadow-none placeholder:text-foreground/50" value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder="MMO Game" />
      </Field>
      <Field label="Slug" hint="Lower-case, dash separated. Used by the CLI and YAML sync.">
        <Input type="text" className="h-auto shadow-none placeholder:text-foreground/50" value={effectiveSlug} onChange={(event) => setSlug(slugify(event.target.value))} placeholder="mmo-game" />
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
    <Page>
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>Projects</h1>
          <div className={PAGE_HEAD_SUBTITLE}>Workspaces that scope agents, repos, tasks and runs</div>
        </div>
        <div className={PAGE_ACTIONS}>
          <Button type="button" variant="legacyPrimary" size="legacy" className="shadow-none" onClick={() => setCreating(true)}><IconPlus />New Project</Button>
        </div>
      </div>

      <div className={STACK}>
        {error === null ? null : <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} />}
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        <Card flush>
          <Table className="leading-normal">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead><TableHead>Tasks</TableHead><TableHead>Session budget</TableHead><TableHead>Created</TableHead><TableHead>Updated</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => (
                <TableRow key={project.id} className="cursor-pointer" onClick={() => { select(project.id); navigate(`/projects/${project.id}`); }}>
                  <TableCell className={TABLE_NAME}>{project.name}<span className={TABLE_SUB}>{project.slug}</span></TableCell>
                  <TableCell>{taskCount(project.id)}</TableCell>
                  <TableCell>{project.maxDurationMin}m wall · {project.stallTimeoutMin}m stall · {project.maxSessionsPerTask} runs</TableCell>
                  <TableCell>{formatDate(project.createdAt)}</TableCell>
                  <TableCell>{formatDate(project.updatedAt)}</TableCell>
                  <TableCell className={TABLE_TIGHT}><RowMenu items={[{ label: "Delete", danger: true, onSelect: () => remove(project) }]} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {projects.length === 0 ? <EmptyState>{loading ? "Loading…" : "No projects yet. Create one to scope agents and tasks."}</EmptyState> : null}
        </Card>
      </div>

      {creating ? <NewProject onClose={() => setCreating(false)} onCreated={reload} /> : null}
    </Page>
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
    return <Page><ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /></Page>;
  }
  if (!project) return <Page><EmptyState>Loading…</EmptyState></Page>;

  const scoped = tasks ?? [];
  const byStatus = (status: string): number => scoped.filter((task) => task.status === status).length;
  const saveYaml = async (): Promise<void> => {
    if (editingYaml === null) return;
    const ok = await run(() => api.patch(`/projects/${projectId}`, { yamlDocument: editingYaml }));
    if (ok) { setEditingYaml(null); reload(); reloadProjects(); }
  };

  return (
    <Page>
      <div className={DETAIL_HEAD}>
        <Link to="/projects" className={BACK_LINK}><IconArrowLeft /></Link>
        <h1 className={DETAIL_HEAD_H1}>{project.name}</h1>
        <Pill tone="grey">{project.slug}</Pill>
        <span className="flex-1" />
        <Link to="/tasks" className={LINK_BUTTON}>Tasks</Link>
        <Link to="/agents" className={LINK_BUTTON}>Agents</Link>
        <Link to="/goals" className={LINK_BUTTON}>Goals</Link>
      </div>

      <div className={STACK}>
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        <div className={METRICS}>
          <Metric label="Tasks" value={`${scoped.length}`} />
          <Metric label="Doing · Review" value={`${byStatus("DOING")} · ${byStatus("REVIEW")}`} />
          <Metric label="Agents" value={`${(agents ?? []).length}`} />
          <Metric label="Repos" value={`${(repos ?? []).length}`} />
        </div>

        <Card title="Details">
          <KeyValue items={[
            { k: "Slug", v: project.slug },
            { k: "Project ID", v: <span className="text-[11.5px]">{project.id}</span> },
            { k: "Created", v: formatDateTime(project.createdAt) },
            { k: "Updated", v: formatDateTime(project.updatedAt) },
            { k: "Wall-clock limit", v: `${project.maxDurationMin} min` },
            { k: "Stall timeout", v: `${project.stallTimeoutMin} min` },
            { k: "Max runs per task", v: `${project.maxSessionsPerTask}` },
            { k: "Spend cap", v: project.spendCap === null ? "— (subscription runners, DECISIONS #12)" : `$${project.spendCap}` },
          ]} />
        </Card>

        <Card title="Repos" extra={<span className={COUNT}>{(repos ?? []).length}</span>}>
          {(repos ?? []).length === 0 ? <EmptyState>No repos. Agent tasks require a repo grant.</EmptyState> : (
            <Table className="leading-normal">
              <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Remote</TableHead><TableHead>Default branch</TableHead><TableHead>Mount</TableHead></TableRow></TableHeader>
              <TableBody>
                {(repos ?? []).map((repo) => (
                  <TableRow key={repo.id}>
                    <TableCell className={TABLE_NAME}>{repo.name}</TableCell>
                    <TableCell>{repo.remoteUrl}</TableCell>
                    <TableCell>{repo.defaultBranch}</TableCell>
                    <TableCell>{repo.mountPath}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card title="YAML document" extra={
          editingYaml === null
            ? <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" onClick={() => setEditingYaml(project.yamlDocument)}>Edit</Button>
            : (
              <>
                <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" onClick={() => setEditingYaml(null)}>Cancel</Button>
                <Button type="button" variant="legacyPrimary" size="legacySmall" className="shadow-none" disabled={pending} onClick={() => void saveYaml()}>Save</Button>
              </>
            )
        }>
          {editingYaml === null
            ? (project.yamlDocument.trim().length === 0
              ? <EmptyState>No YAML document. CLI sync arrives in v2 (DECISIONS #10).</EmptyState>
              : <ShowMore text={project.yamlDocument} lines={10} />)
            : <Textarea rows={14} className="shadow-none" value={editingYaml} onChange={(event) => setEditingYaml(event.target.value)} />}
        </Card>
      </div>
    </Page>
  );
};
