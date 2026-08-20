import { type ReactNode, useState } from "react";

import { api, apiBase } from "../lib/api";
import { chainMarker } from "../lib/chain";
import { formatT, timeAgo } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
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
  if (trigger.secretDisabled) return { tone: "red", label: formatT("triggers.state.disabledSecret") };
  if (trigger.paused) return { tone: "amber", label: formatT("triggers.state.paused") };
  return { tone: "green", label: formatT("triggers.state.enabled") };
};

/* -------------------------------------------------------------------- list */

export const TriggerRow = ({ trigger, onFire, onTogglePause }: {
  trigger: Trigger;
  onFire: (trigger: Trigger) => void;
  onTogglePause: (trigger: Trigger) => void;
}): ReactNode => {
  const state = triggerState(trigger);
  const t = useT();
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
          ? <span className="text-[color:var(--destructive-fg)]">{t("triggers.target.noRepo", { n: trigger.stepCount })}</span>
          : <span>{t("triggers.target.repo", { repo: trigger.repo.name, n: trigger.stepCount })}</span>}
      </TableCell>
      <TableCell><Pill tone={state.tone}>{state.label}</Pill></TableCell>
      <TableCell>{trigger.lastFiredAt === null ? t("automations.never") : timeAgo(trigger.lastFiredAt)}</TableCell>
      {/* `0` is a fact, not a gap: `—` would read as "unknown". */}
      <TableCell>{trigger.fireCount}</TableCell>
      <TableCell className={TABLE_TIGHT}>
        <RowMenu items={[
          { label: t("triggers.fireNow"), onSelect: () => onFire(trigger) },
          { label: t(trigger.paused ? "triggers.enable" : "triggers.pause"), onSelect: () => onTogglePause(trigger) },
          { label: t("triggers.menu.open"), onSelect: () => navigate(`/triggers/${trigger.id}`) },
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
  const t = useT();
  const triggers = data ?? [];

  const fire = (trigger: Trigger): void => {
    void run(async () => { await api.post(`/task-templates/${trigger.id}/fire`, {}); reload(); });
  };
  const togglePause = (trigger: Trigger): void => {
    void run(async () => { await api.post(`/triggers/${trigger.id}/${trigger.paused ? "enable" : "pause"}`, {}); reload(); });
  };

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <TasksPageHead active="triggers" />
      <div className={STACK}>
        {fatal(error, data) ? <ErrorNotice message={`${error!.status} ${error!.message}`} onRetry={reload} /> : null}
        {actionError === null ? null : <ErrorNotice message={actionError} />}

        {triggers.length === 0 ? (
          <EmptyState>
            <span className="mb-[10px] inline-flex text-[color:var(--faint)]"><IconBolt size={22} /></span>
            <div>{t(loading ? "common.loading" : "triggers.empty.title")}</div>
            <div className={cn(HINT, "mt-[6px]")}>{t("triggers.empty.hint")}</div>
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("triggers.table.name")}</TableHead>
                <TableHead>{t("triggers.table.target")}</TableHead>
                <TableHead>{t("triggers.table.status")}</TableHead>
                <TableHead>{t("triggers.table.lastFired")}</TableHead>
                <TableHead>{t("triggers.table.fires")}</TableHead>
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

/**
 * Absolute URL for the endpoint card's `Copy` button.
 *
 * `apiBase` is always `/api`, which is the Vite dev/preview proxy prefix, not a
 * control-plane path. This card exists to hand an outside system something to
 * POST to, and a relative path is not that — so the base is resolved against the
 * page origin. An absolute base, which the tests still cover, passes through
 * unchanged.
 */
export const endpointUrl = (base: string, path: string, origin: string | null): string => {
  if (origin === null) return `${base}${path}`;
  try {
    return new URL(`${base}${path}`, origin).toString();
  } catch {
    return `${base}${path}`;
  }
};

/** `null` where there is no DOM — the web tests render this card through
 *  `renderToStaticMarkup`, which has no `window`. */
const pageOrigin = (): string | null => (
  typeof window === "undefined" ? null : window.location.origin
);

/** The endpoint card. No secret value is rendered, and none can be: no route
 *  returns one. `secret-value-input.tsx` is deliberately not reused here. */
export const EndpointCard = ({ trigger }: { trigger: TriggerDetail }): ReactNode => {
  // The visible line keeps the short form; the clipboard gets the postable one.
  const shown = `POST ${apiBase}${trigger.endpointPath}`;
  const url = endpointUrl(apiBase, trigger.endpointPath, pageOrigin());
  const t = useT();
  return (
    <Card title={t("triggers.endpoint.title")} extra={
      <Button type="button" variant="legacy" size="legacySmall" className="shadow-none"
        onClick={() => { void navigator.clipboard?.writeText(url); }}>
        {t("triggers.endpoint.copy")}
      </Button>
    }>
      <div className={CODE_BLOCK}>{shown}</div>
      <KeyValue items={[
        { k: t("triggers.endpoint.secretHeader"), v: <code>X-AgentOS-Webhook-Secret</code> },
        { k: t("triggers.endpoint.secret"), v: trigger.secretName ?? "—" },
        { k: t("triggers.endpoint.deliveryHeader"), v: <code>X-AgentOS-Delivery-Id</code> },
      ]} />
    </Card>
  );
};

export const VariablesCard = ({ trigger, mapping, defaults, onChange }: {
  trigger: TriggerDetail;
  mapping: Record<string, string>;
  defaults: Record<string, string>;
  onChange: (next: { mapping: Record<string, string>; defaults: Record<string, string> }) => void;
}): ReactNode => {
  const t = useT();
  return (
    <Card title={t("triggers.variables.title")}>
      {trigger.variables.length === 0
        ? <EmptyState>{t("triggers.variables.empty")}</EmptyState>
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
                      {path === "" && fallback === "" ? <Pill tone="red">{t("triggers.variables.required")}</Pill> : null}
                    </label>
                    <Input type="text" value={path} placeholder="issue.title"
                      onChange={(event) => onChange({ mapping: { ...mapping, [name]: event.target.value }, defaults })} />
                    <div className={HINT}>{t("triggers.variables.pathHint")}</div>
                  </div>
                  <Field label={t("triggers.variables.default")}>
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
};

export const FiresCard = ({ fires }: { fires: TriggerFire[] }): ReactNode => {
  const t = useT();
  return (
    <Card title={t("triggers.fires.title")} flush>
      {fires.length === 0 ? <EmptyState>{t("triggers.fires.empty")}</EmptyState> : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("triggers.fires.when")}</TableHead><TableHead>{t("triggers.fires.source")}</TableHead><TableHead>{t("triggers.fires.chain")}</TableHead><TableHead>{t("triggers.fires.progress")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fires.map((fire) => (
              <TableRow key={fire.id}>
                <TableCell>{timeAgo(fire.createdAt)}</TableCell>
                <TableCell><Pill tone={fire.source === "WEBHOOK" ? "accent" : "grey"}>{t(`triggers.source.${fire.source}`)}</Pill></TableCell>
                <TableCell>
                  {fire.firstTask === null
                    ? <span className="text-muted-foreground">{t("triggers.fires.chainDeleted")}</span>
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
};

/**
 * The detail page's two notice slots, extracted so a test can assert the
 * *wiring* — that the API's `error` string and the trigger's own
 * `cannotFireReason` are what reach the DOM. Constructing an `ErrorNotice` from
 * a literal in a test only proves `ErrorNotice` renders its prop.
 *
 * The unresolved variable names arrive inside `actionError`: `parseError` keeps
 * only the top-level `error` string and discards every sibling field, so the
 * server's prose is the whole contract.
 */
export const TriggerNotices = ({ actionError, trigger }: {
  actionError: string | null;
  trigger: Pick<TriggerDetail, "canFire" | "cannotFireReason">;
}): ReactNode => {
  const t = useT();
  return (
    <>
      {actionError === null ? null : <ErrorNotice message={actionError} />}
      {trigger.canFire ? null : <ErrorNotice message={trigger.cannotFireReason ?? t("triggers.cannotFire")} />}
    </>
  );
};

export const TriggerDetailPage = ({ templateId }: { templateId: string }): ReactNode => {
  const { data: trigger, error, reload } = usePoll<TriggerDetail>(`/triggers/${templateId}`);
  const fires = usePoll<TriggerFire[]>(`/triggers/${templateId}/fires?take=20`);
  const { pending, error: actionError, run } = useAction();
  const t = useT();
  const [edits, setEdits] = useState<{ mapping: Record<string, string>; defaults: Record<string, string>; window: string } | null>(null);

  if (fatal(error, trigger)) {
    return <Page><ErrorNotice message={`${error!.status} ${error!.message}`} onRetry={reload} /></Page>;
  }
  if (!trigger) return <Page><EmptyState>{t("common.loading")}</EmptyState></Page>;

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
        <Pill tone="violet">{t("tasks.pill.template")}</Pill>
        <Pill tone={state.tone}>{state.label}</Pill>
        <span className="flex-1" />
        <Button type="button" variant="legacy" size="legacy" disabled={pending} onClick={togglePause}>
          {t(trigger.paused ? "triggers.enable" : "triggers.pause")}
        </Button>
        {/* Still enabled while paused ([A5]): a pause stops the outside world,
            not the operator standing at the console. */}
        <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || !trigger.canFire} onClick={fire}>
          <IconBolt />{t("triggers.fireNow")}
        </Button>
      </div>

      <div className={STACK}>
        <TriggerNotices actionError={actionError} trigger={trigger} />

        <EndpointCard trigger={trigger} />

        <VariablesCard trigger={trigger} mapping={draft.mapping} defaults={draft.defaults}
          onChange={(next) => setEdits({ ...draft, ...next })} />

        <Card title={t("triggers.delivery.title")}>
          <Field label={t("triggers.delivery.label")} hint={t("triggers.delivery.hint")}>
            <Input type="number" min={0} max={86400} value={draft.window}
              onChange={(event) => setEdits({ ...draft, window: event.target.value })} />
          </Field>
        </Card>

        <div>
          <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending} onClick={save}>{t("triggers.saveChanges")}</Button>
        </div>

        <FiresCard fires={fires.data ?? []} />
      </div>
    </Page>
  );
};
