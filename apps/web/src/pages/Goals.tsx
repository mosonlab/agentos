import { type ReactNode, useState } from "react";

import { duration, formatDateTime, money, timeAgo } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import type { Goal } from "../lib/types";
import { IconArrowLeft, IconPlus } from "../components/icons";
import {
  Card, EmptyState, ErrorNotice, GoalPill, KeyValue, Markdown, Metric, ShowMore, Tabs,
} from "../components/ui";

const dodCounts = (goal: Goal): { done: number; total: number } => {
  const items = goal.definitionOfDone ?? [];
  return { done: items.filter((item) => item.done).length, total: items.length };
};

export const GoalsPage = (): ReactNode => {
  const { projectId, project } = useProjectScope();
  const { data, loading, error, missing, reload } = usePoll<Goal[]>(projectId === "" ? null : `/projects/${projectId}/goals`, 5_000);
  const goals = data ?? [];

  if (projectId === "") return <div className="page"><EmptyState>Select a project first.</EmptyState></div>;

  return (
    <div className="page">
      <div className="pageHead">
        <div className="titles">
          <h1>Goals</h1>
          <div className="subtitle">Long-running objectives in {project?.name ?? "this project"}</div>
        </div>
        <div className="pageActions">
          {/* Kept visible but disabled: POST /projects/:projectId/goals does not exist yet. */}
          <button type="button" className="btn primary" disabled title="控制面尚无 goals 端点"><IconPlus />New Goal</button>
        </div>
      </div>

      <div className="stack">
        {missing ? (
          <div className="notice gap">
            控制面尚无 <code>GET /projects/:projectId/goals</code>（Goals 是 DECISIONS #10 的第 ⑤ 阶段，尚未实现）。
            页面按空列表渲染；端点上线后无需改动前端即可显示。
          </div>
        ) : null}
        {error !== null && !missing ? <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /> : null}

        {goals.map((goal) => {
          const counts = dodCounts(goal);
          const percent = counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100);
          return (
            <div className="goalCard clickable" key={goal.id} onClick={() => navigate(`/goals/${goal.id}`)}>
              <div className="top">
                <h3 style={{ flex: 1 }}>{goal.title}</h3>
                <GoalPill status={goal.status} />
              </div>
              <div className="mid">
                <span>{counts.done} of {counts.total} done</span>
                <span>{money(goal.spendUsd)} / {goal.spendCap === null ? "no cap" : money(goal.spendCap)}</span>
              </div>
              <div className="progressTrack"><div className="progressFill" style={{ width: `${percent}%` }} /></div>
              <div className="bottom">
                {goal.startedAt === null ? "Not started" : `${duration(goal.startedAt, goal.endedAt)} elapsed`}
                {" · "}stuck threshold {goal.stuckThreshold}
                {" · "}{goal.dodApproved ? "DoD approved" : "DoD pending approval"}
              </div>
            </div>
          );
        })}

        {goals.length === 0
          ? <Card flush><EmptyState>{loading && !missing ? "Loading…" : "No goals yet."}</EmptyState></Card>
          : null}
      </div>
    </div>
  );
};

export const GoalDetailPage = ({ goalId }: { goalId: string }): ReactNode => {
  const { data: goal, error, missing, reload } = usePoll<Goal>(`/goals/${goalId}`, 5_000);
  const [tab, setTab] = useState<"dod" | "log" | "spec">("dod");

  if (missing) {
    return (
      <div className="page">
        <div className="detailHead"><Link to="/goals" className="backLink"><IconArrowLeft />Back to Goals</Link></div>
        <div className="notice gap">控制面尚无 <code>GET /goals/:goalId</code>。</div>
      </div>
    );
  }
  if (error !== null && goal === null) {
    return <div className="page"><ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /></div>;
  }
  if (!goal) return <div className="page"><EmptyState>Loading…</EmptyState></div>;

  const counts = dodCounts(goal);
  const percent = counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100);

  return (
    <div className="page">
      <div className="detailHead">
        <Link to="/goals" className="backLink"><IconArrowLeft /></Link>
        <h1>{goal.title}</h1>
        <GoalPill status={goal.status} />
      </div>

      <div className="stack">
        <div className="metrics">
          <Metric label="DoD progress" value={`${counts.done} done · ${counts.total - counts.done} open`} />
          <Metric label="Spend" value={`${money(goal.spendUsd)} / ${goal.spendCap === null ? "no cap" : money(goal.spendCap)}`} />
          <Metric label="Stuck threshold" value={`${goal.stuckThreshold}`} />
          <Metric label="Runner" value={goal.runnerPreference.toLowerCase()} />
        </div>

        <div className="progressTrack"><div className="progressFill" style={{ width: `${percent}%` }} /></div>

        <Card title="Details">
          <KeyValue items={[
            { k: "Status", v: goal.status.toLowerCase().replace(/_/g, " ") },
            { k: "DoD approved", v: goal.dodApproved ? "Yes" : "No" },
            { k: "Started", v: formatDateTime(goal.startedAt) },
            { k: "Ended", v: formatDateTime(goal.endedAt) },
            { k: "Wall-clock limit", v: goal.maxDurationMin === null ? "—" : `${goal.maxDurationMin} min` },
            { k: "Stall timeout", v: `${goal.stallTimeoutMin} min` },
            { k: "Shared folder", v: goal.sharedFolderPath ?? "—" },
            { k: "Updated", v: timeAgo(goal.updatedAt) },
          ]} />
        </Card>

        <Tabs value={tab} onChange={setTab} options={[
          { value: "dod", label: "Definition of Done" },
          { value: "log", label: "Progress log" },
          { value: "spec", label: "Spec" },
        ]} />

        {tab === "dod" ? (
          <Card title="Definition of Done" extra={<span className="count">{counts.total}</span>}>
            {(goal.definitionOfDone ?? []).length === 0
              ? <EmptyState>No criteria recorded.</EmptyState>
              : (goal.definitionOfDone ?? []).map((item) => (
                <div key={item.id} className="row" style={{ padding: "10px 0", borderTop: "1px solid var(--line-soft)" }}>
                  <span className={item.done ? "pill green" : "pill grey"}>{item.done ? "done" : "open"}</span>
                  <span style={{ flex: 1 }}>{item.text}</span>
                </div>
              ))}
          </Card>
        ) : null}

        {tab === "log" ? (
          <Card title="Progress log" extra={<span className="count">{(goal.progressLog ?? []).length}</span>}>
            {(goal.progressLog ?? []).length === 0
              ? <EmptyState>No entries yet.</EmptyState>
              : (goal.progressLog ?? []).map((entry) => (
                <div className="msgCard" key={entry.id}>
                  <div className="msgHead"><span className="strong">Progress</span><span className="time">{formatDateTime(entry.createdAt)}</span></div>
                  <Markdown text={entry.body} />
                </div>
              ))}
          </Card>
        ) : null}

        {tab === "spec" ? (
          <Card title="Spec">
            {goal.spec.trim().length === 0 ? <EmptyState>No spec recorded.</EmptyState> : <ShowMore text={goal.spec} lines={14} />}
          </Card>
        ) : null}
      </div>
    </div>
  );
};
