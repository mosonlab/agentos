import { type ReactNode, useEffect, useState } from "react";

import { api } from "../lib/api";
import { useAction, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import type { Agent, Project, Repo, TaskTemplate, TaskTemplateStep } from "../lib/types";
import {
  CARD_TITLE, CODE_BLOCK, FIELD_ROW, HINT, ROW, STACK,
  Card, Check, EmptyState, ErrorNotice, Field, FullPanel, Tabs, Toggle,
} from "./ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Textarea } from "./ui/textarea";

/* Hoisted verbatim out of pages/Tasks.tsx so all four Tasks tabs can open it:
 * `+ Create Task` lives in the shared page head, and a button that does nothing
 * on three of the four tabs is not a button. The body below is a pure
 * relocation — only the `export` keyword is new. */

type GateSlot = "spec" | "merge";
type GateValues = Partial<Record<GateSlot, boolean>>;
type GateSelection = { contextKey: string; initial: GateValues; current: GateValues };

/** Keep the browser's slot identity in step with the server's structural rule.
 * Versioned output kinds are part of the compatibility contract, so a suffix
 * such as `merge-authorization-v2` still identifies the merge slot. */
const gateSlotOf = (step: Pick<TaskTemplateStep, "outputKind">): GateSlot | null => {
  const outputKind = step.outputKind.replace(/-(v[1-9]\d*)$/u, "");
  if (outputKind === "spec") return "spec";
  if (outputKind === "merge-authorization") return "merge";
  return null;
};

const gateSlotsOf = (template: TaskTemplate | null): GateSlot[] => {
  if (template === null) return [];
  return (["spec", "merge"] as const).filter((slot) => template.steps.some((step) => gateSlotOf(step) === slot));
};

const gateDefaults = (project: Project | null | undefined): Record<GateSlot, boolean> => ({
  spec: project?.specGateDefault ?? false,
  merge: project?.mergeGateDefault ?? false,
});

const gateSelectionFor = (
  contextKey: string,
  template: TaskTemplate | null,
  project: Project | null | undefined,
): GateSelection => {
  const defaults = gateDefaults(project);
  const initial: GateValues = {};
  for (const slot of gateSlotsOf(template)) initial[slot] = defaults[slot];
  return { contextKey, initial, current: { ...initial } };
};

const changedGateValues = (selection: GateSelection): GateValues | undefined => {
  const changed: GateValues = {};
  for (const slot of ["spec", "merge"] as const) {
    if (selection.current[slot] !== selection.initial[slot] && selection.current[slot] !== undefined) {
      changed[slot] = selection.current[slot];
    }
  }
  return Object.keys(changed).length === 0 ? undefined : changed;
};

export const NewTask = ({ projectId, project, agents, repos, onClose, onCreated }: {
  projectId: string;
  project?: Project | null;
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
    // The API defaults this to true when the field is absent, which is
    // behaviour every existing workflow depends on. That default is exactly why
    // the form carries it: a task whose delivery must not open a pull request
    // has to be able to say so here, and it has to say so by sending the field
    // rather than by omitting it.
    opensPullRequest: true,
    maxDurationMin: 240, stallTimeoutMin: 10, maxSessionsPerTask: 5,
  });
  const [templateId, setTemplateId] = useState("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const { pending, error, run } = useAction();
  const t = useT();

  const template = (templates.data ?? []).find((candidate) => candidate.id === templateId) ?? templates.data?.[0] ?? null;
  const specDefault = project?.specGateDefault ?? false;
  const mergeDefault = project?.mergeGateDefault ?? false;
  /** Defaults are part of the dispatch context: if the operator changes the
   * selected project while this panel is open, the old project's choices must
   * not become overrides for the new one. */
  const gateContextKey = `${projectId}:${template?.id ?? ""}:${specDefault}:${mergeDefault}`;
  const [gateSelection, setGateSelection] = useState<GateSelection>(() => (
    gateSelectionFor(gateContextKey, template, project)
  ));
  useEffect(() => {
    setGateSelection((held) => held.contextKey === gateContextKey
      ? held
      : gateSelectionFor(gateContextKey, template, project));
  }, [gateContextKey, project, template]);
  // Effects run after the first paint. Use the new context synchronously for
  // that render as well, so an immediate Create click cannot submit stale
  // values while React is scheduling the reset effect.
  const activeGateSelection = gateSelection.contextKey === gateContextKey
    ? gateSelection
    : gateSelectionFor(gateContextKey, template, project);
  const gateSlots = gateSlotsOf(template);

  useEffect(() => {
    setTemplateId("");
    setVariables({});
  }, [projectId]);

  const toggleGate = (slot: GateSlot, next: boolean): void => {
    setGateSelection((held) => {
      const baseline = held.contextKey === gateContextKey
        ? held
        : gateSelectionFor(gateContextKey, template, project);
      return { ...baseline, current: { ...baseline.current, [slot]: next } };
    });
  };

  const createBlank = async (): Promise<void> => {
    const ok = await run(() => api.post(`/projects/${projectId}/tasks`, {
      name: form.name,
      description: form.description,
      assigneeType: form.assigneeType,
      assigneeAgentId: form.assigneeType === "AGENT" ? form.assigneeAgentId : null,
      repoId: form.repoId === "" ? null : form.repoId,
      targetBranch: form.targetBranch === "" ? null : form.targetBranch,
      approvalGate: form.approvalGate,
      // Always sent, never inferred. If this field ever drops out of the body
      // the request still succeeds and silently opens a pull request, so
      // `new-task-fixture.test.tsx` asserts it is present on the wire.
      opensPullRequest: form.opensPullRequest,
      maxDurationMin: form.maxDurationMin,
      stallTimeoutMin: form.stallTimeoutMin,
      maxSessionsPerTask: form.maxSessionsPerTask,
    }));
    if (ok) { onCreated(); onClose(); }
  };

  const createFromTemplate = async (): Promise<void> => {
    if (!template) return;
    const gates = changedGateValues(activeGateSelection);
    const ok = await run(() => api.post(`/projects/${projectId}/task-templates/${template.id}/instantiate`, {
      name: form.name,
      repoId: form.repoId,
      variables,
      autoStart: false,
      ...(gates === undefined ? {} : { gates }),
    }));
    if (ok) { onCreated(); onClose(); }
  };

  return (
    <FullPanel title={t("newTask.title")} onClose={onClose} actions={
      <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || form.name.trim() === "" || (mode === "template" && template === null)}
        onClick={() => void (mode === "blank" ? createBlank() : createFromTemplate())}>
        {t("newTask.create")}
      </Button>
    }>
      <Tabs value={mode} onChange={setMode} options={[{ value: "blank", label: t("newTask.tab.blank") }, { value: "template", label: t("newTask.tab.template") }]} />
      {error === null ? null : <ErrorNotice message={error} />}

      {mode === "blank" ? (
        <Card title={t("newTask.card.task")}>
          <div className={STACK}>
            <Field label={t("newTask.field.title.label")}><Input type="text" value={form.name} autoFocus onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t("newTask.field.title.placeholder")} /></Field>
            <Field label={t("newTask.field.prompt.label")} hint={t("newTask.field.prompt.hint")}>
              <Textarea rows={10} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </Field>
            <div className={FIELD_ROW}>
              <Field label={t("newTask.field.assigneeType.label")}>
                <Select value={form.assigneeType} onChange={(event) => setForm({ ...form, assigneeType: event.target.value as "AGENT" | "HUMAN" })}>
                  <option value="AGENT">{t("newTask.option.agent")}</option>
                  <option value="HUMAN">{t("newTask.option.human")}</option>
                </Select>
              </Field>
              <Field label={t("newTask.field.agent.label")} hint={t("newTask.field.agent.hint")}>
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
              <Field label={t("newTask.field.repo.label")}>
                <Select value={form.repoId} onChange={(event) => setForm({ ...form, repoId: event.target.value })}>
                  <option value="">{t("newTask.option.noRepo")}</option>
                  {repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
                </Select>
              </Field>
              <Field label={t("newTask.field.branch.label")} hint={t("newTask.field.branch.hint")}>
                <Input type="text" value={form.targetBranch} onChange={(event) => setForm({ ...form, targetBranch: event.target.value })} placeholder="feat/…" />
              </Field>
            </div>
            <div className={ROW}>
              <Toggle on={form.approvalGate} onChange={(next) => setForm({ ...form, approvalGate: next })} label={t("newTask.approval.label")} />
              <div>
                <div>{t("newTask.approval.label")}</div>
                <div>{t("newTask.approval.hint")}</div>
              </div>
            </div>
            <div className={ROW}>
              <Toggle on={form.opensPullRequest} onChange={(next) => setForm({ ...form, opensPullRequest: next })} label={t("newTask.pullRequest.label")} />
              <div>
                <div>{t("newTask.pullRequest.label")}</div>
                <div>{t("newTask.pullRequest.hint")}</div>
              </div>
            </div>
            <div className={FIELD_ROW}>
              <Field label={t("newTask.field.wallClock.label")} hint={t("newTask.field.wallClock.hint")}>
                <Input type="number" min={1} value={form.maxDurationMin} onChange={(event) => setForm({ ...form, maxDurationMin: Number(event.target.value) })} />
              </Field>
              <Field label={t("newTask.field.stall.label")} hint={t("newTask.field.stall.hint")}>
                <Input type="number" min={1} value={form.stallTimeoutMin} onChange={(event) => setForm({ ...form, stallTimeoutMin: Number(event.target.value) })} />
              </Field>
              <Field label={t("newTask.field.maxRuns.label")} hint={t("newTask.field.maxRuns.hint")}>
                <Input type="number" min={1} value={form.maxSessionsPerTask} onChange={(event) => setForm({ ...form, maxSessionsPerTask: Number(event.target.value) })} />
              </Field>
            </div>
          </div>
        </Card>
      ) : (
        <Card title={t("newTask.card.template")}>
          {(templates.data ?? []).length === 0
            ? <EmptyState>{t("newTask.templates.empty")}</EmptyState>
            : (
              <div className={STACK}>
                <Field label={t("newTask.field.title.label")}>
                  <Input type="text" value={form.name} autoFocus onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t("newTask.field.title.placeholder")} />
                </Field>
                <Field label={t("newTask.field.template.label")}>
                  <Select value={template?.id ?? ""} onChange={(event) => { setTemplateId(event.target.value); setVariables({}); }}>
                    {(templates.data ?? []).map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>{t("newTask.template.option", { name: candidate.name, n: candidate.steps.length })}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("newTask.field.repo.label")}>
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
                {gateSlots.length === 0 ? null : (
                  <div className="grid gap-[10px]">
                    <div className={CARD_TITLE}>{t("newTask.gates.title")}</div>
                    {gateSlots.map((slot) => {
                      const label = t(`newTask.gates.${slot}`);
                      return (
                        <div className={ROW} key={slot}>
                          <Check
                            on={activeGateSelection.current[slot] === true}
                            onChange={(next) => toggleGate(slot, next)}
                            label={label}
                          />
                          <div>
                            <div>{label}</div>
                            <div className={HINT}>{t(`newTask.gates.${slot}.hint`)}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {template ? (
                  <div>
                    <div className={CARD_TITLE}>{t("newTask.preview.title")}</div>
                    <div className={CODE_BLOCK}>
                      {template.steps.map((step) => {
                        const slot = gateSlotOf(step);
                        return [
                          `- ${step.name}`,
                          `    ${t("newTask.preview.agent", { name: step.assigneeAgent?.title ?? t("newTask.preview.human") })}`,
                          (slot === null ? step.approvalGate : activeGateSelection.current[slot] === true)
                            ? `    ${t("newTask.preview.gate")}`
                            : null,
                          step.optional ? `    ${t("newTask.preview.optional")}` : null,
                        ].filter((line) => line !== null).join("\n");
                      }).join("\n")}
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
