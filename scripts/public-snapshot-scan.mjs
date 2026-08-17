#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

function validateManifest(manifest) {
  if (manifest.schemaVersion !== 2) throw new Error("unsupported manifest schema");
  if (manifest.source !== "git-tracked-files") throw new Error("manifest source must be git-tracked-files");
  if (manifest.defaultDisposition !== "blocker") throw new Error("manifest must default to blocker");
  for (const key of ["include", "deny", "exclude", "approvedFindings", "generatedRuntimePatterns"]) {
    if (!Array.isArray(manifest[key])) throw new Error(`manifest ${key} must be an array`);
  }
  for (const rule of manifest.deny) {
    if (!new Set(["internal-only-artifact", "generated-runtime-data"]).has(rule.category)) {
      throw new Error(`invalid deny category for ${rule.glob}`);
    }
  }
  for (const rule of manifest.exclude) {
    if (!DISPOSITIONS.has(rule.disposition) || rule.disposition === "approved-public-material") {
      throw new Error(`invalid exclusion disposition for ${rule.glob}`);
    }
  }
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
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  if (sample.length === 0) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.1;
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
        const local = match[1].toLowerCase();
        const domain = match[2].toLowerCase();
        return (
          local !== "git" &&
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

export function scanRepository(
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  { requireClean = true } = {},
) {
  if (requireClean) assertCleanTrackedWorktree(root);
  const manifestPath = resolve(root, "public-snapshot.json");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateManifest(manifest);

  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString("utf8")
    .trim();

  const findings = [];
  const includedPaths = [];
  const excludedPaths = [];
  const unclassifiedPaths = [];
  const overlappingPaths = [];
  const scopeByPath = new Map();

  for (const path of paths) {
    const scope = scopeFor(path, manifest);
    scopeByPath.set(path, scope);
    if (scope.classification === "included") includedPaths.push(path);
    else if (scope.classification === "excluded") excludedPaths.push(path);
    else if (scope.classification === "unclassified") unclassifiedPaths.push(path);
    else overlappingPaths.push(path);

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
    const bytes = readFileSync(resolve(root, path));
    const scope = scopeByPath.get(path);
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
      source: "clean-tracked-worktree",
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      scope: {
        trackedFiles: paths.length,
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
