/**
 * OSS-B0 Step 4 first-run installation verifier — idempotent, read-only, exits
 * non-zero on any violation.
 *
 * It answers one question about the database `DATABASE_URL` names: does it hold
 * exactly the installation `POST /onboarding` is allowed to create, and nothing
 * else? That is the evidence-matrix row E9, and it is deliberately checkable
 * from outside the API process, on a clean host, without reading the API's own
 * source.
 *
 * It prints counts and statuses only — never a prompt, a remote URL, a secret,
 * or a row id — so its output can be pasted into release evidence.
 *
 *   DATABASE_URL=...?schema=... npm run db:verify-starter-onboarding
 *
 * The typed logic lives here rather than in `prisma/`, because `prisma/` is
 * outside the package's compiled boundary; `prisma/verify-starter-onboarding.ts`
 * is the thin entrypoint that owns only the client and the disconnect.
 */
import { NetworkingMode, type PrismaClient, RepoPermission, RunnerPreference } from "@prisma/client";

import { loadStarterAgentSource } from "./agent-sources.js";

/**
 * The mount a first-run installation uses, for the Repo and for its one
 * `AgentRepoAccess` alike (plan Step 4 fixes the created shape down to this
 * literal). It lives in @anneal/db so the API that writes it and the verifier
 * that checks it cannot drift apart; that the literal is `repo` and not
 * something else is asserted against the plain string in
 * `packages/api/src/onboarding.dbtest.ts`, which installs through the API and
 * verifies through this module.
 */
export const STARTER_MOUNT_PATH = "repo";

export interface StarterOnboardingCounts {
  project: number;
  environment: number;
  agent: number;
  repo: number;
  agentRepoAccess: number;
  secret: number;
  environmentSecret: number;
  agentSecretGrant: number;
  filesystemGrant: number;
  mcpConnection: number;
  agentMcpConnection: number;
  skill: number;
  agentSkill: number;
  agentCollaboration: number;
  taskTemplate: number;
}

export interface StarterOnboardingReport {
  counts: StarterOnboardingCounts;
  /** Present only when exactly one Agent exists, so a violation never depends on
   *  which of several rows happened to be read first. */
  starter: { runnerPreference: RunnerPreference; model: string } | null;
  environment: { networking: NetworkingMode; allowedHosts: number } | null;
  repo: { credential: "none" | "present" } | null;
  access: { permissions: RepoPermission; mountPath: string } | null;
  violations: string[];
}

/** The row counts that must be exactly one, and the ones that must be zero.
 *  Written as data so the printed report and the pass condition cannot disagree
 *  about which is which. */
const REQUIRED_ONE = ["project", "environment", "agent", "repo", "agentRepoAccess"] as const;
const REQUIRED_ZERO = [
  "secret",
  "environmentSecret",
  "agentSecretGrant",
  "filesystemGrant",
  "mcpConnection",
  "agentMcpConnection",
  "skill",
  "agentSkill",
  "agentCollaboration",
  "taskTemplate",
] as const;

export const verifyStarterOnboarding = async (db: PrismaClient): Promise<StarterOnboardingReport> => {
  const violations: string[] = [];
  const counts: StarterOnboardingCounts = {
    project: await db.project.count(),
    environment: await db.environment.count(),
    agent: await db.agent.count(),
    repo: await db.repo.count(),
    agentRepoAccess: await db.agentRepoAccess.count(),
    secret: await db.secret.count(),
    environmentSecret: await db.environmentSecret.count(),
    agentSecretGrant: await db.agentSecretGrant.count(),
    filesystemGrant: await db.filesystemGrant.count(),
    mcpConnection: await db.mCPConnection.count(),
    agentMcpConnection: await db.agentMCPConnection.count(),
    skill: await db.skill.count(),
    agentSkill: await db.agentSkill.count(),
    agentCollaboration: await db.agentCollaboration.count(),
    taskTemplate: await db.taskTemplate.count(),
  };
  for (const key of REQUIRED_ONE) {
    if (counts[key] !== 1) violations.push(`${key}-count-${counts[key]}-expected-1`);
  }
  for (const key of REQUIRED_ZERO) {
    if (counts[key] !== 0) violations.push(`${key}-count-${counts[key]}-expected-0`);
  }

  const project = counts.project === 1 ? await db.project.findFirst() : null;
  const environmentRow = counts.environment === 1 ? await db.environment.findFirst() : null;
  const agentRow = counts.agent === 1 ? await db.agent.findFirst() : null;
  const repoRow = counts.repo === 1 ? await db.repo.findFirst() : null;
  const accessRow = counts.agentRepoAccess === 1 ? await db.agentRepoAccess.findFirst() : null;

  let starter: StarterOnboardingReport["starter"] = null;
  if (agentRow) {
    starter = { runnerPreference: agentRow.runnerPreference, model: agentRow.model };
    if (agentRow.runnerPreference !== RunnerPreference.CODEX) {
      violations.push(`starter-runner-${agentRow.runnerPreference}-expected-CODEX`);
    }
    try {
      const source = await loadStarterAgentSource();
      if (agentRow.model !== source.model) violations.push("starter-model-differs-from-agents-contract");
      if (agentRow.name !== source.name) violations.push("starter-name-differs-from-agents-contract");
      if (agentRow.foundationalPrompt !== source.foundationalPrompt) violations.push("starter-foundational-prompt-differs-from-agents-contract");
      if (agentRow.rolePrompt !== source.rolePrompt) violations.push("starter-role-prompt-differs-from-agents-contract");
    } catch {
      // A checkout without a readable `agents/` cannot prove parity, and an
      // unproven claim is a violation here rather than a silent skip.
      violations.push("starter-source-unreadable");
    }
  }

  let environment: StarterOnboardingReport["environment"] = null;
  if (environmentRow) {
    environment = { networking: environmentRow.networking, allowedHosts: environmentRow.allowedHosts.length };
    // Honesty, not containment (plan Fixed Decision 3): no runtime enforces
    // LIMITED for Codex, so an installation that recorded LIMITED would be
    // claiming an isolation it does not have.
    if (environmentRow.networking !== NetworkingMode.OPEN) violations.push(`environment-networking-${environmentRow.networking}-expected-OPEN`);
    if (environmentRow.allowedHosts.length !== 0) violations.push("environment-allowed-hosts-not-empty");
  }

  let repo: StarterOnboardingReport["repo"] = null;
  if (repoRow) {
    repo = { credential: repoRow.credentialSecretId === null ? "none" : "present" };
    if (repoRow.credentialSecretId !== null) violations.push("repo-credential-secret-present");
  }

  let access: StarterOnboardingReport["access"] = null;
  if (accessRow) {
    access = { permissions: accessRow.permissions, mountPath: accessRow.mountPath };
    if (accessRow.permissions !== RepoPermission.GIT_WRITE) violations.push(`access-permissions-${accessRow.permissions}-expected-GIT_WRITE`);
    // The literal, not merely agreement with the Repo: plan Step 4 fixes the
    // created shape down to this mount, and two rows that agree on the wrong
    // value are still not the installation the release evidence describes.
    if (accessRow.mountPath !== STARTER_MOUNT_PATH) violations.push(`access-mount-path-${accessRow.mountPath}-expected-${STARTER_MOUNT_PATH}`);
    if (repoRow && repoRow.mountPath !== accessRow.mountPath) violations.push("repo-mount-path-differs-from-access");
    if (agentRow && accessRow.agentId !== agentRow.id) violations.push("access-names-another-agent");
    if (repoRow && accessRow.repoId !== repoRow.id) violations.push("access-names-another-repo");
  }

  // Cross-project impossibility: every row of the installation belongs to the
  // one Project. The composite foreign keys already make a cross-project grant
  // unrepresentable; this states the same thing about the data on disk, so a
  // future schema relaxation cannot pass silently.
  if (project) {
    for (const [label, owned] of [
      ["environment", environmentRow],
      ["agent", agentRow],
      ["repo", repoRow],
      ["access", accessRow],
    ] as const) {
      if (owned && owned.projectId !== project.id) violations.push(`${label}-belongs-to-another-project`);
    }
    if (agentRow && environmentRow && agentRow.environmentId !== environmentRow.id) {
      violations.push("agent-uses-another-environment");
    }
  }

  return { counts, starter, environment, repo, access, violations };
};

export const formatStarterOnboardingReport = (report: StarterOnboardingReport): string[] => {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(report.counts)) lines.push(`starter-onboarding count ${key} ${value}`);
  lines.push(`starter-onboarding starter ${report.starter ? `${report.starter.runnerPreference} ${report.starter.model}` : "absent"}`);
  lines.push(`starter-onboarding environment ${report.environment ? `${report.environment.networking} allowedHosts=${report.environment.allowedHosts}` : "absent"}`);
  lines.push(`starter-onboarding repo-credential ${report.repo ? report.repo.credential : "absent"}`);
  lines.push(`starter-onboarding access ${report.access ? `${report.access.permissions} mountPath=${report.access.mountPath}` : "absent"}`);
  return lines;
};

/** `DATABASE_URL` must name its schema explicitly: the control plane's own
 *  migrations are schema-qualified, and a verifier that silently fell back to
 *  `public` would report on a database nobody asked about. */
export const resolveVerifierDatabaseUrl = (
  environment: NodeJS.ProcessEnv,
): { url: string } | { error: string } => {
  const raw = environment.DATABASE_URL;
  if (!raw) return { error: "DATABASE_URL is required" };
  let schema: string | null;
  try {
    schema = new URL(raw).searchParams.get("schema");
  } catch {
    return { error: "DATABASE_URL is not a URL" };
  }
  if (!schema) return { error: "DATABASE_URL must name the target schema explicitly (?schema=...)" };
  return { url: raw };
};

export const runVerifyStarterOnboardingCli = async (options: {
  db: PrismaClient;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): Promise<number> => {
  const log = options.log ?? ((message: string) => { console.log(message); });
  const error = options.error ?? ((message: string) => { console.error(message); });
  let report: StarterOnboardingReport;
  try {
    report = await verifyStarterOnboarding(options.db);
  } catch {
    // The code, never the exception text: a Prisma or filesystem message carries
    // the database host, the schema, an absolute path or driver diagnostics, and
    // this output is pasted into release evidence. Diagnose an unreadable target
    // with the tools that are allowed to name it.
    error("STOP starter-onboarding verify-failed");
    return 1;
  }
  for (const line of formatStarterOnboardingReport(report)) log(line);
  if (report.violations.length === 0) {
    log("starter-onboarding PASS");
    return 0;
  }
  for (const violation of report.violations) error(`STOP starter-onboarding ${violation}`);
  log(`starter-onboarding STOP (${report.violations.length} violation(s))`);
  return 1;
};
