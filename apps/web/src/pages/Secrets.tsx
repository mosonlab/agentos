import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { formatDate, titleCase } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import type { Agent, Secret, SecretPurpose } from "../lib/types";
import { IconPlus } from "../components/icons";
import { Card, EmptyState, ErrorNotice, Field, Modal, Pill, RowMenu } from "../components/ui";

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
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={pending || name.trim() === "" || (secret === null && value === "")}
          onClick={() => void submit()}>Save</button>
      </>
    }>
      {error === null ? null : <ErrorNotice message={error} />}
      <Field label="Name" hint="Referenced by repos, MCP connections and agent grants.">
        <input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="GITHUB_PAT_VIBEVILLE" />
      </Field>
      <Field label="Purpose">
        <select value={purpose} onChange={(event) => setPurpose(event.target.value as SecretPurpose)}>
          {PURPOSES.map((item) => <option key={item} value={item}>{item.toLowerCase()}</option>)}
        </select>
      </Field>
      <Field label="Value" hint={secret
        ? "Leave empty to keep the stored ciphertext. Values are AES-256-GCM encrypted at rest."
        : "Encrypted with AGENTOS_SECRET_ENCRYPTION_KEY before it reaches the database."}>
        <input type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder={secret ? "unchanged" : ""} />
      </Field>
      <Field label="Description">
        <input type="text" value={description} onChange={(event) => setDescription(event.target.value)} />
      </Field>
    </Modal>
  );
};

export const SecretsPage = (): ReactNode => {
  const { projectId } = useProjectScope();
  const { data, loading, error, missing, reload } = usePoll<Secret[]>("/secrets", 10_000);
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
    <div className="page">
      <div className="pageHead">
        <div className="titles">
          <h1>Secrets</h1>
          <div className="subtitle">One shared library; runners inject granted values as environment variables (DECISIONS #9)</div>
        </div>
        <div className="pageActions">
          <button type="button" className="btn primary" disabled={missing} onClick={() => setCreating(true)}><IconPlus />New Secret</button>
        </div>
      </div>

      <div className="stack">
        {missing ? (
          <div className="notice gap">
            控制面尚无 <code>/secrets</code> CRUD 端点（Secret 表与加解密已在 <code>packages/api/src/secrets.ts</code>，
            但只在 runner 领取任务时内部使用）。本页按空库渲染，端点上线后自动显示。
          </div>
        ) : null}
        {error !== null && !missing ? <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /> : null}
        {actionError === null ? null : <ErrorNotice message={actionError} />}

        <Card flush>
          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Purpose</th><th>Granted to</th><th>Rotated</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {secrets.map((secret) => (
                  <tr key={secret.id}>
                    <td className="name">{secret.name}{secret.description === null ? null : <span className="sub">{secret.description}</span>}</td>
                    <td>{titleCase(secret.purpose)}</td>
                    <td>
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
                    </td>
                    <td>{formatDate(secret.rotatedAt)}</td>
                    <td>{secret.disabledAt === null ? <Pill tone="green">Enabled</Pill> : <Pill tone="red">Disabled</Pill>}</td>
                    <td className="tight">
                      <RowMenu items={[
                        { label: "Edit", onSelect: () => setEditing(secret) },
                        { label: "Delete", danger: true, onSelect: () => remove(secret) },
                      ]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {secrets.length === 0
              ? <EmptyState>{loading && !missing ? "Loading…" : "No secrets stored."}</EmptyState>
              : null}
          </div>
        </Card>

        <Card title="Per-agent grants">
          <div className="hint">
            授权关系存在 <code>AgentSecretGrant(agentId, secretId, envVar)</code>；控制面尚无读写端点，
            上表的 “Granted to” 列在 <code>GET /secrets</code> 带 <code>agentGrants</code> 时自动填充。
          </div>
        </Card>
      </div>

      {creating ? <SecretForm secret={null} onClose={() => setCreating(false)} onSaved={reload} /> : null}
      {editing ? <SecretForm secret={editing} onClose={() => setEditing(null)} onSaved={reload} /> : null}
    </div>
  );
};
