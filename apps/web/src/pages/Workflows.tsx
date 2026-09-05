import { type ReactNode, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { findModel, splitModel } from "../lib/models";
import { fatal } from "../lib/poll-state";
import { useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import { cn } from "../lib/utils";
import type {
  Agent, StaffingProfile, StaffingProfileEntryInput, StaffingProfileResponse, StaffingProfileWarning,
  TaskTemplate, TaskTemplateStep,
} from "../lib/types";
import { IconArrowLeft, IconPlus, IconWorkflows } from "../components/icons";
import {
  BACK_LINK, DETAIL_HEAD, DETAIL_HEAD_H1, FIELD_ROW, HINT, PAGE_ACTIONS, PAGE_HEAD, PAGE_HEAD_H1,
  PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, ROW, ROW_WRAP, STACK, TABLE_NAME, TABLE_SUB,
  Card, EmptyState, ErrorNotice, Field, InfoNotice, Modal, Page, Pill, Toggle,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

/**
 * Workflows: the task templates of a project, and the staffing profiles that
 * decide who runs each of a template's steps.
 *
 * Three routes, one file, because they are one surface read top to bottom:
 * `/workflows` lists the templates, `/workflows/:templateId` lists that
 * template's profiles, and `/workflows/:templateId/profiles/:profileId` is the
 * editor for one of them. The control plane owns the rules (docs/operator-api.md
 * "Staffing profiles"); this page owns only the draft an operator is holding and
 * the exact `PUT` body it turns into.
 */

/* ------------------------------------------------------------------ shared */

/** An agent an operator may staff a step with. The merge-execution sentinel
 *  answers `assignable: false` and archived agents are refused by the writer,
 *  so neither belongs in the picker. */
export const staffableAgents = (agents: Agent[]): Agent[] =>
  agents.filter((agent) => agent.archivedAt === null && agent.assignable !== false);

/** `ModelLabel`'s two parts as one string, because an `<option>` renders text
 *  and not the component's spans. */
const modelSummary = (model: string): string => {
  const parsed = splitModel(model);
  const name = findModel(parsed.model)?.label ?? parsed.model;
  return parsed.effort === null ? name : `${name} ${parsed.effort}`;
};

export const agentOption = (agent: Agent): string => `${agent.title} · ${modelSummary(agent.model)}`;

type DraftEntry = { assigneeAgentId: string; include: boolean };
type Draft = { name: string; entries: Record<string, DraftEntry> };

/** The profile as the editor holds it: one row per template step, keyed by the
 *  step's own output kind, with the profile's opinion or the empty one. */
export const draftOf = (template: TaskTemplate, profile: StaffingProfile): Draft => ({
  name: profile.name,
  entries: Object.fromEntries(template.steps.map((step) => {
    const held = profile.entries.find((entry) => entry.outputKind === step.outputKind);
    return [step.outputKind, { assigneeAgentId: held?.assigneeAgentId ?? "", include: held?.include ?? true }];
  })),
});

/**
 * The entry list a save sends.
 *
 * A `PUT` replaces the stored entries whole, so an omitted output kind loses its
 * opinion rather than keeping the previous one — which is exactly what a row the
 * operator left on its canonical binding means. `include` is sent only where the
 * template marks the step optional; anywhere else the writer refuses it.
 */
export const entriesOf = (template: TaskTemplate, draft: Draft): StaffingProfileEntryInput[] =>
  template.steps.flatMap((step) => {
    const held = draft.entries[step.outputKind];
    const assigneeAgentId = held?.assigneeAgentId ?? "";
    const include = step.optional ? held?.include ?? true : null;
    if (assigneeAgentId === "" && include !== false) return [];
    return [{
      outputKind: step.outputKind,
      assigneeAgentId: assigneeAgentId === "" ? null : assigneeAgentId,
      include,
    }];
  });

const seedOf = (profile: StaffingProfile): string =>
  JSON.stringify({ name: profile.name, entries: profile.entries });

/* ------------------------------------------------------------ template list */

export const WorkflowsPage = (): ReactNode => {
  const { projectId } = useProjectScope();
  const { data, loading, error, reload } = usePoll<TaskTemplate[]>(
    projectId === "" ? null : `/projects/${projectId}/task-templates`, 30_000,
  );
  const t = useT();

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;
  const templates = data ?? [];

  return (
    <Page className="text-foreground">
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("workflows.head.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>{t("workflows.head.subtitle")}</div>
        </div>
      </div>

      <div className={STACK}>
        {fatal(error, data) ? <ErrorNotice message={`${error!.status} ${error!.message}`} onRetry={reload} /> : null}
        <Card flush>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("workflows.table.template")}</TableHead>
                <TableHead>{t("workflows.table.steps")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((template) => (
                <TableRow key={template.id} className="cursor-pointer" onClick={(event) => {
                  if (!event.defaultPrevented) navigate(`/workflows/${template.id}`);
                }}>
                  <TableCell className={TABLE_NAME}>
                    <Link to={`/workflows/${template.id}`}>{template.name}</Link>
                    <span className={cn(TABLE_SUB, "block max-w-[420px] overflow-hidden text-ellipsis")}>{template.description}</span>
                  </TableCell>
                  <TableCell>{t("workflows.template.steps", { n: template.steps.length })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {templates.length === 0 ? (
            <EmptyState>
              <span className="mb-[10px] inline-flex text-[color:var(--faint)]"><IconWorkflows /></span>
              <div>{t(loading ? "common.loading" : "workflows.templates.empty")}</div>
            </EmptyState>
          ) : null}
        </Card>
      </div>
    </Page>
  );
};

/* ------------------------------------------------------------- profile list */

const NewProfile = ({ onClose, onCreate, pending }: {
  onClose: () => void;
  onCreate: (name: string) => void;
  pending: boolean;
}): ReactNode => {
  const [name, setName] = useState("");
  const t = useT();
  return (
    <Modal title={t("workflows.profiles.create")} onClose={onClose} footer={
      <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || name.trim() === ""}
        onClick={() => onCreate(name.trim())}>
        {t("workflows.profiles.create")}
      </Button>
    }>
      <Field label={t("workflows.profile.name")}>
        <Input type="text" value={name} autoFocus onChange={(event) => setName(event.target.value)}
          placeholder={t("workflows.profile.name.placeholder")} />
      </Field>
    </Modal>
  );
};

/** One profile in the list, with the four whole-profile commands. Delete is a
 *  disabled button rather than a hidden one when the profile is the default and
 *  the template has others: the control plane answers 409 there, and an operator
 *  needs to see why the command is unavailable. */
export const ProfileCard = ({ templateId, profile, undeletable, pending, onSetDefault, onDuplicate, onReset, onDelete }: {
  templateId: string;
  profile: StaffingProfile;
  undeletable: boolean;
  pending: boolean;
  onSetDefault: () => void;
  onDuplicate: () => void;
  onReset: () => void;
  onDelete: () => void;
}): ReactNode => {
  const t = useT();
  return (
    <Card>
      <div className={cn(STACK, "gap-[12px]")}>
        <div className={ROW_WRAP}>
          <Link to={`/workflows/${templateId}/profiles/${profile.id}`} className={TABLE_NAME}>{profile.name}</Link>
          {profile.isDefault ? <Pill tone="green">{t("workflows.profile.default")}</Pill> : null}
          <span className={HINT}>{t("workflows.profile.entries", { n: profile.entries.length })}</span>
          <span className={HINT}>{formatDate(profile.updatedAt)}</span>
        </div>
        <div className={ROW_WRAP}>
          <Button type="button" variant="legacy" size="legacySmall" disabled={pending || profile.isDefault} onClick={onSetDefault}>
            {t("workflows.profile.setDefault")}
          </Button>
          <Button type="button" variant="legacy" size="legacySmall" disabled={pending} onClick={onDuplicate}>
            {t("workflows.profile.duplicate")}
          </Button>
          <Button type="button" variant="legacy" size="legacySmall" disabled={pending} onClick={onReset}>
            {t("workflows.profile.reset")}
          </Button>
          <Button type="button" variant="legacy" size="legacySmall" disabled={pending || undeletable}
            title={undeletable ? t("workflows.profile.delete.refused") : undefined} onClick={onDelete}>
            {t("common.delete")}
          </Button>
        </div>
        {undeletable ? <div className={HINT}>{t("workflows.profile.delete.refused")}</div> : null}
      </div>
    </Card>
  );
};

export const WorkflowDetailPage = ({ templateId }: { templateId: string }): ReactNode => {
  const { projectId } = useProjectScope();
  const templates = usePoll<TaskTemplate[]>(projectId === "" ? null : `/projects/${projectId}/task-templates`, 30_000);
  const profilesPath = projectId === "" ? null : `/projects/${projectId}/task-templates/${templateId}/staffing-profiles`;
  const profiles = usePoll<StaffingProfile[]>(profilesPath, 10_000);
  const { pending, error: actionError, run } = useAction();
  const [creating, setCreating] = useState(false);
  const t = useT();

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  const template = (templates.data ?? []).find((candidate) => candidate.id === templateId) ?? null;
  const held = profiles.data ?? [];

  const create = (name: string): void => {
    void run(async () => {
      const created = await api.post<StaffingProfileResponse>(profilesPath!, { name, entries: [] });
      setCreating(false);
      profiles.reload();
      navigate(`/workflows/${templateId}/profiles/${created.profile.id}`);
    });
  };
  const duplicate = (profile: StaffingProfile): void => {
    void run(async () => {
      await api.post<StaffingProfileResponse>(profilesPath!, {
        name: t("workflows.profile.copyName", { name: profile.name }),
        entries: profile.entries,
      });
      profiles.reload();
    });
  };
  const setDefault = (profile: StaffingProfile): void => {
    void run(async () => { await api.patch(`/staffing-profiles/${profile.id}`, { isDefault: true }); profiles.reload(); });
  };
  const reset = (profile: StaffingProfile): void => {
    void run(async () => { await api.post(`/staffing-profiles/${profile.id}/reset`); profiles.reload(); });
  };
  const remove = (profile: StaffingProfile): void => {
    if (!window.confirm(t("workflows.profile.confirmDelete", { name: profile.name }))) return;
    void run(async () => { await api.delete(`/staffing-profiles/${profile.id}`); profiles.reload(); });
  };

  return (
    <Page className="text-foreground">
      <div className={DETAIL_HEAD}>
        <Link to="/workflows" className={BACK_LINK}><IconArrowLeft /></Link>
        <h1 className={DETAIL_HEAD_H1}>{template?.name ?? t("common.loading")}</h1>
        <span className="flex-1" />
        <div className={PAGE_ACTIONS}>
          <Button type="button" variant="legacyPrimary" size="legacy" onClick={() => setCreating(true)}>
            <IconPlus />{t("workflows.profiles.create")}
          </Button>
        </div>
      </div>

      <div className={STACK}>
        {fatal(profiles.error, profiles.data)
          ? <ErrorNotice message={`${profiles.error!.status} ${profiles.error!.message}`} onRetry={profiles.reload} />
          : null}
        {actionError === null ? null : <ErrorNotice message={actionError} />}

        {held.length === 0 ? (
          <Card>
            <EmptyState>
              <div>{t("workflows.profiles.empty")}</div>
              <div className={cn(HINT, "mt-[6px]")}>{t("workflows.profiles.empty.hint")}</div>
            </EmptyState>
          </Card>
        ) : held.map((profile) => (
          <ProfileCard key={profile.id} templateId={templateId} profile={profile} pending={pending}
            undeletable={profile.isDefault && held.length > 1}
            onSetDefault={() => setDefault(profile)} onDuplicate={() => duplicate(profile)}
            onReset={() => reset(profile)} onDelete={() => remove(profile)} />
        ))}
      </div>

      {creating ? <NewProfile pending={pending} onClose={() => setCreating(false)} onCreate={create} /> : null}
    </Page>
  );
};

/* ------------------------------------------------------------------ editor */

const StepRow = ({ step, agents, entry, onChange }: {
  step: TaskTemplateStep;
  agents: Agent[];
  entry: DraftEntry;
  onChange: (next: DraftEntry) => void;
}): ReactNode => {
  const t = useT();
  const canonical = step.assigneeAgent === null
    ? t("workflows.editor.canonical.none")
    : t("workflows.editor.canonical", { name: step.assigneeAgent.title });
  return (
    <div data-output-kind={step.outputKind} className="border-t border-[color:var(--border-soft)] py-[14px] first:border-t-0 first:pt-0">
      <div className={cn(ROW_WRAP, "mb-[10px]")}>
        <span className="text-foreground">{step.name}</span>
        <span className={HINT}>{t("workflows.editor.step", { index: step.stepIndex, kind: step.outputKind })}</span>
        {step.optional ? <Pill tone="grey">{t("workflows.editor.optional")}</Pill> : null}
      </div>
      {step.assigneeType === "AGENT" ? (
        <div className={FIELD_ROW}>
          <Field label={t("workflows.editor.agent")}>
            <Select value={entry.assigneeAgentId} onChange={(event) => onChange({ ...entry, assigneeAgentId: event.target.value })}>
              <option value="">{canonical}</option>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agentOption(agent)}</option>)}
            </Select>
          </Field>
          {step.optional ? (
            <div className={cn(ROW, "pt-[22px]")}>
              <Toggle on={entry.include} onChange={(next) => onChange({ ...entry, include: next })}
                label={t("workflows.editor.include.aria", { name: step.name })} />
              <div>
                <div>{t("workflows.editor.include")}</div>
                <div className={HINT}>{t("workflows.editor.include.hint")}</div>
              </div>
            </div>
          ) : null}
        </div>
      ) : <div className={HINT}>{t("workflows.editor.human")}</div>}
    </div>
  );
};

/**
 * The editor's draft is local and reseeds from the poll only while no write is
 * in flight, the way `AgentToolsCard` does: a 10-second poll landing mid-edit
 * would otherwise throw away whatever the operator had typed since it started.
 */
export const StaffingProfileEditor = ({ template, profile, agents, onSaved }: {
  template: TaskTemplate;
  profile: StaffingProfile;
  agents: Agent[];
  onSaved: () => void;
}): ReactNode => {
  const incoming = seedOf(profile);
  const lastSeed = useRef(incoming);
  const [draft, setDraft] = useState<Draft>(() => draftOf(template, profile));
  const [warnings, setWarnings] = useState<StaffingProfileWarning[]>([]);
  const { pending, error, run } = useAction();
  const t = useT();
  const staffable = staffableAgents(agents);

  useEffect(() => {
    if (pending || incoming === lastSeed.current) return;
    lastSeed.current = incoming;
    setDraft(draftOf(template, profile));
  }, [incoming, pending, profile, template]);

  const save = (): void => {
    void run(async () => {
      const answer = await api.put<StaffingProfileResponse>(`/staffing-profiles/${profile.id}`, {
        name: draft.name.trim(),
        entries: entriesOf(template, draft),
      });
      setWarnings(answer.warnings);
      onSaved();
    });
  };

  return (
    <div className={STACK}>
      {error === null ? null : <ErrorNotice message={error} />}
      {warnings.map((warning) => <InfoNotice key={warning.code} message={warning.message} />)}

      <Card title={t("workflows.editor.title")} extra={
        <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || draft.name.trim() === ""} onClick={save}>
          {t("workflows.editor.save")}
        </Button>
      }>
        <div className={cn(STACK, "mb-[16px]")}>
          <Field label={t("workflows.profile.name")}>
            <Input type="text" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
        </div>
        {template.steps.map((step) => (
          <StepRow key={step.outputKind} step={step} agents={staffable}
            entry={draft.entries[step.outputKind] ?? { assigneeAgentId: "", include: true }}
            onChange={(next) => setDraft({ ...draft, entries: { ...draft.entries, [step.outputKind]: next } })} />
        ))}
      </Card>
    </div>
  );
};

export const StaffingProfilePage = ({ templateId, profileId }: { templateId: string; profileId: string }): ReactNode => {
  const { projectId } = useProjectScope();
  const templates = usePoll<TaskTemplate[]>(projectId === "" ? null : `/projects/${projectId}/task-templates`, 30_000);
  const profilesPath = projectId === "" ? null : `/projects/${projectId}/task-templates/${templateId}/staffing-profiles`;
  const profiles = usePoll<StaffingProfile[]>(profilesPath, 10_000);
  const agents = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 30_000);
  const t = useT();

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  const template = (templates.data ?? []).find((candidate) => candidate.id === templateId) ?? null;
  const profile = (profiles.data ?? []).find((candidate) => candidate.id === profileId) ?? null;

  if (fatal(profiles.error, profiles.data)) {
    return <Page><ErrorNotice message={`${profiles.error!.status} ${profiles.error!.message}`} onRetry={profiles.reload} /></Page>;
  }
  if (template === null || profile === null) return <Page><EmptyState>{t("common.loading")}</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <div className={DETAIL_HEAD}>
        <Link to={`/workflows/${templateId}`} className={BACK_LINK}><IconArrowLeft /></Link>
        <h1 className={DETAIL_HEAD_H1}>{profile.name}</h1>
        {profile.isDefault ? <Pill tone="green">{t("workflows.profile.default")}</Pill> : null}
        <span className={HINT}>{template.name}</span>
      </div>
      <StaffingProfileEditor template={template} profile={profile} agents={agents.data ?? []} onSaved={profiles.reload} />
    </Page>
  );
};
