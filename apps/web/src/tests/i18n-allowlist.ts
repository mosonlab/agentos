export type I18nAllowlistEntry = {
  file: string;
  text: string;
  why: string;
};

/**
 * Source strings that are identifiers or third-party names, not interface copy.
 * Keep this list bounded: adding an entry is an explicit review decision.
 */
export const I18N_ALLOWLIST: I18nAllowlistEntry[] = [
  { file: "pages/Agents.tsx", text: "senior-dev", why: "Role slug example" },
  { file: "pages/Agents.tsx", text: "claude", why: "CLI identifier example" },
  { file: "pages/Agents.tsx", text: "cuid", why: "Identifier format example" },
  { file: "pages/Agents.tsx", text: "git-read", why: "Repository permission identifier" },
  { file: "pages/Agents.tsx", text: "git-write", why: "Repository permission identifier" },
  { file: "pages/Agents.tsx", text: "/absolute/path", why: "Filesystem path example" },
  { file: "pages/Automations.tsx", text: "Asia/Shanghai", why: "IANA timezone example" },
  { file: "pages/Connections.tsx", text: "AgentMCPConnection(agentId, mcpConnectionId)", why: "Database relation identifier" },
  { file: "pages/Connections.tsx", text: "AgentRepoAccess", why: "Database model identifier" },
  { file: "pages/Connections.tsx", text: "POST /agents/:agentId/repos/:repoId/access", why: "HTTP endpoint identifier" },
  { file: "pages/Goals.tsx", text: "/path/to/shared/folder", why: "Filesystem path example" },
  { file: "pages/Inbox.tsx", text: "GET /inbox/messages", why: "HTTP endpoint identifier" },
  { file: "pages/Projects.tsx", text: "mmo-game", why: "Project slug example" },
  { file: "pages/Secrets.tsx", text: "GITHUB_PAT_VIBEVILLE", why: "Environment variable example" },
  { file: "pages/TaskDetail.tsx", text: "base → head", why: "Git comparison notation" },
  { file: "pages/Triggers.tsx", text: "X-AgentOS-Webhook-Secret", why: "HTTP header identifier" },
  { file: "pages/Triggers.tsx", text: "X-AgentOS-Delivery-Id", why: "HTTP header identifier" },
  { file: "pages/Triggers.tsx", text: "issue.title", why: "Payload path example" },
  { file: "components/new-task-panel.tsx", text: "feat/…", why: "Git branch example" },
  { file: "components/startup-gate.tsx", text: ".env", why: "Configuration file name" },
  { file: "components/startup-gate.tsx", text: "npm run setup:local", why: "Shell command identifier" },
  { file: "components/startup-gate.tsx", text: "npm run dev:web", why: "Shell command identifier" },
  { file: "components/startup-gate.tsx", text: "npm run dev:api", why: "Shell command identifier" },
  { file: "lib/models.ts", text: "Claude Fable 5", why: "Model product name" },
  { file: "lib/models.ts", text: "Claude Opus 5", why: "Model product name" },
  { file: "lib/models.ts", text: "Claude Sonnet 5", why: "Model product name" },
  { file: "lib/models.ts", text: "Claude Haiku 4.5", why: "Model product name" },
  { file: "lib/models.ts", text: "GPT-5.6 Sol (codex)", why: "Model product name" },
  { file: "lib/models.ts", text: "GPT-5.6 Luna (codex)", why: "Model product name" },
  { file: "lib/models.ts", text: "GPT-5.6 Luna (pi)", why: "Model product name" },
];
