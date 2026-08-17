import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { duration, formatDateTime, money, timeAgo } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import type { Goal, RunnerPreference } from "../lib/types";
import { IconArrowLeft, IconPlus } from "../components/icons";
import { GoalLimitInputs } from "../components/goal-limit-inputs";
import { cn } from "../lib/utils";
import {
  BACK_LINK, COUNT, DETAIL_HEAD, DETAIL_HEAD_H1, METRICS, MSG_CARD, MSG_HEAD, MSG_TIME, PAGE_ACTIONS,
  PAGE_HEAD, PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, ROW, STACK,
  Card, EmptyState, ErrorNotice, Field, FullPanel, GoalPill, KeyValue, Markdown, Metric, Page, Pill,
  ShowMore, Tabs,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";

const GOAL_CARD = "cursor-pointer rounded-xl border border-border bg-card px-[18px] py-[16px]";
const GOAL_MID = "mt-[10px] mb-[8px] flex justify-between text-[12px] text-muted-foreground";
/** `.progressTrack`: the primitive already brings `rounded-full overflow-hidden`,
 *  and twMerge drops its `h-2` / `bg-primary/20` (B14 keeps progress.tsx untouched). */
const PROGRESS_TRACK = "h-[8px] bg-accent";

const NewGoal = ({ projectId, onClose, onCreated }: {
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}): ReactNode => {
  const [form, setForm] = useState({
    title: "", spec: "", spendCap: "", maxDurationMin: "120", stallTimeoutMin: "10",
    stuckThreshold: "19", runnerPreference: "AUTO" as RunnerPreference, sharedFolderPath: "",
  });
  const [items, setItems] = useState([""]);
  const { pending, error, run } = useAction();
  const t = useT();

  const submit = async (): Promise<void> => {
    const ok = await run(() => api.post<Goal>(`/projects/${projectId}/goals`, {
      title: form.title,
      spec: form.spec,
      spendCap: form.spendCap.trim() === "" ? null : Number(form.spendCap),
      maxDurationMin: form.maxDurationMin.trim() === "" ? null : Number(form.maxDurationMin),
      stallTimeoutMin: Number(form.stallTimeoutMin),
      stuckThreshold: Number(form.stuckThreshold),
      runnerPreference: form.runnerPreference,
      sharedFolderPath: form.sharedFolderPath.trim() === "" ? null : form.sharedFolderPath,
      definitionOfDone: items.map((text) => text.trim()).filter(Boolean).map((text) => ({ text })),
    }));
    if (ok) { onCreated(); onClose(); }
  };

  const valid = form.title.trim() !== "" && items.some((item) => item.trim() !== "")
    && Number(form.stallTimeoutMin) > 0 && Number(form.stuckThreshold) > 0;
  return (
    <FullPanel title={t("goals.new.title")} onClose={onClose} actions={
      <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || !valid} onClick={() => void submit()}>{t("goals.new.create")}</Button>
    }>
      {error === null ? null : <ErrorNotice message={error} />}
      <Card title={t("goals.new.card")}>
        <div className={STACK}>
          <Field label={t("goals.field.title")}><Input type="text" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder={t("goals.field.title.placeholder")} /></Field>
          <Field label={t("goals.field.spec")}><Textarea rows={10} value={form.spec} onChange={(event) => setForm({ ...form, spec: event.target.value })} placeholder={t("goals.field.spec.placeholder")} /></Field>
          <GoalLimitInputs values={form} onChange={(key, value) => setForm({ ...form, [key]: value })} runner={
            <Field label={t("goals.field.runner")}><Select value={form.runnerPreference} onChange={(event) => setForm({ ...form, runnerPreference: event.target.value as RunnerPreference })}>{["AUTO", "CLAUDE", "CODEX", "PI"].map((runner) => <option key={runner} value={runner}>{runner.toLowerCase()}</option>)}</Select></Field>
          } />
          <Field label={t("goals.field.sharedFolder.label")} hint={t("goals.field.sharedFolder.hint")}><Input type="text" value={form.sharedFolderPath} onChange={(event) => setForm({ ...form, sharedFolderPath: event.target.value })} placeholder="/path/to/shared/folder" /></Field>
        </div>
      </Card>
      <Card title={t("goals.dod.title")} extra={<Button type="button" variant="legacy" size="legacySmall" onClick={() => setItems([...items, ""])}><IconPlus />{t("goals.dod.add")}</Button>}>
        <div className={STACK}>
          {items.map((item, index) => (
            <div className={ROW} key={index}>
              <Input type="text" value={item} onChange={(event) => setItems(items.map((value, itemIndex) => itemIndex === index ? event.target.value : value))} placeholder={t("goals.dod.criterion", { n: index + 1 })} />
              {items.length > 1 ? <Button type="button" variant="legacy" size="legacySmall" onClick={() => setItems(items.filter((_, itemIndex) => itemIndex !== index))}>{t("goals.dod.remove")}</Button> : null}
            </div>
          ))}
        </div>
      </Card>
    </FullPanel>
  );
};

const dodCounts = (goal: Goal): { done: number; total: number } => {
  const items = goal.definitionOfDone ?? [];
  return { done: items.filter((item) => item.done).length, total: items.length };
};

export const GoalsPage = (): ReactNode => {
  const { projectId, project } = useProjectScope();
  const { data, loading, error, reload } = usePoll<Goal[]>(projectId === "" ? null : `/projects/${projectId}/goals`, 5_000);
  const goals = data ?? [];
  const [creating, setCreating] = useState(false);
  const t = useT();

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("goals.head.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>{t("goals.head.subtitle", { project: project?.name ?? t("goals.head.thisProject") })}</div>
        </div>
        <div className={PAGE_ACTIONS}>
          <Button type="button" variant="legacyPrimary" size="legacy" onClick={() => setCreating(true)}><IconPlus />{t("goals.new.button")}</Button>
        </div>
      </div>

      <div className={STACK}>
        {error !== null ? <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /> : null}

        {goals.map((goal, index) => {
          const counts = dodCounts(goal);
          const percent = counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100);
          return (
            <div className={cn(GOAL_CARD, index > 0 && "mt-[12px]")} key={goal.id} onClick={() => navigate(`/goals/${goal.id}`)}>
              <div className={ROW}>
                <h3 className="flex-1 text-[1.17em]">{goal.title}</h3>
                <GoalPill status={goal.status} />
              </div>
              <div className={GOAL_MID}>
                <span>{t("goals.card.done", { done: counts.done, total: counts.total })}</span>
                <span>{money(goal.spendUsd)} / {goal.spendCap === null ? t("goals.noCap") : money(goal.spendCap)}</span>
              </div>
              <Progress value={percent} className={PROGRESS_TRACK} />
              <div className="mt-[9px] text-[12px] text-muted-foreground">
                {goal.startedAt === null ? t("goals.card.notStarted") : t("goals.card.elapsed", { duration: duration(goal.startedAt, goal.endedAt) })}
                {" · "}{t("goals.card.stuckThreshold", { n: goal.stuckThreshold })}
                {" · "}{t(goal.dodApproved ? "goals.card.dodApproved" : "goals.card.dodPending")}
              </div>
            </div>
          );
        })}

        {goals.length === 0
          ? <Card flush><EmptyState>{t(loading ? "common.loading" : "goals.empty")}</EmptyState></Card>
          : null}
      </div>
      {creating ? <NewGoal projectId={projectId} onClose={() => setCreating(false)} onCreated={reload} /> : null}
    </Page>
  );
};

export const GoalDetailPage = ({ goalId }: { goalId: string }): ReactNode => {
  const { data: goal, error, reload } = usePoll<Goal>(`/goals/${goalId}`, 5_000);
  const [tab, setTab] = useState<"dod" | "log" | "spec">("dod");
  const [progress, setProgress] = useState("");
  const { pending, error: actionError, run } = useAction();
  const t = useT();

  const addProgress = async (): Promise<void> => {
    const ok = await run(() => api.post(`/goals/${goalId}/progress-log`, { body: progress }));
    if (ok) { setProgress(""); reload(); }
  };

  if (error !== null && goal === null) {
    return <Page><ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /></Page>;
  }
  if (!goal) return <Page><EmptyState>{t("common.loading")}</EmptyState></Page>;

  const counts = dodCounts(goal);
  const percent = counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100);

  return (
    <Page className="text-foreground">
      <div className={DETAIL_HEAD}>
        <Link to="/goals" className={BACK_LINK}><IconArrowLeft /></Link>
        <h1 className={DETAIL_HEAD_H1}>{goal.title}</h1>
        <GoalPill status={goal.status} />
      </div>

      <div className={STACK}>
        <div className={METRICS}>
          <Metric label={t("goals.metric.dod")} value={t("goals.metric.dodValue", { done: counts.done, open: counts.total - counts.done })} />
          <Metric label={t("goals.metric.spend")} value={`${money(goal.spendUsd)} / ${goal.spendCap === null ? t("goals.noCap") : money(goal.spendCap)}`} />
          <Metric label={t("goals.metric.stuckThreshold")} value={`${goal.stuckThreshold}`} />
          <Metric label={t("goals.field.runner")} value={goal.runnerPreference.toLowerCase()} />
        </div>

        <Progress value={percent} className={PROGRESS_TRACK} />

        <Card title={t("projects.details.title")}>
          <KeyValue items={[
            { k: t("goals.details.status"), v: t(`status.goal.${goal.status}`) },
            { k: t("goals.details.dodApproved"), v: t(goal.dodApproved ? "common.yes" : "common.no") },
            { k: t("goals.details.started"), v: formatDateTime(goal.startedAt) },
            { k: t("goals.details.ended"), v: formatDateTime(goal.endedAt) },
            { k: t("projects.details.wallClock"), v: goal.maxDurationMin === null ? t("common.none") : t("projects.details.minutes", { n: goal.maxDurationMin }) },
            { k: t("projects.details.stall"), v: t("projects.details.minutes", { n: goal.stallTimeoutMin }) },
            { k: t("goals.field.sharedFolder.label"), v: goal.sharedFolderPath ?? t("common.none") },
            { k: t("common.updated"), v: timeAgo(goal.updatedAt) },
          ]} />
        </Card>

        <Tabs value={tab} onChange={setTab} options={[
          { value: "dod", label: t("goals.dod.title") },
          { value: "log", label: t("goals.log.title") },
          { value: "spec", label: t("goals.field.spec") },
        ]} />

        {tab === "dod" ? (
          <Card title={t("goals.dod.title")} extra={<span className={COUNT}>{counts.total}</span>}>
            {(goal.definitionOfDone ?? []).length === 0
              ? <EmptyState>{t("goals.dod.empty")}</EmptyState>
              : (goal.definitionOfDone ?? []).map((item) => (
                <div key={item.id} className={cn(ROW, "border-t border-[var(--border-soft)] py-2.5")}>
                  <Pill tone={item.done ? "green" : "grey"}>{t(item.done ? "goals.dod.done" : "goals.dod.open")}</Pill>
                  <span className="flex-1">{item.text}</span>
                </div>
              ))}
          </Card>
        ) : null}

        {tab === "log" ? (
          <Card title={t("goals.log.title")} extra={<span className={COUNT}>{(goal.progressLog ?? []).length}</span>}>
            <div className={cn(STACK, "mb-3.5")}>
              {actionError === null ? null : <ErrorNotice message={actionError} />}
              <Field label={t("goals.log.addLabel")}>
                <Textarea rows={4} value={progress} onChange={(event) => setProgress(event.target.value)} placeholder={t("goals.log.placeholder")} />
              </Field>
              <div className={ROW}><span className="flex-1" /><Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || progress.trim() === ""} onClick={() => void addProgress()}>{t("goals.log.add")}</Button></div>
            </div>
            {(goal.progressLog ?? []).length === 0
              ? <EmptyState>{t("goals.log.empty")}</EmptyState>
              : (goal.progressLog ?? []).map((entry, index) => (
                <div className={cn(MSG_CARD, index > 0 && "mt-[12px]")} key={entry.id}>
                  <div className={MSG_HEAD}><span className="text-foreground">{t("goals.log.entry")}</span><span className={MSG_TIME}>{formatDateTime(entry.createdAt)}</span></div>
                  <Markdown text={entry.body} />
                </div>
              ))}
          </Card>
        ) : null}

        {tab === "spec" ? (
          <Card title={t("goals.field.spec")}>
            {goal.spec.trim().length === 0 ? <EmptyState>{t("goals.spec.empty")}</EmptyState> : <ShowMore text={goal.spec} lines={14} />}
          </Card>
        ) : null}
      </div>
    </Page>
  );
};
