import type { ReactNode } from "react";

import { formatDate } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import { Link } from "../lib/router";
import { cn } from "../lib/utils";
import type { Agent, MCPConnection, Repo } from "../lib/types";
import {
  COUNT, PAGE_HEAD, PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, ROW_WRAP, STACK,
  TABLE_NAME, TABLE_SUB, Card, EmptyState, ErrorNotice, Page, Pill,
} from "../components/ui";
import { badgeVariants } from "../components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

/** Hoisted out of the JSX attribute on purpose: R-2's checker reads every string
 *  literal inside a `className={...}` expression, so an inline
 *  `badgeVariants({ shape: "pill", tone: "grey" })` reports two legacy tokens for
 *  a file that has none. Computing it once is also one less cva call per row. */
const AGENT_PILL = cn(badgeVariants({ variant: "outline", shape: "pill", tone: "grey" }));

export const ConnectionsPage = (): ReactNode => {
  const { projectId, project } = useProjectScope();
  const connections = usePoll<MCPConnection[]>(projectId === "" ? null : `/projects/${projectId}/mcp-connections`, 10_000);
  const { data: agents } = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 30_000);
  const { data: repos } = usePoll<Repo[]>(projectId === "" ? null : `/projects/${projectId}/repos`, 30_000);
  const list = connections.data ?? [];
  const agentName = (id: string): string => (agents ?? []).find((agent) => agent.id === id)?.title ?? id.slice(-6);

  if (projectId === "") return <Page><EmptyState>Select a project first.</EmptyState></Page>;

  return (
    <Page>
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>Connections</h1>
          <div className={PAGE_HEAD_SUBTITLE}>MCP servers and repos available to agents in {project?.name ?? "this project"}</div>
        </div>
      </div>

      <div className={STACK}>
        {connections.error !== null
          ? <ErrorNotice message={`${connections.error.status} ${connections.error.message}`} onRetry={connections.reload} />
          : null}

        <Card title="MCP Connections" extra={<span className={COUNT}>{list.length}</span>} flush>
          {/* The `.tableWrap` div is gone: `Table` brings its own
              `relative w-full overflow-auto` wrapper, and `<Card flush>` adds no
              padding, so `EmptyState` sits beside the table without moving. */}
          <Table className="leading-normal">
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Transport</TableHead><TableHead>Operations</TableHead><TableHead>Bound agents</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader>
            <TableBody>
              {list.map((connection) => (
                <TableRow key={connection.id}>
                  <TableCell className={TABLE_NAME}>{connection.name}
                    {connection.credentialSecretId === null ? null : <span className={TABLE_SUB}>credential {connection.credentialSecretId.slice(-6)}</span>}
                  </TableCell>
                  <TableCell>{connection.transport}</TableCell>
                  <TableCell>{connection.allowedOperations.length === 0 ? "—" : connection.allowedOperations.join(", ")}</TableCell>
                  <TableCell>
                    {(connection.agents ?? []).length === 0
                      ? <span className="text-[color:var(--faint)]">—</span>
                      : (
                        <span className={ROW_WRAP}>
                          {(connection.agents ?? []).map((binding) => (
                            <Link key={binding.agentId} to={`/agents/${binding.agentId}`} className={AGENT_PILL}>{agentName(binding.agentId)}</Link>
                          ))}
                        </span>
                      )}
                  </TableCell>
                  <TableCell>{formatDate(connection.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {list.length === 0 ? <EmptyState>No MCP connections.</EmptyState> : null}
        </Card>

        <Card title="Repos" extra={<span className={COUNT}>{(repos ?? []).length}</span>} flush>
          <Table className="leading-normal">
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Remote</TableHead><TableHead>Credential</TableHead><TableHead>Default branch</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader>
            <TableBody>
              {(repos ?? []).map((repo) => (
                <TableRow key={repo.id}>
                  <TableCell className={TABLE_NAME}>{repo.name}<span className={TABLE_SUB}>mounted at {repo.mountPath}</span></TableCell>
                  <TableCell>{repo.remoteUrl}</TableCell>
                  <TableCell>{repo.credentialSecretId === null ? <Pill tone="grey">ambient git login</Pill> : repo.credentialSecretId.slice(-6)}</TableCell>
                  <TableCell>{repo.defaultBranch}</TableCell>
                  <TableCell>{formatDate(repo.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {(repos ?? []).length === 0 ? <EmptyState>No repos in this project.</EmptyState> : null}
        </Card>

        <Card title="Per-agent bindings">
          <div>
            绑定表 <code>AgentMCPConnection(agentId, mcpConnectionId)</code> 与 <code>AgentRepoAccess</code>。
            仓库授权可在 Agent 详情 → Capabilities 写入（<code>POST /agents/:agentId/repos/:repoId/access</code>）；
            MCP 绑定可在 Agent 详情 → Capabilities 中管理。
          </div>
        </Card>
      </div>
    </Page>
  );
};
