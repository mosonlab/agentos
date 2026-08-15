import type { ReactNode } from "react";

import { formatDate } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import { Link } from "../lib/router";
import type { Agent, MCPConnection, Repo } from "../lib/types";
import { Card, EmptyState, ErrorNotice, Pill } from "../components/ui";

export const ConnectionsPage = (): ReactNode => {
  const { projectId, project } = useProjectScope();
  const connections = usePoll<MCPConnection[]>(projectId === "" ? null : `/projects/${projectId}/mcp-connections`, 10_000);
  const { data: agents } = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 30_000);
  const { data: repos } = usePoll<Repo[]>(projectId === "" ? null : `/projects/${projectId}/repos`, 30_000);
  const list = connections.data ?? [];
  const agentName = (id: string): string => (agents ?? []).find((agent) => agent.id === id)?.title ?? id.slice(-6);

  if (projectId === "") return <div className="page"><EmptyState>Select a project first.</EmptyState></div>;

  return (
    <div className="page">
      <div className="pageHead">
        <div className="titles">
          <h1>Connections</h1>
          <div className="subtitle">MCP servers and repos available to agents in {project?.name ?? "this project"}</div>
        </div>
      </div>

      <div className="stack">
        {connections.missing ? (
          <div className="notice gap">
            控制面尚无 <code>GET /projects/:projectId/mcp-connections</code>（MCPConnection / AgentMCPConnection 表已存在，
            但 API 未暴露）。MCP 列表按空渲染；下方 Repos 用真实端点。
          </div>
        ) : null}
        {connections.error !== null && !connections.missing
          ? <ErrorNotice message={`${connections.error.status} ${connections.error.message}`} onRetry={connections.reload} />
          : null}

        <Card title="MCP Connections" extra={<span className="count">{list.length}</span>} flush>
          <div className="tableWrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Transport</th><th>Operations</th><th>Bound agents</th><th>Updated</th></tr></thead>
              <tbody>
                {list.map((connection) => (
                  <tr key={connection.id}>
                    <td className="name">{connection.name}
                      {connection.credentialSecretId === null ? null : <span className="sub">credential {connection.credentialSecretId.slice(-6)}</span>}
                    </td>
                    <td>{connection.transport}</td>
                    <td>{connection.allowedOperations.length === 0 ? "—" : connection.allowedOperations.join(", ")}</td>
                    <td>
                      {(connection.agents ?? []).length === 0
                        ? <span className="faint">—</span>
                        : (
                          <span className="rowWrap">
                            {(connection.agents ?? []).map((binding) => (
                              <Link key={binding.agentId} to={`/agents/${binding.agentId}`} className="pill grey">{agentName(binding.agentId)}</Link>
                            ))}
                          </span>
                        )}
                    </td>
                    <td>{formatDate(connection.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.length === 0 ? <EmptyState>No MCP connections.</EmptyState> : null}
          </div>
        </Card>

        <Card title="Repos" extra={<span className="count">{(repos ?? []).length}</span>} flush>
          <div className="tableWrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Remote</th><th>Credential</th><th>Default branch</th><th>Updated</th></tr></thead>
              <tbody>
                {(repos ?? []).map((repo) => (
                  <tr key={repo.id}>
                    <td className="name">{repo.name}<span className="sub">mounted at {repo.mountPath}</span></td>
                    <td>{repo.remoteUrl}</td>
                    <td>{repo.credentialSecretId === null ? <Pill tone="grey">ambient git login</Pill> : repo.credentialSecretId.slice(-6)}</td>
                    <td>{repo.defaultBranch}</td>
                    <td>{formatDate(repo.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(repos ?? []).length === 0 ? <EmptyState>No repos in this project.</EmptyState> : null}
          </div>
        </Card>

        <Card title="Per-agent bindings">
          <div className="hint">
            绑定表 <code>AgentMCPConnection(agentId, mcpConnectionId)</code> 与 <code>AgentRepoAccess</code>。
            仓库授权可在 Agent 详情 → Capabilities 写入（<code>POST /agents/:agentId/repos/:repoId/access</code>）；
            MCP 绑定端点尚未提供。
          </div>
        </Card>
      </div>
    </div>
  );
};
