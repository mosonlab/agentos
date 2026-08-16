import { type ReactNode, useState } from "react";

import { api, apiBase } from "../lib/api";
import { chainMarker } from "../lib/chain";
import { timeAgo } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { fatal } from "../lib/poll-state";
import { useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import type { Trigger, TriggerDetail, TriggerFire } from "../lib/types";
import { IconArrowLeft, IconBolt } from "../components/icons";
import { TasksPageHead } from "../components/tasks-tabs";
import {
  BACK_LINK, CODE_BLOCK, DETAIL_HEAD, DETAIL_HEAD_H1, FIELD, FIELD_LABEL, FIELD_ROW, HINT, STACK,
  TABLE_NAME, TABLE_SUB, TABLE_TIGHT,
  Card, EmptyState, ErrorNotice, Field, KeyValue, Page, Pill, RowMenu,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { cn } from "../lib/utils";

/** §4.5's Status column. A disabled secret outranks a pause: the trigger cannot
 *  authenticate at all, so saying "Paused" would understate it. */
export const triggerState = (trigger: { paused: boolean; secretDisabled: boolean }): { tone: "green" | "amber" | "red"; label: string } => {
  if (trigger.secretDisabled) return { tone: "red", label: "Disabled secret" };
  if (trigger.paused) return { tone: "amber", label: "Paused" };
  return { tone: "green", label: "Enabled" };
};

/* -------------------------------------------------------------------- list */

export const TriggerRow = ({ trigger, onFire, onTogglePause }: {
  trigger: Trigger;
  onFire: (trigger: Trigger) => void;
  onTogglePause: (trigger: Trigger) => void;
}): ReactNode => {
  const state = triggerState(trigger);
  return (
    <TableRow className="cursor-pointer" onClick={(event) => { if (!event.defaultPrevented) navigate(`/triggers/${trigger.id}`); }}>
      <TableCell className={TABLE_NAME}>
        <Link to={`/triggers/${trigger.id}`}>{trigger.name}</Link>
        <span className={cn(TABLE_SUB, "block max-w-[420px] overflow-hidden text-ellipsis whitespace-nowrap")}>{trigger.description}</span>
      </TableCell>
      <TableCell>
        {/* A trigger without a repository cannot fire. Hiding the row would hide
            the reason, so it is spelled out in the destructive colour instead. */}
        {trigger.repo === null
          ? <span className="text-[color:var(--destructive-fg)]">no repository · {trigger.stepCount} steps</span>
          : <span>{trigger.repo.name} · {trigger.stepCount} steps</span>}
      </TableCell>
      <TableCell><Pill tone={state.tone}>{state.label}</Pill></TableCell>
      <TableCell>{trigger.lastFiredAt === null ? "Never" : timeAgo(trigger.lastFiredAt)}</TableCell>
      {/* `0` is a fact, not a gap: `—` would read as "unknown". */}
      <TableCell>{trigger.fireCount}</TableCell>
      <TableCell className={TABLE_TIGHT}>
        <RowMenu items={[
          { label: "Fire now", onSelect: () => onFire(trigger) },
          { label: trigger.paused ? "Enable" : "Pause", onSelect: () => onTogglePause(trigger) },
          { label: "Open", onSelect: () => navigate(`/triggers/${trigger.id}`) },
        ]} />
      </TableCell>
    </TableRow>
  );
};

export const TriggersPage = (): ReactNode => {
  const { projectId } = useProjectScope();
  const path = projectId === "" ? null : `/projects/${projectId}/triggers`;
  const { data, loading, error, reload } = usePoll<Trigger[]>(path);
  const { error: actionError, run } = useAction();
  const triggers = data ?? [];

  const fire = (trigger: Trigger): void => {
    void run(async () => { await api.post(`/task-templates/${trigger.id}/fire`, {}); reload(); });
  };
  const togglePause = (trigger: Trigger): void => {
    void run(async () => { await api.post(`/triggers/${trigger.id}/${trigger.paused ? "enable" : "pause"}`, {}); reload(); });
  };

  if (projectId === "") return <Page><EmptyState>Select a project first.</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <TasksPageHead active="triggers" />
      <div className={STACK}>
        {fatal(error, data) ? <ErrorNotice message={`${error!.status} ${error!.message}`} onRetry={reload} /> : null}
        {actionError === null ? null : <ErrorNotice message={actionError} />}

        {triggers.length === 0 ? (
          <EmptyState>
            <span className="mb-[10px] inline-flex text-[color:var(--faint)]"><IconBolt size={22} /></span>
            <div>{loading ? "Loading…" : "No triggers yet"}</div>
            <div className={cn(HINT, "mt-[6px]")}>A task template with a webhook secret becomes a trigger: an outside system can fire a chain by posting to its endpoint.</div>
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last fired</TableHead>
                <TableHead>Fires</TableHead>
                <TableHead className={TABLE_TIGHT} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {triggers.map((trigger) => (
                <TriggerRow key={trigger.id} trigger={trigger} onFire={fire} onTogglePause={togglePause} />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Page>
  );
};

/* ------------------------------------------------------------------ detail */

/** The endpoint card. No secret value is rendered, and none can be: no route
 *  returns one. `secret-value-input.tsx` is deliberately not reused here. */
export const EndpointCard = ({ trigger }: { trigger: TriggerDetail }): ReactNode => {
  const url = `POST ${apiBase}${trigger.endpointPath}`;
  return (
    <Card title="Endpoint" extra={
      <Button type="button" variant="legacy" size="legacySmall" className="shadow-none"
        onClick={() => { void navigator.clipboard?.writeText(url.replace(/^POST /, "")); }}>
        Copy
      </Button>
    }>
      <div className={CODE_BLOCK}>{url}</div>
      <KeyValue items={[
        { k: "Secret header", v: <code>X-AgentOS-Webhook-Secret</code> },
        { k: "Secret", v: trigger.secretName ?? "—" },
        { k: "Delivery id header", v: <code>X-AgentOS-Delivery-Id</code> },
      ]} />
    </Card>
  );
};

export const VariablesCard = ({ trigger, mapping, defaults, onChange }: {
  trigger: TriggerDetail;
  mapping: Record<string, string>;
  defaults: Record<string, string>;
  onChange: (next: { mapping: Record<string, string>; defaults: Record<string, string> }) => void;
}): ReactNode => (
  <Card title="Default variables">
    {trigger.variables.length === 0
      ? <EmptyState>This template takes no variables.</EmptyState>
      : (
        <div className={STACK}>
          {trigger.variables.map((name) => {
            const path = mapping[name] ?? "";
            const fallback = defaults[name] ?? "";
            return (
              <div className={FIELD_ROW} key={name}>
                {/* The badge rides the variable's own label rather than a third
                    grid cell: `auto-fit` would otherwise give the badged rows one
                    more column than the rest, so no two rows would line up — and
                    a `1fr` cell stretches the pill into a bar. */}
                <div className={FIELD}>
                  <label className="flex items-center gap-[8px]">
                    <span className={FIELD_LABEL}>{name}</span>
                    {/* A variable with neither a payload path nor a default is
                        the one that makes a delivery fail with 400. */}
                    {path === "" && fallback === "" ? <Pill tone="red">required</Pill> : null}
                  </label>
                  <Input type="text" value={path} placeholder="issue.title"
                    onChange={(event) => onChange({ mapping: { ...mapping, [name]: event.target.value }, defaults })} />
                  <div className={HINT}>Dotted path into the delivery payload.</div>
                </div>
                <Field label="Default">
                  <Input type="text" value={fallback} placeholder="—"
                    onChange={(event) => onChange({ mapping, defaults: { ...defaults, [name]: event.target.value } })} />
                </Field>
              </div>
            );
          })}
        </div>
      )}
  </Card>
);

export const FiresCard = ({ fires }: { fires: TriggerFire[] }): ReactNode => (
  <Card title="Recent fires" flush>
    {fires.length === 0 ? <EmptyState>No fires yet.</EmptyState> : (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead><TableHead>Source</TableHead><TableHead>Chain</TableHead><TableHead>Progress</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {fires.map((fire) => (
            <TableRow key={fire.id}>
              <TableCell>{timeAgo(fire.createdAt)}</TableCell>
              <TableCell><Pill tone={fire.source === "WEBHOOK" ? "accent" : "grey"}>{fire.source.toLowerCase()}</Pill></TableCell>
              <TableCell>
                {fire.firstTask === null
                  ? <span className="text-muted-foreground">chain deleted</span>
                  : <Link to={`/tasks/${fire.firstTask.id}`}>{fire.firstTask.name}</Link>}
              </TableCell>
              <TableCell>{chainMarker(fire.progress) ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )}
  </Card>
);

export const TriggerDetailPage = ({ templateId }: { templateId: string }): ReactNode => {
  const { data: trigger, error, reload } = usePoll<TriggerDetail>(`/triggers/${templateId}`);
  const fires = usePoll<TriggerFire[]>(`/triggers/${templateId}/fires?take=20`);
  const { pending, error: actionError, run } = useAction();
  const [edits, setEdits] = useState<{ mapping: Record<string, string>; defaults: Record<string, string>; window: string } | null>(null);

  if (fatal(error, trigger)) {
    return <Page><ErrorNotice message={`${error!.status} ${error!.message}`} onRetry={reload} /></Page>;
  }
  if (!trigger) return <Page><EmptyState>Loading…</EmptyState></Page>;

  // Edits start from the server's copy and stay local until Save changes.
  const draft = edits ?? {
    mapping: trigger.mapping,
    defaults: Object.fromEntries(Object.entries(trigger.defaults).map(([key, value]) => [key, String(value)])),
    window: trigger.replayWindowSec === null ? "" : String(trigger.replayWindowSec),
  };
  const state = triggerState(trigger);

  const fire = (): void => {
    void run(async () => { await api.post(`/task-templates/${trigger.id}/fire`, {}); reload(); fires.reload(); });
  };
  const togglePause = (): void => {
    void run(async () => { await api.post(`/triggers/${trigger.id}/${trigger.paused ? "enable" : "pause"}`, {}); reload(); });
  };
  const save = (): void => {
    // The zod schema replaces webhookPayloadMapping wholesale, so the whole
    // object goes over the wire, not a patch of it.
    const strip = (record: Record<string, string>): Record<string, string> =>
      Object.fromEntries(Object.entries(record).filter(([, value]) => value !== ""));
    void run(async () => {
      await api.patch(`/task-templates/${trigger.id}`, {
        webhookPayloadMapping: { map: strip(draft.mapping), defaults: strip(draft.defaults) },
        webhookReplayWindowSec: draft.window.trim() === "" ? null : Number(draft.window),
      });
      setEdits(null);
      reload();
    });
  };

  return (
    <Page className="text-foreground">
      <div className={DETAIL_HEAD}>
        <Link to="/triggers" className={BACK_LINK}><IconArrowLeft /></Link>
        <h1 className={DETAIL_HEAD_H1}>{trigger.name}</h1>
        <Pill tone="violet">Template</Pill>
        <Pill tone={state.tone}>{state.label}</Pill>
        <span className="flex-1" />
        <Button type="button" variant="legacy" size="legacy" disabled={pending} onClick={togglePause}>
          {trigger.paused ? "Enable" : "Pause"}
        </Button>
        {/* Still enabled while paused ([A5]): a pause stops the outside world,
            not the operator standing at the console. */}
        <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || !trigger.canFire} onClick={fire}>
          <IconBolt />Fire now
        </Button>
      </div>

      <div className={STACK}>
        {/* The unresolved variable names arrive inside this string: parseError
            keeps only `error` and discards every sibling field. */}
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        {trigger.canFire ? null : <ErrorNotice message={trigger.cannotFireReason ?? "This trigger cannot fire"} />}

        <EndpointCard trigger={trigger} />

        <VariablesCard trigger={trigger} mapping={draft.mapping} defaults={draft.defaults}
          onChange={(next) => setEdits({ ...draft, ...next })} />

        <Card title="Delivery">
          <Field label="Replay window (seconds)" hint="A redelivery with the same X-AgentOS-Delivery-Id — or the same body — inside this window is answered 200 and creates nothing. Empty or 0 disables it.">
            <Input type="number" min={0} max={86400} value={draft.window}
              onChange={(event) => setEdits({ ...draft, window: event.target.value })} />
          </Field>
        </Card>

        <div>
          <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending} onClick={save}>Save changes</Button>
        </div>

        <FiresCard fires={fires.data ?? []} />
      </div>
    </Page>
  );
};
