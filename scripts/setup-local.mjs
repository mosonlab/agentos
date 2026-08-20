#!/usr/bin/env node
// `npm run setup:local` — generate this checkout's local configuration once, or
// say why it will not.
//
// Three properties are the point of the file, and every design choice below
// serves one of them:
//
//   1. **Output uses a stable, value-free vocabulary.** The create command
//      emits one class line. Upgrade adds `changed` and `remaining` lines that
//      contain key names and reason/action codes only. stderr stays empty, and
//      no configuration value reaches terminal scrollback, logs, or screenshots.
//   2. **Fresh publication is atomic and no-clobber.** The bytes are written to a
//      same-directory temporary file and then published with `link(2)`, which
//      fails `EEXIST` rather than replacing. `rename(2)` is never the final
//      primitive: rename succeeds over an existing target, so two concurrent
//      writers would both report success and one configuration would silently
//      lose. Upgrade is different: it retains every existing assignment, checks
//      that the source bytes are unchanged, then atomically renames a durable
//      replacement containing only missing generated keys.
//   3. **It fails closed.** An unsupported Node, an unreadable directory, a
//      filesystem without directory `fsync` or `link`, or an unsafe `.env` type
//      or mode each stops before writing. Upgrade repairs only missing generated
//      keys; weak, placeholder, inconsistent, or malformed existing values are
//      reported for human recovery and never replaced.
//
// The helpers are pure and exported so the tests can prove those properties
// without a live checkout. `randomBytes`, the filesystem, and the
// pre-publication hook are injectable for the same reason — the CLI itself
// always passes the real ones.

import { randomBytes as cryptoRandomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The narrowest range shared by the locked toolchain. Root
 *  `package.json` `engines.node` and the published prerequisite carry this
 *  exact string; `setup-local.test.mjs` compares all three for equality. */
export const SUPPORTED_NODE_RANGE = "^20.19.0 || ^22.13.0 || >=24";

/** Every class this command can emit. Output is one of these and nothing else,
 *  so callers and documentation can match on a fixed vocabulary. */
export const SETUP_CLASSES = Object.freeze({
  created: "configuration-created",
  valid: "configuration-valid",
  raced: "configuration-raced",
  invalid: "configuration-invalid",
  unsupportedNode: "configuration-unsupported-node",
  unsupportedFilesystem: "configuration-unsupported-filesystem",
  entropyUnusable: "configuration-entropy-unusable",
  upgraded: "configuration-upgraded",
  upgradedNeedsAction: "configuration-upgraded-needs-action",
  upgradeNeedsAction: "configuration-upgrade-needs-action",
  usage: "configuration-usage-error",
});

/** Exit codes are as stable as the classes; scripts branch on them. */
export const EXIT_CODES = Object.freeze({
  [SETUP_CLASSES.created]: 0,
  [SETUP_CLASSES.valid]: 0,
  [SETUP_CLASSES.invalid]: 1,
  [SETUP_CLASSES.unsupportedNode]: 2,
  [SETUP_CLASSES.raced]: 3,
  [SETUP_CLASSES.unsupportedFilesystem]: 4,
  [SETUP_CLASSES.entropyUnusable]: 5,
  [SETUP_CLASSES.upgraded]: 0,
  [SETUP_CLASSES.upgradedNeedsAction]: 1,
  [SETUP_CLASSES.upgradeNeedsAction]: 1,
  [SETUP_CLASSES.usage]: 64,
});

export const CONFIG_FILE_NAME = ".env";

/** The mode `.env` is created with and the only mode it is accepted at. A
 *  group- or world-readable file holding two bearer tokens and an encryption
 *  key is not a usable configuration, whatever its contents say. */
export const CONFIG_FILE_MODE = 0o600;

/** Every temporary file this command creates begins with this. The complete
 *  bytes of an unpublished `.env` live under this prefix for as long as it
 *  takes to `fsync` and `link` them, so a `SIGKILL`, a crash, or a power cut
 *  between the write and the link can leave one behind. `.gitignore` covers
 *  the whole namespace, and `setup-local.test.mjs` proves it against a real
 *  interrupted run: nothing else stops `git add -A` from committing a full set
 *  of generated credentials. Nothing here reclaims a stray file — this
 *  invocation cannot tell a live concurrent writer's temporary file from a
 *  dead one's, and deleting the wrong one would corrupt a run in flight. */
export const TEMPORARY_PREFIX = ".env.setup-local.";

/** Values that mean "not configured yet" wherever they appear. A file carrying
 *  one is refused rather than treated as a working configuration. */
const SENTINEL_VALUES = new Set(["", "CHANGE_ME", "CHANGEME", "TODO", "PLACEHOLDER", "REPLACE_ME", "changeme"]);

/** Additionally refused where the key holds a secret. `agentos` is a perfectly
 *  good database name and a hopeless database password. */
const WEAK_SECRET_VALUES = new Set([...SENTINEL_VALUES, "secret", "password", "postgres", "agentos"]);

const SHORTEST_ACCEPTABLE_SECRET = 24;

/** Keys a local checkout cannot start without. Optional integrations (Feishu,
 *  the merge executor, GitHub reads) stay empty by design and are not listed. */
export const REQUIRED_KEYS = Object.freeze([
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "DATABASE_URL",
  "API_HOST",
  "API_PORT",
  "RUNNER_ID",
  "OPERATOR_TOKEN",
  "RUNNER_TOKEN",
  "SESSION_COOKIE_SECRET",
  "AGENTOS_SECRET_ENCRYPTION_KEY",
]);

const SECRET_KEYS = Object.freeze([
  "POSTGRES_PASSWORD",
  "OPERATOR_TOKEN",
  "RUNNER_TOKEN",
  "SESSION_COOKIE_SECRET",
  "AGENTOS_SECRET_ENCRYPTION_KEY",
]);

/** Missing values that can be generated without guessing the identity or
 * credentials of an existing PostgreSQL installation. Existing assignments,
 * including weak ones, are never replaced by upgrade. */
export const UPGRADE_GENERATED_KEYS = Object.freeze([
  "RUNNER_ID",
  "OPERATOR_TOKEN",
  "RUNNER_TOKEN",
  "SESSION_COOKIE_SECRET",
  "AGENTOS_SECRET_ENCRYPTION_KEY",
]);

export const DATABASE_DEFAULTS = Object.freeze({
  user: "agentos",
  database: "agentos",
  host: "127.0.0.1",
  port: 5432,
  schema: "public",
});

/** A setup failure that already knows its stable class. */
export class SetupError extends Error {
  constructor(setupClass, reason) {
    super(`${setupClass}${reason ? `: ${reason}` : ""}`);
    this.name = "SetupError";
    this.setupClass = setupClass;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Node version predicate
// ---------------------------------------------------------------------------

export function parseSemanticVersion(text) {
  if (typeof text !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].slice(1) : null,
  };
}

/** `^20.19.0 || ^22.13.0 || >=24`, spelled out rather than resolved by a dependency:
 *  the check has to run before `npm install` has necessarily succeeded, so it
 *  cannot import semver. A prerelease is refused — fail closed rather than
 *  guess that a nightly behaves like its release. */
export function isSupportedNodeVersion(version) {
  const parsed = parseSemanticVersion(version);
  if (!parsed || parsed.prerelease !== null) return false;
  if (parsed.major === 20) return parsed.minor >= 19;
  if (parsed.major === 22) return parsed.minor >= 13;
  return parsed.major >= 24;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** base64url has no `@`, `:`, `/`, `?`, `#`, `[`, `]` or `%`, so a password in
 *  this alphabet survives `DATABASE_URL` without percent-encoding — and the
 *  same literal can go straight into Docker Compose's `POSTGRES_PASSWORD`. */
function urlSafeSecret(randomBytes, byteLength) {
  return randomBytes(byteLength).toString("base64url");
}

function base64Secret(randomBytes, byteLength) {
  return randomBytes(byteLength).toString("base64");
}

/** Built through `URL` rather than by interpolating a connection-string
 *  template: the structure does the escaping, and no credential-shaped literal
 *  has to exist in a file that is published. */
export function composeDatabaseUrl({
  user = DATABASE_DEFAULTS.user,
  password,
  host = DATABASE_DEFAULTS.host,
  port = DATABASE_DEFAULTS.port,
  database = DATABASE_DEFAULTS.database,
  schema = DATABASE_DEFAULTS.schema,
}) {
  const url = new URL(`postgresql://${host}:${port}`);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  url.searchParams.set("schema", schema);
  return url.href;
}

/** The whole set, generated together so distinctness can be asserted here
 *  rather than hoped for by every caller. */
export function generateConfiguration(randomBytes = cryptoRandomBytes) {
  const databasePassword = urlSafeSecret(randomBytes, 24);
  const values = {
    postgresDatabase: DATABASE_DEFAULTS.database,
    postgresUser: DATABASE_DEFAULTS.user,
    databasePassword,
    databaseUrl: composeDatabaseUrl({ password: databasePassword }),
    // Stable once published, opaque, and safe in filenames and logs. It is an
    // identity, not a credential, but a random suffix avoids hostname reuse.
    runnerId: `runner-${urlSafeSecret(randomBytes, 12)}`,
    // Bearer tokens: 32 bytes, URL-safe so they survive a header, a shell
    // variable and a `.env` line without quoting.
    operatorToken: urlSafeSecret(randomBytes, 32),
    runnerToken: urlSafeSecret(randomBytes, 32),
    sessionCookieSecret: base64Secret(randomBytes, 32),
    // `packages/api/src/secrets.ts` requires base64 that decodes to exactly 32
    // bytes; anything else fails at the first Secret a Run touches.
    secretEncryptionKey: base64Secret(randomBytes, 32),
  };

  const secrets = [
    values.databasePassword,
    values.operatorToken,
    values.runnerToken,
    values.sessionCookieSecret,
    values.secretEncryptionKey,
  ];
  if (new Set(secrets).size !== secrets.length) {
    // Two identical draws out of `randomBytes` are not a value to warn about
    // and continue with — the API's own rule is that the principals differ.
    throw new SetupError(SETUP_CLASSES.entropyUnusable, "generated-values-not-distinct");
  }
  return values;
}

/** The published bytes. Comments are part of the file; values never are. */
export function renderEnvFile(values) {
  return `# AgentOS local configuration, generated by \`npm run setup:local\`.
#
# Mode 0600, git-ignored, and never printed. This file is the only copy of these
# values. There is no overwrite or rotation flag: regenerating is a deliberate
# human recovery that preserves the existing file and establishes an empty
# target first. Rotating AGENTOS_SECRET_ENCRYPTION_KEY while encrypted Secret
# rows exist destroys them; docs/release/v0.1.0-security.md says what survives.

# PostgreSQL started by docker-compose.yml. Compose reads POSTGRES_PASSWORD from
# this same file, so the literal below and the one inside DATABASE_URL are one
# generated value.
POSTGRES_DB=${values.postgresDatabase}
POSTGRES_USER=${values.postgresUser}
POSTGRES_PASSWORD=${values.databasePassword}
# The target schema is named explicitly. The release preflight refuses a
# DATABASE_URL that does not say which schema it is about.
DATABASE_URL=${values.databaseUrl}

# Control-plane API, loopback only.
API_HOST=127.0.0.1
API_PORT=3000
# Distinct principals by construction: the runner never holds operator authority.
OPERATOR_TOKEN=${values.operatorToken}
RUNNER_TOKEN=${values.runnerToken}
SESSION_COOKIE_SECRET=${values.sessionCookieSecret}
# 32 random bytes, base64. Stays outside the database and the runner environment.
AGENTOS_SECRET_ENCRYPTION_KEY=${values.secretEncryptionKey}

# The web dev/preview server proxies to the API and attaches the operator token
# in its own process. No token is compiled into or stored by the browser, so
# this file deliberately carries no VITE_* credential of any kind.
WEB_API_URL=http://127.0.0.1:3000

# Local runner process: runner principal only.
RUNNER_API_URL=http://127.0.0.1:3000
RUNNER_ID=${values.runnerId}
CLAUDE_BINARY=claude
CODEX_BINARY=codex
PI_BINARY=pi
`;
}

// ---------------------------------------------------------------------------
// Validation of an existing file
// ---------------------------------------------------------------------------

export function parseEnvAssignments(text) {
  const assignments = new Map();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const value = line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    assignments.set(key, value);
  }
  return assignments;
}

function decodedByteLength(value, encoding) {
  try {
    return Buffer.from(value, encoding).length;
  } catch {
    return -1;
  }
}

function isPlaceholder(key, value) {
  const weak = SECRET_KEYS.includes(key) ? WEAK_SECRET_VALUES : SENTINEL_VALUES;
  return weak.has(value);
}

/** Answers one question — is this file safe to keep and use? — and answers it
 *  in reason codes and key names. No reason ever carries a value, because the
 *  reasons are printed. */
export function validateEnvContent(text) {
  const reasons = [];
  const assignments = parseEnvAssignments(text);

  for (const key of REQUIRED_KEYS) {
    if (!assignments.has(key)) reasons.push(`missing-key:${key}`);
    else if (isPlaceholder(key, assignments.get(key))) reasons.push(`placeholder-value:${key}`);
  }

  for (const key of SECRET_KEYS) {
    const value = assignments.get(key);
    if (value === undefined || isPlaceholder(key, value)) continue;
    if (value.length < SHORTEST_ACCEPTABLE_SECRET) reasons.push(`secret-too-short:${key}`);
  }

  for (const key of assignments.keys()) {
    // A token the bundler can inline is a token in the browser, whatever its
    // value is. The supported path keeps the operator token in the dev/preview
    // server process instead.
    if (/^VITE_.*TOKEN/.test(key)) reasons.push(`browser-exposed-token:${key}`);
  }

  const operator = assignments.get("OPERATOR_TOKEN");
  const runner = assignments.get("RUNNER_TOKEN");
  if (operator !== undefined && operator === runner) reasons.push("operator-runner-token-identical");

  const encryptionKey = assignments.get("AGENTOS_SECRET_ENCRYPTION_KEY");
  if (encryptionKey !== undefined && !isPlaceholder("AGENTOS_SECRET_ENCRYPTION_KEY", encryptionKey)) {
    if (decodedByteLength(encryptionKey, "base64") !== 32) {
      reasons.push("encryption-key-not-32-bytes:AGENTOS_SECRET_ENCRYPTION_KEY");
    }
  }

  const databaseUrl = assignments.get("DATABASE_URL");
  if (databaseUrl !== undefined && !isPlaceholder("DATABASE_URL", databaseUrl)) {
    let parsed = null;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      reasons.push("database-url-unparsable:DATABASE_URL");
    }
    if (parsed) {
      // Same mechanism as packages/db/prisma/preflight-goal-execution.ts: an
      // operator who has not named the schema has not named the target.
      if (!parsed.searchParams.get("schema")) reasons.push("database-url-missing-schema:DATABASE_URL");
      if (WEAK_SECRET_VALUES.has(decodeURIComponent(parsed.password))) {
        reasons.push("database-url-weak-password:DATABASE_URL");
      }
      const postgresPassword = assignments.get("POSTGRES_PASSWORD");
      if (
        postgresPassword !== undefined &&
        !isPlaceholder("POSTGRES_PASSWORD", postgresPassword) &&
        decodeURIComponent(parsed.password) !== postgresPassword
      ) {
        reasons.push("database-password-mismatch:DATABASE_URL");
      }
    }
  }

  return { valid: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

const nodeFileSystem = Object.freeze({
  lstatSync,
  openSync,
  writeSync,
  fchmodSync,
  fsyncSync,
  closeSync,
  linkSync,
  unlinkSync,
  readFileSync,
  renameSync,
});

function generateUpgradeAdditions(assignments, randomBytes) {
  const additions = new Map();
  for (const key of UPGRADE_GENERATED_KEYS) {
    if (assignments.has(key)) continue;
    const value = key === "RUNNER_ID"
      ? `runner-${urlSafeSecret(randomBytes, 12)}`
      : key === "SESSION_COOKIE_SECRET" || key === "AGENTOS_SECRET_ENCRYPTION_KEY"
        ? base64Secret(randomBytes, 32)
        : urlSafeSecret(randomBytes, 32);
    additions.set(key, value);
  }
  const existingSecrets = SECRET_KEYS.flatMap((key) => assignments.has(key) ? [assignments.get(key)] : []);
  const combined = [...existingSecrets, ...additions.values()];
  if (new Set(combined).size !== combined.length) {
    throw new SetupError(SETUP_CLASSES.entropyUnusable, "generated-values-not-distinct");
  }
  return additions;
}

function renderUpgrade(existing, additions) {
  if (additions.size === 0) return existing;
  const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
  const lines = [
    "",
    "# Added by `npm run setup:local -- --upgrade`; existing values were preserved.",
    ...[...additions].map(([key, value]) => `${key}=${value}`),
    "",
  ];
  return `${prefix}${lines.join("\n")}`;
}

function upgradeActions(reasons) {
  const actions = reasons.map((reason) => {
    const [kind, key] = reason.split(":", 2);
    if (kind === "missing-key") return `add:${key}`;
    if (kind === "placeholder-value" || kind === "secret-too-short") {
      if (key === "POSTGRES_PASSWORD") return "rotate:POSTGRES_PASSWORD+DATABASE_URL";
      if (key === "AGENTOS_SECRET_ENCRYPTION_KEY") return `recover-or-rotate:${key}`;
      return SECRET_KEYS.includes(key) ? `rotate:${key}` : `replace:${key}`;
    }
    if (kind === "encryption-key-not-32-bytes") return `recover-or-rotate:${key}`;
    if (kind === "database-url-weak-password") return "rotate:POSTGRES_PASSWORD+DATABASE_URL";
    if (kind === "database-password-mismatch") return "align:POSTGRES_PASSWORD+DATABASE_URL";
    if (kind === "database-url-missing-schema") return `add-schema:${key}`;
    if (kind === "database-url-unparsable") return `repair:${key}`;
    if (kind === "browser-exposed-token") return `remove:${key}`;
    if (reason === "operator-runner-token-identical") return "rotate:OPERATOR_TOKEN+RUNNER_TOKEN";
    return `fix:${reason}`;
  });
  return [...new Set(actions)];
}

/** Atomically replace a validated mode-0600 file after proving its bytes have
 * not changed since inspection. The temporary file is durable before rename;
 * the directory entry is durable before success is reported. */
function replaceConfiguration({ directory, fileName, expectedContents, contents, fs = nodeFileSystem }) {
  const target = join(directory, fileName);
  const temporaryPath = join(directory, `${TEMPORARY_PREFIX}${process.pid}.${cryptoRandomBytes(6).toString("hex")}.upgrade.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    writeAll(fs, fd, Buffer.from(contents, "utf8"));
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const current = inspectExisting(fs, target);
    if (current === null || current.reason !== undefined || current.contents !== expectedContents) {
      throw new SetupError(SETUP_CLASSES.raced, "configuration-changed-during-upgrade");
    }
    fs.renameSync(temporaryPath, target);
    const directoryFd = fs.openSync(directory, fsConstants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* the primary failure governs */ }
    }
    try { fs.unlinkSync(temporaryPath); } catch { /* renamed or already absent */ }
    if (error instanceof SetupError) throw error;
    throw new SetupError(SETUP_CLASSES.unsupportedFilesystem, `upgrade-publication-failed:${errorCode(error) ?? "unknown"}`);
  }
}

function errorCode(error) {
  return error && typeof error === "object" ? error.code : undefined;
}

/** Prove the directory can be `fsync`ed *before* anything is generated. A
 *  filesystem that cannot make a directory entry durable cannot publish this
 *  file safely, and finding that out after the link is too late to undo. */
export function assertDurableDirectory(directory, fs = nodeFileSystem) {
  let directoryFd;
  try {
    directoryFd = fs.openSync(directory, fsConstants.O_RDONLY);
    fs.fsyncSync(directoryFd);
  } catch (error) {
    if (directoryFd !== undefined) {
      try {
        fs.closeSync(directoryFd);
      } catch {
        /* the probe already failed; the close cannot make it worse */
      }
    }
    throw new SetupError(SETUP_CLASSES.unsupportedFilesystem, `directory-fsync-unsupported:${errorCode(error) ?? "unknown"}`);
  }
  fs.closeSync(directoryFd);
}

function writeAll(fs, fd, buffer) {
  let written = 0;
  while (written < buffer.length) {
    written += fs.writeSync(fd, buffer, written, buffer.length - written);
  }
}

/**
 * Write `contents` to a same-directory temporary file and publish it under
 * `fileName` with `link(2)`.
 *
 * `beforePublish` runs after the temporary file is complete and durable and
 * before `link` — the only point at which two writers can be held together to
 * make the race real rather than hoped for. The CLI never passes it.
 */
export function publishConfiguration({
  directory,
  fileName = CONFIG_FILE_NAME,
  contents,
  fs = nodeFileSystem,
  beforePublish,
  temporaryName,
}) {
  const target = join(directory, fileName);
  const temporaryPath = join(
    directory,
    temporaryName ?? `${TEMPORARY_PREFIX}${process.pid}.${cryptoRandomBytes(6).toString("hex")}.tmp`,
  );
  const buffer = Buffer.from(contents, "utf8");

  let fd;
  try {
    fd = fs.openSync(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (error) {
    throw new SetupError(SETUP_CLASSES.unsupportedFilesystem, `temporary-file-unavailable:${errorCode(error) ?? "unknown"}`);
  }

  // From here on every failure path removes this invocation's own temporary
  // file and nothing else. A published `.env` — ours or the winner's — is never
  // touched by a cleanup.
  const removeTemporary = () => {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      /* already gone, or a filesystem that will not let us clean up */
    }
  };

  try {
    writeAll(fs, fd, buffer);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      /* the write already failed */
    }
    removeTemporary();
    throw new SetupError(SETUP_CLASSES.unsupportedFilesystem, `temporary-file-unwritable:${errorCode(error) ?? "unknown"}`);
  }
  fs.closeSync(fd);

  if (beforePublish) beforePublish({ temporaryPath, target });

  try {
    fs.linkSync(temporaryPath, target);
  } catch (error) {
    removeTemporary();
    if (errorCode(error) === "EEXIST") {
      // Someone else published first. We do not read, validate, or report on
      // their file — this invocation simply did not create the configuration.
      throw new SetupError(SETUP_CLASSES.raced, "another-writer-published-first");
    }
    throw new SetupError(SETUP_CLASSES.unsupportedFilesystem, `link-unsupported:${errorCode(error) ?? "unknown"}`);
  }

  // The file exists now. Make its directory entry durable, drop the temporary
  // name, and make that durable too.
  let directoryFd;
  try {
    directoryFd = fs.openSync(directory, fsConstants.O_RDONLY);
    fs.fsyncSync(directoryFd);
    fs.unlinkSync(temporaryPath);
    fs.fsyncSync(directoryFd);
  } catch (error) {
    if (directoryFd !== undefined) {
      try {
        fs.closeSync(directoryFd);
      } catch {
        /* nothing left to salvage on this path */
      }
    }
    removeTemporary();
    throw new SetupError(
      SETUP_CLASSES.unsupportedFilesystem,
      `publication-not-durable:${errorCode(error) ?? "unknown"}`,
    );
  }
  fs.closeSync(directoryFd);

  return { target, temporaryPath };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function describeFileType(stats) {
  if (stats.isSymbolicLink()) return "symbolic-link";
  if (stats.isDirectory()) return "directory";
  if (stats.isFIFO()) return "fifo";
  if (stats.isSocket()) return "socket";
  if (stats.isCharacterDevice()) return "character-device";
  if (stats.isBlockDevice()) return "block-device";
  return "unknown";
}

/**
 * What is already at `path` — its type and mode first, its bytes only if those
 * are acceptable.
 *
 * `null` means nothing is there. `{ contents }` means a regular file at exactly
 * `CONFIG_FILE_MODE`. `{ reason }` means a file exists that is not a usable
 * configuration no matter what it contains.
 *
 * The type and mode are checked before the bytes are read, and `lstat` is used
 * rather than `stat`: a symbolic link is a path into a tree this command does
 * not own, and a group- or world-readable file is exposing two bearer tokens
 * and an encryption key to every local account. Calling either of those
 * `configuration-valid` would tell an operator their secrets are safe at the
 * moment they are not, which is worse than saying nothing.
 */
function inspectExisting(fs, path) {
  let stats;
  try {
    stats = fs.lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new SetupError(SETUP_CLASSES.unsupportedFilesystem, `configuration-unreadable:${errorCode(error) ?? "unknown"}`);
  }

  if (!stats.isFile()) return { reason: `not-a-regular-file:${describeFileType(stats)}` };

  const mode = stats.mode & 0o777;
  if (mode !== CONFIG_FILE_MODE) {
    return { reason: `unsafe-mode:${mode.toString(8).padStart(4, "0")}:expected-0600` };
  }

  try {
    return { contents: fs.readFileSync(path, "utf8") };
  } catch (error) {
    // Gone between the `lstat` and the read: nothing is there now, and
    // publication is no-clobber, so treating it as absent is safe.
    if (errorCode(error) === "ENOENT") return null;
    throw new SetupError(SETUP_CLASSES.unsupportedFilesystem, `configuration-unreadable:${errorCode(error) ?? "unknown"}`);
  }
}

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * One invocation. Returns the class, exit code, reason, changed keys, and
 * remaining actions. Create writes one class line; upgrade adds its two report
 * lines. Neither mode writes to stderr.
 *
 * `reason` is a stable, value-free code for callers and tests. It is
 * deliberately not printed: the contract this command publishes is a class, and
 * anything else on a stream is free text that callers would start parsing.
 */
export function runSetup({
  directory = repositoryRoot,
  fileName = CONFIG_FILE_NAME,
  nodeVersion = process.versions.node,
  randomBytes = cryptoRandomBytes,
  dryRun = false,
  upgrade = false,
  fs = nodeFileSystem,
  beforePublish,
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  // `stderr` is accepted and never used. It stays in the signature because the
  // CLI wires both streams and the tests assert this one stays silent.
  void stderr;
  const finish = (setupClass, reason, changed = [], remaining = []) => {
    if (upgrade) {
      stdout(`setup:local ${dryRun ? "dry-run " : ""}upgrade ${setupClass}`);
      stdout(`changed: ${changed.length === 0 ? "none" : changed.join(",")}`);
      stdout(`remaining: ${remaining.length === 0 ? "none" : remaining.join(",")}`);
    } else {
      stdout(`setup:local ${dryRun ? "dry-run " : ""}${setupClass}`);
    }
    return { setupClass, exitCode: EXIT_CODES[setupClass], reason, changed, remaining };
  };

  // Before any value exists. An unsupported Node leaves the directory exactly
  // as it was found.
  if (!isSupportedNodeVersion(nodeVersion)) {
    return finish(SETUP_CLASSES.unsupportedNode, `node-out-of-range:${nodeVersion}:${SUPPORTED_NODE_RANGE}`);
  }

  const target = join(directory, fileName);
  const existing = inspectExisting(fs, target);
  if (upgrade && existing !== null) {
    if (existing.reason !== undefined) {
      return finish(SETUP_CLASSES.upgradeNeedsAction, existing.reason, [], [existing.reason]);
    }
    let additions;
    try {
      additions = generateUpgradeAdditions(parseEnvAssignments(existing.contents), randomBytes);
    } catch (error) {
      if (error instanceof SetupError) return finish(error.setupClass, error.reason);
      throw error;
    }
    const changed = [...additions.keys()];
    const upgradedContents = renderUpgrade(existing.contents, additions);
    const validation = validateEnvContent(upgradedContents);
    const remaining = upgradeActions(validation.reasons);
    if (dryRun) {
      const setupClass = remaining.length > 0
        ? (changed.length > 0 ? SETUP_CLASSES.upgradedNeedsAction : SETUP_CLASSES.upgradeNeedsAction)
        : (changed.length > 0 ? SETUP_CLASSES.upgraded : SETUP_CLASSES.valid);
      return finish(setupClass, "upgrade-dry-run", changed, remaining);
    }
    if (changed.length > 0) {
      try {
        assertDurableDirectory(directory, fs);
        replaceConfiguration({ directory, fileName, expectedContents: existing.contents, contents: upgradedContents, fs });
      } catch (error) {
        if (error instanceof SetupError) return finish(error.setupClass, error.reason);
        throw error;
      }
    }
    if (remaining.length > 0) {
      return finish(
        changed.length > 0 ? SETUP_CLASSES.upgradedNeedsAction : SETUP_CLASSES.upgradeNeedsAction,
        remaining.join(" "),
        changed,
        remaining,
      );
    }
    return finish(changed.length > 0 ? SETUP_CLASSES.upgraded : SETUP_CLASSES.valid, "upgrade-complete", changed, []);
  }
  if (existing !== null) {
    // Refused on type or mode before its bytes were ever read.
    if (existing.reason !== undefined) return finish(SETUP_CLASSES.invalid, existing.reason);

    const { valid, reasons } = validateEnvContent(existing.contents);
    if (valid) return finish(SETUP_CLASSES.valid, "already-present-and-usable");
    return finish(SETUP_CLASSES.invalid, reasons.join(" "));
  }

  if (dryRun) return finish(SETUP_CLASSES.created, "absent-a-real-run-would-publish");

  try {
    assertDurableDirectory(directory, fs);
    const contents = renderEnvFile(generateConfiguration(randomBytes));
    publishConfiguration({ directory, fileName, contents, fs, beforePublish });
  } catch (error) {
    // Every stable failure below this line already knows its class. The losing
    // writer of the publication race lands here, and lands here having removed
    // its own temporary file, read nothing, and reported no value.
    if (error instanceof SetupError) return finish(error.setupClass, error.reason);
    throw error;
  }
  return finish(upgrade ? SETUP_CLASSES.upgraded : SETUP_CLASSES.created, "published-at-mode-0600", upgrade ? [...REQUIRED_KEYS] : [], []);
}

export function parseArguments(argv) {
  const options = { dryRun: false, help: false, upgrade: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--upgrade") options.upgrade = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--directory") {
      const value = argv[index + 1];
      if (!value) throw new SetupError(SETUP_CLASSES.usage, "--directory requires a path");
      options.directory = value;
      index += 1;
    } else if (argument.startsWith("--directory=")) {
      options.directory = argument.slice("--directory=".length);
    } else {
      throw new SetupError(SETUP_CLASSES.usage, `unknown argument ${JSON.stringify(argument)}`);
    }
  }
  return options;
}

const USAGE = `Usage: npm run setup:local [-- --upgrade] [-- --dry-run] [-- --directory <path>]

Generates this checkout's .env once, with mode 0600. The create form writes one
class line; upgrade adds changed/remaining report lines. Both keep stderr empty:

  configuration-created            the file did not exist and this invocation published it
  configuration-valid              a usable 0600 file already existed and was left untouched
  configuration-raced              another writer published first; nothing was changed
  configuration-invalid            a file exists but is not usable, or is not a regular
                                   file at mode 0600; it was left untouched
  configuration-unsupported-node   this Node does not satisfy ${SUPPORTED_NODE_RANGE}
  configuration-unsupported-filesystem  the directory cannot publish the file durably
  configuration-entropy-unusable   the entropy source returned unusable material
  configuration-upgraded           missing safe-to-generate keys were added
  configuration-upgraded-needs-action  keys were added, but named repairs remain
  configuration-upgrade-needs-action   nothing was changed; named repairs remain
  configuration-usage-error        the arguments could not be parsed

Upgrade preserves every existing assignment, adds only missing locally generated
secret keys, and reports changed key names plus remaining value-free reason codes.
Weak or placeholder credentials are never rotated automatically. No generated
value is ever printed. There is no overwrite or rotation flag.`;

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    if (error instanceof SetupError) {
      // A class and nothing else, here too. `--help` is where the usage text
      // lives, because asking for it is the only time a human wants it.
      process.stdout.write(`setup:local ${error.setupClass}\n`);
      return EXIT_CODES[error.setupClass];
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    const { exitCode } = runSetup({
      directory: options.directory ?? repositoryRoot,
      dryRun: options.dryRun,
      upgrade: options.upgrade,
    });
    return exitCode;
  } catch (error) {
    if (error instanceof SetupError) {
      process.stdout.write(`setup:local ${error.setupClass}\n`);
      return EXIT_CODES[error.setupClass] ?? 1;
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
