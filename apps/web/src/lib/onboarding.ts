/**
 * The first-run installation contract, as the browser has to know it.
 *
 * The control plane is authoritative: `POST /onboarding` re-validates every
 * field and refuses the whole transaction on anything it does not like. This
 * module exists so the wizard can say *why* a value is wrong beside the field
 * that holds it, instead of turning a typo into a 400 that a first-time user has
 * to interpret — and so a remote carrying a credential is never sent at all.
 *
 * The two copies cannot be allowed to drift into disagreement, so the accepted
 * and rejected shapes live in `scripts/fixtures/onboarding-remote-cases.json`
 * and are asserted against this function *and* against the server's parser.
 */

/** The mount a first-run installation uses, fixed by the control plane. The
 *  wizard displays it and round-trips it; it is not an input. */
export const STARTER_MOUNT_PATH = "repo";

export const MAX_REMOTE_LENGTH = 2048;

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

// Scanned rather than matched, for the same reason as the server's copy: a
// control-character class inside a regex is itself a lint violation.
const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const WHITESPACE = /\s/u;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u;
/** scp-like Git syntax, `[user@]host:path`. The user charset carries no `:`, so
 *  `user:password@host:path` cannot match this shape at all. */
const SCP_LIKE = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9._-]+):(.+)$/u;

/** The only SSH account a first-run remote may name: a token pasted where a
 *  login belongs is indistinguishable from a login, and every Git host's SSH
 *  endpoint answers to this one name. */
const SSH_ACCOUNT = "git";

/**
 * Why this remote may not be stored, or `null` when it may.
 *
 * A remote is a location, never a credential. Userinfo, a query or fragment,
 * whitespace and control characters are all shapes that carry authentication
 * material — or a second command-line argument — into a database column, a
 * session manifest and every log line that quotes it.
 */
export const remoteRejection = (raw: string): RemoteRejection | null => {
  // The raw string, never a trimmed copy: a leading newline is exactly what the
  // contract refuses, and trimming it here would send it anyway.
  const value = raw;
  if (value.length > MAX_REMOTE_LENGTH) return "too-long";
  if (hasControlCharacter(value)) return "control-characters";
  if (WHITESPACE.test(value)) return "whitespace";
  if (value.includes("?") || value.includes("#")) return "query-or-fragment";
  if (value.startsWith("-")) return "option-like";

  const scheme = SCHEME.exec(value)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    const scp = SCP_LIKE.exec(value);
    if (!scp) return "unsupported-scheme";
    if (scp[1] !== undefined && scp[1] !== SSH_ACCOUNT) return "unsupported-ssh-account";
    if (!scp[2]) return "missing-host";
    if (!scp[3]) return "missing-path";
    return null;
  }
  if (scheme === "file") {
    if (!value.startsWith("file:///")) return "missing-host";
    if (value.length === "file:///".length) return "missing-path";
    return null;
  }
  if (scheme !== "https" && scheme !== "ssh") return "unsupported-scheme";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "unsupported-scheme";
  }
  if (url.password.length > 0) return "embedded-credentials";
  if (scheme === "https" && url.username.length > 0) return "embedded-credentials";
  if (scheme === "ssh" && url.username.length > 0 && url.username !== SSH_ACCOUNT) return "unsupported-ssh-account";
  if (url.hostname.length === 0) return "missing-host";
  if (url.pathname.length <= 1) return "missing-path";
  return null;
};

const BRANCH_FORBIDDEN = /[\s~^:?*[\\]/u;

/** `git check-ref-format --branch`, for the subset a wizard can produce. */
export const isValidBranchName = (value: string): boolean => {
  if (value.length === 0 || value.length > 255) return false;
  if (hasControlCharacter(value) || BRANCH_FORBIDDEN.test(value)) return false;
  if (value.startsWith("-") || value.endsWith(".")) return false;
  if (value.includes("..") || value.includes("@{")) return false;
  return value.split("/").every((segment) => (
    segment.length > 0 && !segment.startsWith(".") && !segment.endsWith(".lock")
  ));
};

/** The one derivation a typed project name goes through, shared by the wizard
 *  and the Projects form so both produce the slug the control plane accepts. */
export const slugify = (value: string): string =>
  value.toLowerCase().trim().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const isValidSlug = (value: string): boolean => value.length <= 60 && SLUG.test(value);
