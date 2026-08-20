import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { formatDate, titleCase } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { useProjectScope } from "../lib/project";
import type { Agent, Secret, SecretPurpose } from "../lib/types";
import { IconPlus } from "../components/icons";
import { SecretValueInput } from "../components/secret-value-input";
import {
  PAGE_ACTIONS, PAGE_HEAD, PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, ROW_WRAP, STACK,
  TABLE_NAME, TABLE_SUB, TABLE_TIGHT, Card, EmptyState, ErrorNotice, Field, Modal, Page, Pill, RowMenu,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

const PURPOSES: SecretPurpose[] = ["ENV", "REPO", "MCP", "WEBHOOK"];

const SecretForm = ({ secret, onClose, onSaved }: {
  secret: Secret | null;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode => {
  const [name, setName] = useState(secret?.name ?? "");
  const [purpose, setPurpose] = useState<SecretPurpose>(secret?.purpose ?? "ENV");
  const [description, setDescription] = useState(secret?.description ?? "");
  const [value, setValue] = useState("");
  const { pending, error, run } = useAction();
  const t = useT();

  const submit = async (): Promise<void> => {
    const ok = await run(() => (secret
      ? api.patch(`/secrets/${secret.id}`, { name, purpose, description, ...(value === "" ? {} : { value }) })
      : api.post("/secrets", { name, purpose, description, value })));
    if (ok) { onSaved(); onClose(); }
  };

  return (
    <Modal title={secret ? t("secrets.form.edit", { name: secret.name }) : t("secrets.form.new")} onClose={onClose} footer={
      <>
        <Button type="button" variant="legacy" size="legacy" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending || name.trim() === "" || (secret === null && value === "")}
          onClick={() => void submit()}>{t("common.save")}</Button>
      </>
    }>
      {error === null ? null : <ErrorNotice message={error} />}
      <Field label={t("secrets.field.name.label")} hint={t("secrets.field.name.hint")}>
        <Input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="GITHUB_PAT_VIBEVILLE" />
      </Field>
      <Field label={t("secrets.field.purpose")}>
        <Select value={purpose} onChange={(event) => setPurpose(event.target.value as SecretPurpose)}>
          {PURPOSES.map((item) => <option key={item} value={item}>{item.toLowerCase()}</option>)}
        </Select>
      </Field>
      <Field label={t("secrets.field.value.label")} hint={t(secret ? "secrets.field.value.hint.edit" : "secrets.field.value.hint.new")}>
        <SecretValueInput value={value} onChange={(event) => setValue(event.target.value)} placeholder={secret ? t("secrets.field.value.unchanged") : ""} />
      </Field>
      <Field label={t("secrets.field.description")}>
        <Input type="text" value={description} onChange={(event) => setDescription(event.target.value)} />
      </Field>
    </Modal>
  );
};

export const SecretsPage = (): ReactNode => {
  const { projectId } = useProjectScope();
  const { data, loading, error, reload } = usePoll<Secret[]>("/secrets", 10_000);
  const { data: agents } = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 30_000);
  const [editing, setEditing] = useState<Secret | null>(null);
  const [creating, setCreating] = useState(false);
  const { error: actionError, run } = useAction();
  const t = useT();
  const secrets = data ?? [];
  const agentName = (id: string): string => (agents ?? []).find((agent) => agent.id === id)?.title ?? id.slice(-6);

  const remove = (secret: Secret): void => {
    if (!window.confirm(t("secrets.confirm.delete", { name: secret.name }))) return;
    void run(async () => { await api.delete(`/secrets/${secret.id}`); reload(); });
  };

  return (
    <Page className="text-foreground">
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("secrets.head.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>{t("secrets.head.subtitle")}</div>
        </div>
        <div className={PAGE_ACTIONS}>
          <Button type="button" variant="legacyPrimary" size="legacy" onClick={() => setCreating(true)}><IconPlus />{t("secrets.new")}</Button>
        </div>
      </div>

      <div className={STACK}>
        {error !== null ? <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /> : null}
        {actionError === null ? null : <ErrorNotice message={actionError} />}

        <Card flush>
          <Table>
            <TableHeader>
              <TableRow><TableHead>{t("secrets.table.name")}</TableHead><TableHead>{t("secrets.table.purpose")}</TableHead><TableHead>{t("secrets.table.grantedTo")}</TableHead><TableHead>{t("secrets.table.rotated")}</TableHead><TableHead>{t("secrets.table.status")}</TableHead><TableHead /></TableRow>
            </TableHeader>
            <TableBody>
              {secrets.map((secret) => (
                <TableRow key={secret.id}>
                  <TableCell className={TABLE_NAME}>{secret.name}{secret.description === null ? null : <span className={TABLE_SUB}>{secret.description}</span>}</TableCell>
                  <TableCell>{titleCase(secret.purpose)}</TableCell>
                  <TableCell>
                    {(secret.agentGrants ?? []).length === 0
                      ? <span className="text-[color:var(--faint)]">—</span>
                      : (
                        <span className={ROW_WRAP}>
                          {(secret.agentGrants ?? []).map((grant) => (
                            <Pill tone="grey" key={`${grant.agentId}:${grant.envVar}`}>
                              {agentName(grant.agentId)} · {grant.envVar}
                            </Pill>
                          ))}
                        </span>
                      )}
                  </TableCell>
                  <TableCell>{formatDate(secret.rotatedAt)}</TableCell>
                  <TableCell>{secret.disabledAt === null ? <Pill tone="green">{t("secrets.state.enabled")}</Pill> : <Pill tone="red">{t("secrets.state.disabled")}</Pill>}</TableCell>
                  <TableCell className={TABLE_TIGHT}>
                    <RowMenu items={[
                      { label: t("common.edit"), onSelect: () => setEditing(secret) },
                      { label: t("common.delete"), danger: true, onSelect: () => remove(secret) },
                    ]} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {secrets.length === 0
            ? <EmptyState>{t(loading ? "common.loading" : "secrets.empty")}</EmptyState>
            : null}
        </Card>

      </div>

      {creating ? <SecretForm secret={null} onClose={() => setCreating(false)} onSaved={reload} /> : null}
      {editing ? <SecretForm secret={editing} onClose={() => setEditing(null)} onSaved={reload} /> : null}
    </Page>
  );
};
