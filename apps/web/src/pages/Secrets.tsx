import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { formatDate, titleCase } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import type { Agent, Secret, SecretPurpose } from "../lib/types";
import { IconPlus } from "../components/icons";
import { Card, EmptyState, ErrorNotice, Field, Modal, Pill, RowMenu } from "../components/ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
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

  const submit = async (): Promise<void> => {
    const ok = await run(() => (secret
      ? api.patch(`/secrets/${secret.id}`, { name, purpose, description, ...(value === "" ? {} : { value }) })
      : api.post("/secrets", { name, purpose, description, value })));
    if (ok) { onSaved(); onClose(); }
  };

  return (
    <Modal title={secret ? `Edit ${secret.name}` : "New secret"} onClose={onClose} footer={
      <>
        <Button type="button" className="btn" onClick={onClose}>Cancel</Button>
        <Button type="button" className="btn primary" disabled={pending || name.trim() === "" || (secret === null && value === "")}
          onClick={() => void submit()}>Save</Button>
      </>
    }>
      {error === null ? null : <ErrorNotice message={error} />}
      <Field label="Name" hint="Referenced by repos, MCP connections and agent grants.">
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="GITHUB_PAT_VIBEVILLE" />
      </Field>
      <Field label="Purpose">
        <select value={purpose} onChange={(event) => setPurpose(event.target.value as SecretPurpose)}>
          {PURPOSES.map((item) => <option key={item} value={item}>{item.toLowerCase()}</option>)}
        </select>
      </Field>
      <Field label="Value" hint={secret
        ? "Leave empty to keep the stored ciphertext. Values are AES-256-GCM encrypted at rest."
        : "Encrypted with AGENTOS_SECRET_ENCRYPTION_KEY before it reaches the database."}>
        <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder={secret ? "unchanged" : ""} />
      </Field>
      <Field label="Description">
        <Input value={description} onChange={(event) => setDescription(event.target.value)} />
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
  const secrets = data ?? [];
  const agentName = (id: string): string => (agents ?? []).find((agent) => agent.id === id)?.title ?? id.slice(-6);

  const remove = (secret: Secret): void => {
    if (!window.confirm(`Delete secret ${secret.name}? Repos and agents referencing it lose the value.`)) return;
    void run(async () => { await api.delete(`/secrets/${secret.id}`); reload(); });
  };

  return (
    <div className="page text-foreground">
      <div className="pageHead">
        <div className="titles">
          <h1>Secrets</h1>
          <div className="subtitle">One shared library; runners inject granted values as environment variables (DECISIONS #9)</div>
        </div>
        <div className="pageActions">
          <Button type="button" className="btn primary" onClick={() => setCreating(true)}><IconPlus />New Secret</Button>
        </div>
      </div>

      <div className="stack">
        {error !== null ? <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /> : null}
        {actionError === null ? null : <ErrorNotice message={actionError} />}

        <Card flush>
          <div className="tableWrap">
            <Table className="table">
              <TableHeader>
                <TableRow><TableHead>Name</TableHead><TableHead>Purpose</TableHead><TableHead>Granted to</TableHead><TableHead>Rotated</TableHead><TableHead>Status</TableHead><TableHead /></TableRow>
              </TableHeader>
              <TableBody>
                {secrets.map((secret) => (
                  <TableRow key={secret.id}>
                    <TableCell className="name">{secret.name}{secret.description === null ? null : <span className="sub">{secret.description}</span>}</TableCell>
                    <TableCell>{titleCase(secret.purpose)}</TableCell>
                    <TableCell>
                      {(secret.agentGrants ?? []).length === 0
                        ? <span className="faint">—</span>
                        : (
                          <span className="rowWrap">
                            {(secret.agentGrants ?? []).map((grant) => (
                              <span className="pill grey" key={`${grant.agentId}:${grant.envVar}`}>
                                {agentName(grant.agentId)} · {grant.envVar}
                              </span>
                            ))}
                          </span>
                        )}
                    </TableCell>
                    <TableCell>{formatDate(secret.rotatedAt)}</TableCell>
                    <TableCell>{secret.disabledAt === null ? <Pill tone="green">Enabled</Pill> : <Pill tone="red">Disabled</Pill>}</TableCell>
                    <TableCell className="tight">
                      <RowMenu items={[
                        { label: "Edit", onSelect: () => setEditing(secret) },
                        { label: "Delete", danger: true, onSelect: () => remove(secret) },
                      ]} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {secrets.length === 0
              ? <EmptyState>{loading ? "Loading…" : "No secrets stored."}</EmptyState>
              : null}
          </div>
        </Card>

      </div>

      {creating ? <SecretForm secret={null} onClose={() => setCreating(false)} onSaved={reload} /> : null}
      {editing ? <SecretForm secret={editing} onClose={() => setEditing(null)} onSaved={reload} /> : null}
    </div>
  );
};
