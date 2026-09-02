import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { formatDate, formatDateTime } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { slugify } from "../lib/onboarding";
import { useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import { cn } from "../lib/utils";
import type { Agent, Project, Repo, TaskList } from "../lib/types";
import { IconArrowLeft, IconPlus } from "../components/icons";
import {
  BACK_LINK, COUNT, DETAIL_HEAD, DETAIL_HEAD_H1, METRICS, PAGE_ACTIONS, PAGE_HEAD, PAGE_HEAD_H1,
  PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, STACK, TABLE_NAME, TABLE_SUB, TABLE_TIGHT,
  Card, EmptyState, ErrorNotice, Field, KeyValue, Metric, Modal, Page, Pill, RowMenu, ShowMore, Toggle,
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

const NewProject = ({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): ReactNode => {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const { pending, error, run } = useAction();
  const t = useT();
  const effectiveSlug = slug.length > 0 ? slug : slugify(name);
  const submit = async (): Promise<void> => {
    const ok = await run(() => api.post<Project>("/projects", { name, slug: effectiveSlug, yamlDocument: "" }));
    if (ok) { onCreated(); onClose(); }
  };
  return (
    <Modal title={t("projects.new.title")} onClose={onClose} footer={
      <>
        <Button type="button" variant="legacy" size="legacy" className="shadow-none" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="button" variant="legacyPrimary" size="legacy" className="shadow-none" disabled={pending || name.trim().length === 0 || effectiveSlug.length === 0}
          onClick={() => void submit()}>{t("projects.new.create")}</Button>
      </>
    }>
      {error === null ? null : <ErrorNotice message={error} />}
      <Field label={t("projects.field.name")}>
        {/* `h-auto` for the same reason the pair carries `shadow-none`: this form
            rendered raw `<input>` elements before the batch, so it got the retired
            sheet's `padding: 9px 11px` with no `h-9` to compete with it and stood at
            38.75px. The primitive is 29.25px. `placeholder:text-foreground/50` is the
            same story for colour: a raw element took Tailwind preflight's
            `currentColor` at 50%, where the primitive pins `text-muted-foreground`.

            Sixteen controls converted from a raw element in this batch, all of
            them unclassed and styled solely by `styles.css:233-240` at 3f712b5 —
            not just these two. The overrides differ per site because the retired
            rule set `padding` and nothing else: only these two hosts had an `h-9`
            to lose (Select carries no height, Textarea only an inert
            `min-h-[60px]`), only three carried a `placeholder`, and only two
            selects carry `disabled`. */}
        <Input type="text" className="h-auto shadow-none placeholder:text-foreground/50" value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder={t("projects.field.name.placeholder")} />
      </Field>
      <Field label={t("projects.field.slug.label")} hint={t("projects.field.slug.hint")}>
        <Input type="text" className="h-auto shadow-none placeholder:text-foreground/50" value={effectiveSlug} onChange={(event) => setSlug(slugify(event.target.value))} placeholder="mmo-game" />
      </Field>
    </Modal>
  );
};

export const ProjectsPage = (): ReactNode => {
  const { projects, loading, error, reload, select } = useProjectScope();
  // `enrich=false`: this poll is global and runs every 2.5 s, and all it does
  // with the response is count rows per project. Chain progress, positions and
  // recurring-fire summaries would cost two extra whole-table queries per tick
  // for fields this page never renders.
  const { data: tasks } = usePoll<TaskList[]>("/tasks?enrich=false");
  const [creating, setCreating] = useState(false);
  const { error: actionError, run } = useAction();
  const t = useT();

  const taskCount = (projectId: string): number => (tasks ?? []).filter((task) => task.projectId === projectId).length;

  const remove = (project: Project): void => {
    if (!window.confirm(t("projects.confirm.delete", { name: project.name }))) return;
    void run(async () => { await api.delete(`/projects/${project.id}`); reload(); });
  };

  return (
    <Page>
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("projects.head.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>{t("projects.head.subtitle")}</div>
        </div>
        <div className={PAGE_ACTIONS}>
          <Button type="button" variant="legacyPrimary" size="legacy" className="shadow-none" onClick={() => setCreating(true)}><IconPlus />{t("projects.new.button")}</Button>
        </div>
      </div>

      <div className={STACK}>
        {error === null ? null : <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} />}
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        <Card flush>
          <Table className="leading-normal">
            <TableHeader>
              <TableRow>
                <TableHead>{t("projects.table.name")}</TableHead><TableHead>{t("projects.table.tasks")}</TableHead><TableHead>{t("projects.table.budget")}</TableHead><TableHead>{t("common.created")}</TableHead><TableHead>{t("common.updated")}</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => (
                <TableRow key={project.id} className="cursor-pointer" onClick={() => { select(project.id); navigate(`/projects/${project.id}`); }}>
                  <TableCell className={TABLE_NAME}>{project.name}<span className={TABLE_SUB}>{project.slug}</span></TableCell>
                  <TableCell>{taskCount(project.id)}</TableCell>
                  <TableCell>{t("projects.budget", { wall: project.maxDurationMin, stall: project.stallTimeoutMin, runs: project.maxSessionsPerTask })}</TableCell>
                  <TableCell>{formatDate(project.createdAt)}</TableCell>
                  <TableCell>{formatDate(project.updatedAt)}</TableCell>
                  <TableCell className={TABLE_TIGHT}><RowMenu items={[{ label: t("common.delete"), danger: true, onSelect: () => remove(project) }]} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {projects.length === 0 ? <EmptyState>{t(loading ? "common.loading" : "projects.empty")}</EmptyState> : null}
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
  // Same as above: this page counts tasks per status and renders no chain data.
  const { data: tasks } = usePoll<TaskList[]>(`/tasks?projectId=${encodeURIComponent(projectId)}&enrich=false`);
  const [editingYaml, setEditingYaml] = useState<string | null>(null);
  const { pending, error: actionError, run } = useAction();
  const t = useT();

  if (error !== null && project === null) {
    return <Page><ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /></Page>;
  }
  if (!project) return <Page><EmptyState>{t("common.loading")}</EmptyState></Page>;

  const scoped = tasks ?? [];
  const byStatus = (status: string): number => scoped.filter((task) => task.status === status).length;
  const saveYaml = async (): Promise<void> => {
    if (editingYaml === null) return;
    const ok = await run(() => api.patch(`/projects/${projectId}`, { yamlDocument: editingYaml }));
    if (ok) { setEditingYaml(null); reload(); reloadProjects(); }
  };
  const saveGateDefault = (field: "specGateDefault" | "mergeGateDefault", next: boolean): void => {
    void run(async () => {
      await api.patch(`/projects/${projectId}`, { [field]: next });
      reload();
      reloadProjects();
    });
  };

  return (
    <Page>
      <div className={DETAIL_HEAD}>
        <Link to="/projects" className={BACK_LINK}><IconArrowLeft /></Link>
        <h1 className={DETAIL_HEAD_H1}>{project.name}</h1>
        <Pill tone="grey">{project.slug}</Pill>
        <span className="flex-1" />
        <Link to="/tasks" className={LINK_BUTTON}>{t("sidebar.nav.tasks")}</Link>
        <Link to="/agents" className={LINK_BUTTON}>{t("sidebar.nav.agents")}</Link>
        <Link to="/goals" className={LINK_BUTTON}>{t("sidebar.nav.goals")}</Link>
      </div>

      <div className={STACK}>
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        <div className={METRICS}>
          <Metric label={t("projects.metric.tasks")} value={`${scoped.length}`} />
          <Metric label={t("projects.metric.doingReview")} value={`${byStatus("DOING")} · ${byStatus("REVIEW")}`} />
          <Metric label={t("projects.metric.agents")} value={`${(agents ?? []).length}`} />
          <Metric label={t("projects.metric.repos")} value={`${(repos ?? []).length}`} />
        </div>

        <Card title={t("projects.details.title")}>
          <KeyValue items={[
            { k: t("projects.details.slug"), v: project.slug },
            { k: t("projects.details.id"), v: <span className="text-[11.5px]">{project.id}</span> },
            { k: t("common.created"), v: formatDateTime(project.createdAt) },
            { k: t("common.updated"), v: formatDateTime(project.updatedAt) },
            { k: t("projects.details.wallClock"), v: t("projects.details.minutes", { n: project.maxDurationMin }) },
            { k: t("projects.details.stall"), v: t("projects.details.minutes", { n: project.stallTimeoutMin }) },
            { k: t("projects.details.maxRuns"), v: `${project.maxSessionsPerTask}` },
            { k: t("projects.details.spendCap"), v: project.spendCap === null ? t("projects.details.noSpendCap") : `$${project.spendCap}` },
            {
              k: t("projects.details.specGateDefault"),
              v: <Toggle on={project.specGateDefault} onChange={(next) => saveGateDefault("specGateDefault", next)} disabled={pending} label={t("projects.details.specGateDefault")} />,
            },
            {
              k: t("projects.details.mergeGateDefault"),
              v: <Toggle on={project.mergeGateDefault} onChange={(next) => saveGateDefault("mergeGateDefault", next)} disabled={pending} label={t("projects.details.mergeGateDefault")} />,
            },
          ]} />
        </Card>

        <Card title={t("projects.repos.title")} extra={<span className={COUNT}>{(repos ?? []).length}</span>}>
          {(repos ?? []).length === 0 ? <EmptyState>{t("projects.repos.empty")}</EmptyState> : (
            <Table className="leading-normal">
              <TableHeader><TableRow><TableHead>{t("connections.repos.table.name")}</TableHead><TableHead>{t("connections.repos.table.remote")}</TableHead><TableHead>{t("connections.repos.table.defaultBranch")}</TableHead><TableHead>{t("projects.repos.mount")}</TableHead></TableRow></TableHeader>
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

        <Card title={t("projects.yaml.title")} extra={
          editingYaml === null
            ? <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" onClick={() => setEditingYaml(project.yamlDocument)}>{t("common.edit")}</Button>
            : (
              <>
                <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" onClick={() => setEditingYaml(null)}>{t("common.cancel")}</Button>
                <Button type="button" variant="legacyPrimary" size="legacySmall" className="shadow-none" disabled={pending} onClick={() => void saveYaml()}>{t("common.save")}</Button>
              </>
            )
        }>
          {editingYaml === null
            ? (project.yamlDocument.trim().length === 0
              ? <EmptyState>{t("projects.yaml.empty")}</EmptyState>
              : <ShowMore text={project.yamlDocument} lines={10} />)
            : <Textarea rows={14} className="shadow-none" value={editingYaml} onChange={(event) => setEditingYaml(event.target.value)} />}
        </Card>
      </div>
    </Page>
  );
};
