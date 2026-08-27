#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DISPOSITIONS = new Set([
  "blocker",
  "approved-public-material",
  "later-release-follow-up",
]);

const SCAN_CATEGORIES = [
  "snapshot-scope",
  "credential",
  "credential-placeholder",
  "pii-email",
  "pii-government-id",
  "private-absolute-path",
  "internal-only-artifact",
  "generated-runtime-data",
  "binary-material",
];

const PLACEHOLDER_SENTINELS = new Set(["CHANGE_ME"]);
const VARIABLE_REFERENCE = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

export function globToRegExp(glob) {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$+.()|{}[\]]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function matches(glob, path) {
  return globToRegExp(glob).test(path);
}

function validateRepositoryPath(path, label) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (path.includes("\0")) throw new Error(`${label} must not contain NUL`);
  if (isAbsolute(path) || path.startsWith("/")) {
    throw new Error(`${label} must be repository-relative`);
  }
  if (path.includes("\\")) throw new Error(`${label} must use slash separators`);
  if (posix.normalize(path) !== path || path === "." || path.startsWith("../")) {
    throw new Error(`${label} must be normalized and repository-relative`);
  }
  return path;
}

function validatePathList(paths, label) {
  const normalized = new Set();
  for (const path of paths) {
    const checked = validateRepositoryPath(path, label);
    const key = posix.normalize(checked);
    if (normalized.has(key)) throw new Error(`${label} contains a duplicate normalized path`);
    normalized.add(key);
  }
}

function validateManifest(manifest) {
  if (manifest.schemaVersion !== 2) throw new Error("unsupported manifest schema");
  if (manifest.source !== "git-tracked-files+minted-artifacts") {
    throw new Error("manifest source must be git-tracked-files+minted-artifacts");
  }
  if (manifest.defaultDisposition !== "blocker") throw new Error("manifest must default to blocker");
  for (const key of ["include", "deny", "exclude", "approvedFindings", "generatedRuntimePatterns", "mintedArtifacts"]) {
    if (!Array.isArray(manifest[key])) throw new Error(`manifest ${key} must be an array`);
  }
  validatePathList(manifest.include.map((rule) => rule.glob), "manifest include glob");
  validatePathList(manifest.deny.map((rule) => rule.glob), "manifest deny glob");
  validatePathList(manifest.exclude.map((rule) => rule.glob), "manifest exclude glob");
  for (const rule of manifest.deny) {
    validateRepositoryPath(rule.glob, "manifest deny glob");
    if (!new Set(["internal-only-artifact", "generated-runtime-data"]).has(rule.category)) {
      throw new Error(`invalid deny category for ${rule.glob}`);
    }
  }
  for (const rule of manifest.exclude) {
    validateRepositoryPath(rule.glob, "manifest exclude glob");
    if (!DISPOSITIONS.has(rule.disposition) || rule.disposition === "approved-public-material") {
      throw new Error(`invalid exclusion disposition for ${rule.glob}`);
    }
  }
  const approvalKeys = new Set();
  for (const rule of manifest.approvedFindings) {
    validateRepositoryPath(rule.glob, "manifest approved finding glob");
    const key = `${rule.category}\0${rule.glob}`;
    if (approvalKeys.has(key)) throw new Error("manifest approved finding contains a duplicate rule");
    approvalKeys.add(key);
  }
  validatePathList(manifest.mintedArtifacts, "manifest minted artifact");
  validatePathList(manifest.generatedRuntimePatterns, "manifest generated runtime pattern");
}

export function scopeFor(path, manifest) {
  const includes = manifest.include.filter((rule) => matches(rule.glob, path));
  const denies = manifest.deny.filter((rule) => matches(rule.glob, path));
  const excludes = manifest.exclude.filter((rule) => matches(rule.glob, path));
  let classification = "unclassified";
  if (denies.length > 0) classification = "excluded";
  else if (includes.length === 1 && excludes.length === 0) classification = "included";
  else if (includes.length === 0 && excludes.length === 1) classification = "excluded";
  else if (includes.length > 0 || excludes.length > 0) classification = "overlapping";
  return {
    classification,
    included: classification === "included",
    includes,
    denies,
    excludes,
  };
}

function isProbablyBinary(buffer) {
  if (buffer.includes(0)) return true;
  if (buffer.length === 0) return false;
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious / buffer.length > 0.1;
}

function countMatches(text, expression, predicate = () => true) {
  let count = 0;
  for (const match of text.matchAll(expression)) {
    if (predicate(match)) count += 1;
  }
  return count;
}

function looksLikePlaceholder(value) {
  const unquoted = value
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");
  if (unquoted === "") return true;
  return PLACEHOLDER_SENTINELS.has(unquoted) || VARIABLE_REFERENCE.test(unquoted);
}

/** An address-shaped string is only personal data when it can name a person, and
 *  Git remotes are full of shapes that cannot: the userinfo half of a URL
 *  (`https://<token>@github.com/owner/name.git`, `ssh://git:secret@host/...`), the
 *  same position in an scp-style remote (`oauth2@gitlab.com:owner/name.git`), and
 *  the service-account logins a forge accepts in place of a user. Those are hosts
 *  and credentials; the credential rules above already judge the credential half,
 *  and counting them again as PII only teaches readers to wave the category
 *  through. This narrows what the rule claims rather than widening what the
 *  manifest publishes: an address written as an address is still counted, even on
 *  a line that also carries a URL (this comment deliberately spells none out, as
 *  the rule reads its own source too). The known blind spot is a
 *  real personal address used as URL userinfo, which is not a form this repository
 *  writes and which the surrounding credential rules would still see. */
const URL_USERINFO_PREFIX = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>]*$/;
const SCP_REMOTE_PATH = /^:[^\s"'`<>:]*\/[^\s"'`<>]*/;
const FORGE_SERVICE_LOGINS = new Set(["git", "oauth2", "token", "x-access-token"]);
const FORGE_TOKEN_LOGIN = /^(?:gh[pousr]_|github_pat_)/;

function isForgeRemoteUserinfo(match) {
  const local = match[1].toLowerCase();
  if (FORGE_SERVICE_LOGINS.has(local) || FORGE_TOKEN_LOGIN.test(local)) return true;
  const before = match.input.slice(0, match.index);
  if (URL_USERINFO_PREFIX.test(before)) return true;
  return SCP_REMOTE_PATH.test(match.input.slice(match.index + match[0].length));
}

export function scanTextFindings(path, text) {
  const findings = [];
  const add = (category, count) => {
    if (count > 0) findings.push({ category, count });
  };

  const credentialExpressions = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
    /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9_]{20,}(?![A-Za-z0-9_])/g,
    /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}(?![A-Za-z0-9_])/g,
    /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    /(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,
    /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g,
  ];
  add(
    "credential",
    credentialExpressions.reduce((total, expression) => total + countMatches(text, expression), 0),
  );

  const connectionString =
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/]+:[^\s@/]+@([^\s/:]+)/gi;
  let localConnections = 0;
  let remoteConnections = 0;
  for (const match of text.matchAll(connectionString)) {
    if (["localhost", "127.0.0.1", "postgres", "db"].includes(match[1].toLowerCase())) {
      localConnections += 1;
    } else {
      remoteConnections += 1;
    }
  }
  add("credential-placeholder", localConnections);
  add("credential", remoteConnections);

  if (/^\.env(?:\.|$)/.test(path.split("/").at(-1) ?? "")) {
    const assignment = /^([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)[ \t]*=[ \t]*(.*)$/gm;
    let placeholders = 0;
    let credentials = 0;
    for (const match of text.matchAll(assignment)) {
      if (looksLikePlaceholder(match[2])) placeholders += 1;
      else credentials += 1;
    }
    add("credential-placeholder", placeholders);
    add("credential", credentials);
  }

  add(
    "private-absolute-path",
    countMatches(
      text,
      /(?:\/Users\/[^/\s"'`]+|\/home\/[^/\s"'`]+|[A-Za-z]:\\Users\\[^\\\s"'`]+)/g,
    ),
  );

  add(
    "pii-email",
    countMatches(
      text,
      /\b([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi,
      (match) => {
        const domain = match[2].toLowerCase();
        return (
          !isForgeRemoteUserinfo(match) &&
          !domain.endsWith(".test") &&
          !domain.endsWith(".local") &&
          !["example.com", "example.org", "example.net"].includes(domain)
        );
      },
    ),
  );
  add("pii-government-id", countMatches(text, /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g));

  return findings;
}

function dispositionFor(category, path, scope, manifest) {
  if (scope.denies.length > 0) {
    return {
      disposition: "later-release-follow-up",
      reason: scope.denies[0].reason,
    };
  }
  if (category === "credential" && scope.included) {
    return {
      disposition: "blocker",
      reason: "real credentials cannot be approved on the public surface",
    };
  }
  const approval = manifest.approvedFindings.find(
    (rule) => rule.category === category && matches(rule.glob, path),
  );
  if (approval) {
    return { disposition: "approved-public-material", reason: approval.reason };
  }
  if (!scope.included && scope.excludes.length === 1) {
    return {
      disposition: scope.excludes[0].disposition,
      reason: scope.excludes[0].reason,
    };
  }
  return {
    disposition: "blocker",
    reason: "finding is in public scope without an explicit safe classification",
  };
}

function addFinding(target, finding) {
  const existing = target.find(
    (item) =>
      item.category === finding.category &&
      item.disposition === finding.disposition &&
      item.path === finding.path &&
      item.reason === finding.reason,
  );
  if (existing) existing.count += finding.count;
  else target.push(finding);
}

function assertCleanTrackedWorktree(root) {
  const changes = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=no"],
    { cwd: root },
  ).toString("utf8");
  if (changes.length > 0) {
    throw new Error("tracked worktree must match HEAD before scanning");
  }
}

function readGitTree(root, commit) {
  const output = execFileSync("git", ["ls-tree", "-rz", "--full-tree", "-r", commit], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  const entries = [];
  for (const record of output.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("git tree contains an unsupported entry record");
    const [, mode, type, oid, path] = match;
    validateRepositoryPath(path, "tracked path");
    entries.push({ mode, type, oid, path });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

function readGitBlobs(root, entries) {
  const oids = [...new Set(entries.filter((entry) => entry.type === "blob").map((entry) => entry.oid))];
  if (oids.length === 0) return new Map();
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: `${oids.join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  const blobs = new Map();
  let offset = 0;
  for (const expectedOid of oids) {
    const newline = output.indexOf(10, offset);
    if (newline === -1) throw new Error("git cat-file returned a truncated header");
    const header = output.subarray(offset, newline).toString("ascii");
    const match = /^([0-9a-f]{40}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== expectedOid) throw new Error("git cat-file returned an unexpected object");
    const size = Number(match[2]);
    const start = newline + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end >= output.length || output[end] !== 10) {
      throw new Error("git cat-file returned truncated blob bytes");
    }
    blobs.set(expectedOid, output.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error("git cat-file returned trailing output");
  return blobs;
}

function isWithinRoot(root, path) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${posix.sep}`) && pathFromRoot !== "..");
}

function readMintedFile(root, path) {
  const candidate = resolve(root, path);
  if (!isWithinRoot(root, candidate)) throw new Error("minted artifact escapes repository root");
  const lexical = lstatSync(candidate);
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw new Error("minted artifact must be a regular file, not a symlink or special file");
  }
  const canonical = realpathSync(candidate);
  if (!isWithinRoot(root, canonical)) throw new Error("minted artifact resolves outside repository root");
  const descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== lexical.dev || opened.ino !== lexical.ino) {
      throw new Error("minted artifact identity changed while opening");
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function scanRepository(
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  { requireClean = true } = {},
) {
  root = realpathSync(root);
  if (requireClean) assertCleanTrackedWorktree(root);
  const commit = execFileSync("git", ["rev-parse", "HEAD^{commit}"], { cwd: root })
    .toString("utf8")
    .trim();
  const trackedEntries = readGitTree(root, commit);
  const trackedByPath = new Map(trackedEntries.map((entry) => [entry.path, entry]));
  const blobs = readGitBlobs(root, trackedEntries);
  const manifestEntry = trackedByPath.get("public-snapshot.json");
  if (!manifestEntry || manifestEntry.type !== "blob" || !["100644", "100755"].includes(manifestEntry.mode)) {
    throw new Error("public-snapshot.json must be a tracked regular file");
  }
  const manifestBytes = blobs.get(manifestEntry.oid);
  if (!manifestBytes) throw new Error("public-snapshot.json blob is unavailable");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateManifest(manifest);

  const trackedPaths = trackedEntries.map((entry) => entry.path);
  // Files the snapshot procedure mints rather than tracks — today, the release
  // authority attestation. They are `.gitignore`d by design, so `git ls-files`
  // cannot see them, and a snapshot input that no scan reads is a snapshot
  // input nobody has checked. They are classified and read exactly like a
  // tracked path; the only difference is where the list comes from.
  const mintedPaths = manifest.mintedArtifacts
    .filter((path) => !trackedByPath.has(path) && existsSync(resolve(root, path)))
    .sort();
  const paths = [...trackedPaths, ...mintedPaths].sort();

  const findings = [];
  const includedPaths = [];
  const excludedPaths = [];
  const unclassifiedPaths = [];
  const overlappingPaths = [];
  const scopeByPath = new Map();

  for (const rule of manifest.include) {
    if (!trackedPaths.some((path) => matches(rule.glob, path))) {
      addFinding(findings, {
        category: "snapshot-scope",
        disposition: "blocker",
        path: rule.glob,
        count: 1,
        reason: "include glob matches no git-tracked path",
      });
    }
  }

  for (const path of paths) {
    const scope = scopeFor(path, manifest);
    scopeByPath.set(path, scope);
    if (scope.classification === "included") includedPaths.push(path);
    else if (scope.classification === "excluded") excludedPaths.push(path);
    else if (scope.classification === "unclassified") unclassifiedPaths.push(path);
    else overlappingPaths.push(path);

    const tracked = trackedByPath.get(path);
    if (
      scope.included &&
      tracked &&
      (tracked.type !== "blob" || !["100644", "100755"].includes(tracked.mode))
    ) {
      throw new Error("included tracked path must be a regular Git file");
    }

    if (scope.classification === "overlapping") {
      addFinding(findings, {
        category: "snapshot-scope",
        disposition: "blocker",
        path,
        count: 1,
        reason: "path matches overlapping manifest rules",
      });
    } else if (scope.classification === "unclassified") {
      addFinding(findings, {
        category: "snapshot-scope",
        disposition: "blocker",
        path,
        count: 1,
        reason: "tracked path is not explicitly included or excluded",
      });
    }
  }

  for (const rule of manifest.deny) {
    const count = paths.filter((path) => matches(rule.glob, path)).length;
    if (count > 0) {
      addFinding(findings, {
        category: rule.category,
        disposition: "later-release-follow-up",
        path: rule.glob,
        count,
        reason: rule.reason,
      });
    }
  }

  for (const rule of manifest.exclude) {
    const count = paths.filter((path) => matches(rule.glob, path)).length;
    if (count > 0) {
      addFinding(findings, {
        category: "internal-only-artifact",
        disposition: rule.disposition,
        path: rule.glob,
        count,
        reason: rule.reason,
      });
    }
  }

  for (const pattern of manifest.generatedRuntimePatterns) {
    const matched = paths.filter((path) => matches(pattern, path));
    const byDisposition = new Map();
    for (const path of matched) {
      const decision = dispositionFor("generated-runtime-data", path, scopeByPath.get(path), manifest);
      const key = `${decision.disposition}\0${decision.reason}`;
      const current = byDisposition.get(key) ?? { ...decision, count: 0 };
      current.count += 1;
      byDisposition.set(key, current);
    }
    for (const decision of byDisposition.values()) {
      addFinding(findings, {
        category: "generated-runtime-data",
        disposition: decision.disposition,
        path: pattern,
        count: decision.count,
        reason: decision.reason,
      });
    }
  }

  for (const path of paths) {
    const scope = scopeByPath.get(path);
    const tracked = trackedByPath.get(path);
    if (tracked && (tracked.type !== "blob" || !["100644", "100755"].includes(tracked.mode))) {
      continue;
    }
    const bytes = tracked ? blobs.get(tracked.oid) : readMintedFile(root, path);
    if (!bytes) throw new Error("snapshot input bytes are unavailable");
    if (isProbablyBinary(bytes)) {
      const decision = dispositionFor("binary-material", path, scope, manifest);
      addFinding(findings, {
        category: "binary-material",
        disposition: decision.disposition,
        path: scope.excludes[0]?.glob ?? path,
        count: 1,
        reason: decision.reason,
      });
      continue;
    }
    for (const detected of scanTextFindings(path, bytes.toString("utf8"))) {
      const decision = dispositionFor(detected.category, path, scope, manifest);
      addFinding(findings, {
        category: detected.category,
        disposition: decision.disposition,
        path,
        count: detected.count,
        reason: decision.reason,
      });
    }
  }

  findings.sort((left, right) =>
    [left.disposition, left.category, left.path].join("\0").localeCompare(
      [right.disposition, right.category, right.path].join("\0"),
    ),
  );
  const countsByDisposition = Object.fromEntries(
    [...DISPOSITIONS].map((disposition) => [
      disposition,
      findings
        .filter((finding) => finding.disposition === disposition)
        .reduce((sum, finding) => sum + finding.count, 0),
    ]),
  );
  const countsByCategory = Object.fromEntries(SCAN_CATEGORIES.map((category) => [category, 0]));
  for (const finding of findings) {
    countsByCategory[finding.category] = (countsByCategory[finding.category] ?? 0) + finding.count;
  }

  return {
    report: {
      schemaVersion: 2,
      commit,
      source: mintedPaths.length > 0 ? "git-objects+minted-artifacts" : "git-objects",
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      scope: {
        trackedFiles: trackedPaths.length,
        mintedFiles: mintedPaths.length,
        includedFiles: includedPaths.length,
        excludedFiles: excludedPaths.length,
        unclassifiedFiles: unclassifiedPaths.length,
        overlappingFiles: overlappingPaths.length,
      },
      summary: {
        countsByDisposition,
        countsByCategory,
      },
      findings,
    },
    includedPaths,
  };
}

function main() {
  const listIncluded = process.argv.includes("--list-included");
  try {
    const result = scanRepository();
    const blockers = result.report.summary.countsByDisposition.blocker;
    if (listIncluded) {
      if (blockers === 0) process.stdout.write(`${result.includedPaths.join("\n")}\n`);
      else process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    }
    process.exitCode = blockers === 0 ? 0 : 1;
  } catch {
    process.stderr.write("public snapshot scan failed safely; no matched content was emitted\n");
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
