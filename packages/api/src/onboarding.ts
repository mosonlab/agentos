/**
 * OSS-B0 Step 4: the one transactional first-run installation.
 *
 * A fresh Anneal has to reach a usable state without the operator calling five
 * REST routes in the right order. Chaining those creates from the browser was
 * rejected in the plan (Fixed Decision 1) for one reason: a failure halfway
 * through leaves a half-seeded control plane and hands recovery judgement to
 * someone who installed the product ten seconds ago. So the whole installation
 * is one serializable transaction here — it either exists completely or not at
 * all — and the route family is exactly two: `GET /onboarding` reports whether
 * an installation exists, `POST /onboarding` creates it once.
 *
 * What it creates is fixed, not configurable (plan Fixed Decisions 3 and 4):
 *
 *   1 Project, 1 Environment (`OPEN`, no allowed hosts), 1 Agent (the canonical
 *   CODEX `default` starter, read from `agents/` through @anneal/db so no model
 *   or prompt is duplicated here), 1 Repo with no credential secret, and 1
 *   `GIT_WRITE` `AgentRepoAccess`.
 *
 * and equally fixed is what it must never create: no Secret, no FilesystemGrant,
 * no MCP binding, no collaborator, no second Agent, no template. `db:seed` — the
 * internal multi-role installation — is not part of any public install path.
 *
 * The `OPEN` Environment is honesty, not a shortcut. No runtime reads
 * `Environment.networking` or `allowedHosts`, Codex is started with
 * `--dangerously-bypass-approvals-and-sandbox`, and a FilesystemGrant is an
 * audit boundary rather than isolation between processes of the same user. An
 * installation that recorded `LIMITED` would be claiming containment that does
 * not exist, so this module cannot produce one.
 */
import {
  NetworkingMode,
  Prisma,
  type PrismaClient,
  RepoPermission,
  type RunnerPreference,
  STARTER_MOUNT_PATH,
  type StarterAgentSource,
  loadStarterAgentSource,
} from "@anneal/db";
import { z } from "zod";

import { isValidBranchName } from "./branch-name.js";

export { isValidBranchName } from "./branch-name.js";

/** The Environment every first-run installation gets. Named, not chosen: the
 *  wizard discloses what this Environment is, and a name field would invite a
 *  fresh user to believe the name selects a policy. */
export const STARTER_ENVIRONMENT_NAME = "local";
/** The stable machine-readable reason a second install attempt is refused. The
 *  browser routes on this string, so it is part of the contract. */
export const EXISTING_INSTALLATION = "existing-installation";

const MAX_REMOTE_LENGTH = 2048;

export type RemoteRejection =
  | "control-characters"
  | "whitespace"
  | "query-or-fragment"
  | "embedded-credentials"
  | "unsupported-scheme"
  | "unsupported-ssh-account"
  | "option-like"
  | "missing-host"
  | "missing-path"
  | "too-long";

export type RemoteVerdict = { ok: true; remoteUrl: string } | { ok: false; reason: RemoteRejection };

// Scanned rather than matched: a control-character class is itself a lint
// violation (biome's noControlCharactersInRegex), and the loop states the range
// once for both the remote and the branch check.
const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};
const WHITESPACE = /\s/u;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u;
// scp-like Git syntax: `[user@]host:path`. The user charset deliberately has no
// `:` in it, so `user:password@host:path` cannot match this shape at all — it
// falls through to `unsupported-scheme` rather than being read as a host.
const SCP_LIKE = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9._-]+):(.+)$/u;

/**
 * The only SSH account a first-run remote may name.
 *
 * A token pasted where a login belongs is still a token in `Repo.remoteUrl`,
 * in the session manifest and in `git remote -v`, whether or not SSH would ever
 * authenticate with it — and `ghp_…@github.com:owner/name.git` is structurally
 * indistinguishable from a login name, so no charset or length rule separates
 * the two. Every Git host's SSH endpoint is reached as `git@…`, so the accept
 * set is that one name and a remote with no user at all. A self-hosted account
 * under a different name is still reachable through the ordinary Repo route,
 * which is an operator action rather than a first-run one; what onboarding
 * refuses is the shape that can persist a credential.
 */
const SSH_ACCOUNT = "git";

/**
 * Whether a Git remote may be stored, and why not when it may not.
 *
 * The rule is that a remote is a location, never a credential. Every rejected
 * shape below is one that carries authentication material into a database
 * column, a session manifest, a `git remote -v`, and eventually a log line:
 * userinfo (`https://token@host/...`, `https://user:pass@host/...`), a query or
 * fragment (`?access_token=`, `#token`), and control characters or whitespace,
 * which are how a second argument gets smuggled into a command line. Credentials
 * belong in a Secret the operator creates deliberately, after onboarding.
 *
 * `file://` is allowed because the documented disposable rehearsal clones from a
 * local bare repository; it carries no credential by construction.
 */
export const parseRepoRemote = (raw: string): RemoteVerdict => {
  // The raw string, never a trimmed copy: a leading newline or a trailing tab is
  // exactly the shape that smuggles a second argument onto a command line, and
  // sanitising it here would silently accept what the contract says to refuse.
  const value = raw;
  if (value.length > MAX_REMOTE_LENGTH) return { ok: false, reason: "too-long" };
  if (hasControlCharacter(value)) return { ok: false, reason: "control-characters" };
  if (WHITESPACE.test(value)) return { ok: false, reason: "whitespace" };
  if (value.includes("?") || value.includes("#")) return { ok: false, reason: "query-or-fragment" };
  // `git clone -- <remote>` is not what the runner spells, so a remote that
  // begins with a dash is a command-line option wearing a location's clothes
  // (`-oProxyCommand=...:x` parses as host `-oProxyCommand` under the scp-like
  // shape below).
  if (value.startsWith("-")) return { ok: false, reason: "option-like" };

  const scheme = SCHEME.exec(value)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    const scp = SCP_LIKE.exec(value);
    if (!scp) return { ok: false, reason: "unsupported-scheme" };
    if (scp[1] !== undefined && scp[1] !== SSH_ACCOUNT) return { ok: false, reason: "unsupported-ssh-account" };
    if (!scp[2]) return { ok: false, reason: "missing-host" };
    if (!scp[3]) return { ok: false, reason: "missing-path" };
    return { ok: true, remoteUrl: value };
  }
  if (scheme === "file") {
    // Exactly three slashes: `file://host/path` would name another machine, and
    // the rehearsal remote is always a path on this one.
    if (!value.startsWith("file:///")) return { ok: false, reason: "missing-host" };
    if (value.length === "file:///".length) return { ok: false, reason: "missing-path" };
    return { ok: true, remoteUrl: value };
  }
  if (scheme !== "https" && scheme !== "ssh") return { ok: false, reason: "unsupported-scheme" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "unsupported-scheme" };
  }
  if (url.password.length > 0) return { ok: false, reason: "embedded-credentials" };
  // `https://anything@host/...` is how every provider spells a token, so https
  // carries no user at all; `ssh://` carries only the one account name above.
  if (scheme === "https" && url.username.length > 0) return { ok: false, reason: "embedded-credentials" };
  if (scheme === "ssh" && url.username.length > 0 && url.username !== SSH_ACCOUNT) {
    return { ok: false, reason: "unsupported-ssh-account" };
  }
  if (url.hostname.length === 0) return { ok: false, reason: "missing-host" };
  if (url.pathname.length <= 1) return { ok: false, reason: "missing-path" };
  return { ok: true, remoteUrl: value };
};

/**
 * Plan Step 4 fixes the created shape down to one mount, so `STARTER_MOUNT_PATH`
 * (@anneal/db, shared with the verifier) is a constant rather than a validated
 * input: an installation that mounted the starter repo somewhere else would
 * satisfy every count the verifier makes and still not be the shape the release
 * evidence describes. The request may still carry `mountPath`, because the
 * wizard round-trips what it displays, but any value other than this one is
 * refused rather than quietly rewritten.
 */
export const isStarterMountPath = (value: string): boolean => value === STARTER_MOUNT_PATH;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** The same derivation `apps/web/src/pages/Projects.tsx` applies to its slug
 *  field, so the wizard and the API agree on what a typed name becomes. */
export const slugify = (value: string): string =>
  value.toLowerCase().trim().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");

export const onboardingInput = z.object({
  project: z.object({
    name: z.string().trim().min(1).max(120),
    // Optional: a fresh user types a name, and an empty slug field is derived
    // rather than refused. A supplied slug is still validated, never rewritten.
    slug: z.string().trim().min(1).max(60).optional(),
  }),
  repo: z.object({
    name: z.string().trim().min(1).max(120),
    // Not `.trim()`: `parseRepoRemote` judges the string the operator actually
    // sent, and trimming here would hide a leading newline from it.
    remoteUrl: z.string().min(1).max(MAX_REMOTE_LENGTH),
    defaultBranch: z.string().trim().min(1).max(255).default("main"),
    mountPath: z.string().trim().min(1).max(255).default(STARTER_MOUNT_PATH),
  }),
  /** The wizard's disclosure checkbox, enforced here and not only in the browser:
   *  the one thing a first-run operator must have been told is that the starter
   *  runs Codex with their own user's authority and no application sandbox. A
   *  client that skips the screen cannot skip the acknowledgement. */
  acknowledgedHostExecution: z.boolean(),
}).superRefine((value, context) => {
  const slug = value.project.slug ?? slugify(value.project.name);
  if (!SLUG.test(slug)) {
    context.addIssue({
      code: "custom",
      path: ["project", "slug"],
      message: "Project slug must be lowercase alphanumeric words separated by single hyphens",
    });
  }
  const remote = parseRepoRemote(value.repo.remoteUrl);
  if (!remote.ok) {
    context.addIssue({
      code: "custom",
      path: ["repo", "remoteUrl"],
      // The reason, never the value: an error body is evidence, and a rejected
      // remote is exactly the string most likely to contain a token.
      message: `Repo remote rejected: ${remote.reason}`,
    });
  }
  if (!isValidBranchName(value.repo.defaultBranch)) {
    context.addIssue({ code: "custom", path: ["repo", "defaultBranch"], message: "Default branch is not a valid Git branch name" });
  }
  if (!isStarterMountPath(value.repo.mountPath)) {
    context.addIssue({
      code: "custom",
      path: ["repo", "mountPath"],
      message: `A first-run installation mounts the repo at "${STARTER_MOUNT_PATH}"`,
    });
  }
  if (!value.acknowledgedHostExecution) {
    context.addIssue({
      code: "custom",
      path: ["acknowledgedHostExecution"],
      message: "The host-execution disclosure must be acknowledged",
    });
  }
});

export type OnboardingInput = z.infer<typeof onboardingInput>;

/** Public identities only. No prompt, no remote URL, no token, no internal
 *  column: everything here is safe in a browser, a log, and release evidence. */
export interface OnboardingInstallation {
  complete: true;
  project: { id: string; name: string; slug: string };
  environment: { id: string; name: string; networking: NetworkingMode; allowedHosts: string[] };
  agent: { id: string; name: string; title: string; model: string; runnerPreference: RunnerPreference };
  repo: { id: string; name: string; defaultBranch: string; mountPath: string };
  access: { agentId: string; repoId: string; permissions: RepoPermission; mountPath: string };
}

export interface OnboardingStatus {
  complete: boolean;
  project: { id: string; name: string; slug: string } | null;
  /** `null` when this process cannot read `agents/`. Never a reason to withhold
   *  `complete`, which is derived from the Project row alone. */
  starter: { name: string; title: string; model: string; runnerPreference: RunnerPreference } | null;
  disclosure: StarterDisclosure;
}

/**
 * What the confirmation screen must say, as facts rather than prose, so the
 * wizard cannot soften them into a claim the runtime does not honour. Every
 * value is a statement about this build's actual behaviour.
 */
export interface StarterDisclosure {
  environmentNetworking: "OPEN";
  filesystemGrantCreated: false;
  repoPermission: "GIT_WRITE";
  codexSandbox: "none";
  runsWithHostUserAuthority: true;
  /** A statement about the supported v0.1 deployment, not about what this
   *  process binds to: the transport boundary itself is Step 2's, and saying
   *  "loopbackOnly: true" here would read as an enforcement claim this module
   *  does not make. */
  supportedScope: "loopback-only";
  embeddedRemoteCredentialsRejected: true;
}

export const STARTER_DISCLOSURE: StarterDisclosure = {
  environmentNetworking: "OPEN",
  filesystemGrantCreated: false,
  repoPermission: "GIT_WRITE",
  codexSandbox: "none",
  runsWithHostUserAuthority: true,
  supportedScope: "loopback-only",
  embeddedRemoteCredentialsRejected: true,
};

const starterSummary = (source: StarterAgentSource): OnboardingStatus["starter"] => ({
  name: source.name,
  title: source.title,
  model: source.model,
  runnerPreference: source.runnerPreference,
});

/**
 * Whether this installation is already done.
 *
 * Completion is derived from durable rows, never from a flag (Fixed Decision 2):
 * a lost `POST` response is recovered by asking again, and an operator who
 * already has a Project — an internal seed, a restored backup, an earlier
 * install — is complete by definition and must never be re-seeded. The oldest
 * Project is the one reported, so repeated calls answer identically.
 */
export const onboardingStatus = async (
  db: PrismaClient,
  /** Injectable so a test can prove the paragraph above: completion survives a
   *  starter source this process cannot read. */
  loadStarter: () => Promise<StarterAgentSource> = loadStarterAgentSource,
): Promise<OnboardingStatus> => {
  const project = await db.project.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, slug: true },
  });
  // The starter preview is what the wizard renders before an installation
  // exists; it is not what decides whether one exists. An `agents/` directory
  // that a repackaged or half-upgraded install cannot read must not turn a
  // committed installation into a 500 — that would be exactly the lost-response
  // case the plan requires to be recoverable.
  let starter: OnboardingStatus["starter"] = null;
  try {
    starter = starterSummary(await loadStarter());
  } catch {
    starter = null;
  }
  return { complete: project !== null, project, starter, disclosure: STARTER_DISCLOSURE };
};

export type CreateStarterResult =
  | { ok: true; installation: OnboardingInstallation }
  | { ok: false; code: typeof EXISTING_INSTALLATION };

class ExistingInstallationError extends Error {}

/**
 * A concurrent second installation, whatever shape PostgreSQL reported it in.
 *
 * Two callers that both observe an empty database inside SERIALIZABLE
 * transactions cannot both commit: the loser is aborted with 40001, which Prisma
 * surfaces as P2034. A slower pair can instead collide on `Project.slug`
 * (P2002). Both mean the same thing to the caller — someone else installed
 * first — so both become the same stable 409 rather than a 500 that invites a
 * retry loop.
 */
const isConcurrentInstallation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2002");

/**
 * Create the entire starter installation, or nothing.
 *
 * The starter source is read before the transaction opens on purpose: it is
 * filesystem I/O against `agents/`, and holding a SERIALIZABLE transaction open
 * across it would widen the window in which a concurrent installer is aborted
 * for a conflict that has nothing to do with the database.
 */
export const createStarterInstallation = async (
  db: PrismaClient,
  input: OnboardingInput,
): Promise<CreateStarterResult> => {
  const starter = await loadStarterAgentSource();
  const slug = input.project.slug ?? slugify(input.project.name);
  const remote = parseRepoRemote(input.repo.remoteUrl);
  if (!remote.ok) throw new Error(`Repo remote rejected: ${remote.reason}`);
  try {
    const installation = await db.$transaction(async (tx) => {
      // The precondition and every create share one snapshot: at SERIALIZABLE
      // this count is a predicate the database re-checks at commit, so "no
      // Project existed" is true of the committed state, not merely of the
      // moment it was read.
      if (await tx.project.count() > 0) throw new ExistingInstallationError();
      const project = await tx.project.create({
        data: { name: input.project.name, slug, yamlDocument: "" },
        select: { id: true, name: true, slug: true },
      });
      const environment = await tx.environment.create({
        data: {
          projectId: project.id,
          name: STARTER_ENVIRONMENT_NAME,
          networking: NetworkingMode.OPEN,
          allowedHosts: [],
        },
        select: { id: true, name: true, networking: true, allowedHosts: true },
      });
      const agent = await tx.agent.create({
        data: {
          projectId: project.id,
          environmentId: environment.id,
          name: starter.name,
          title: starter.title,
          model: starter.model,
          runnerPreference: starter.runnerPreference,
          inboxAccess: starter.inboxAccess,
          foundationalPrompt: starter.foundationalPrompt,
          rolePrompt: starter.rolePrompt,
          // Empty is the column default and the honest value: Codex enforces
          // none of the per-tool flags (apps/web/src/lib/tools.ts), so a denied
          // set here would be a claim this build cannot keep.
          disabledTools: [],
        },
        select: { id: true, name: true, title: true, model: true, runnerPreference: true },
      });
      const repo = await tx.repo.create({
        data: {
          projectId: project.id,
          name: input.repo.name,
          remoteUrl: remote.remoteUrl,
          defaultBranch: input.repo.defaultBranch,
          // The constant, not the request: validation already refuses any other
          // value, and reading it from the input would leave the fixed install
          // shape depending on a caller that reached this function directly.
          mountPath: STARTER_MOUNT_PATH,
          credentialSecretId: null,
        },
        select: { id: true, name: true, defaultBranch: true, mountPath: true },
      });
      const access = await tx.agentRepoAccess.create({
        data: {
          agentId: agent.id,
          repoId: repo.id,
          projectId: project.id,
          permissions: RepoPermission.GIT_WRITE,
          mountPath: STARTER_MOUNT_PATH,
        },
        select: { agentId: true, repoId: true, permissions: true, mountPath: true },
      });
      return { complete: true, project, environment, agent, repo, access } satisfies OnboardingInstallation;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { ok: true, installation };
  } catch (error: unknown) {
    if (error instanceof ExistingInstallationError || isConcurrentInstallation(error)) {
      return { ok: false, code: EXISTING_INSTALLATION };
    }
    throw error;
  }
};
