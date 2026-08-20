// Build provenance: what commit is this dist, and was the tree it came from
// clean? (issue #140)
//
// The 2026-08-17 incident was "merged" and "running" being different facts with
// no way to tell them apart: production was still serving a dist built from an
// older commit, and the only way to find out was hashing artefacts by hand. The
// merge gate can already bind a PASS to an exact object id; this package is the
// other half — the artefact carries that id, so a running process can say which
// commit it is and a deployment can refuse to start the wrong one.
//
// Deliberately plain JavaScript with a hand-written .d.ts: it is read by the
// API and the runner at runtime, by their `tsc` at typecheck time, and by
// deployment scripts before either process starts. Having no build step of its
// own means there is no ordering in which one of those three consumers finds it
// missing — which is exactly the class of problem it exists to close.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether this module is the script the process was started with.
 *
 * Compared as real paths on purpose. A checkout reached through a symlink, or a
 * command invoked through one, gives `process.argv[1]` a path that never equals
 * the module's own resolved URL — and the failure mode of getting this wrong is
 * a CLI whose whole body is skipped, which exits 0 having checked nothing. A
 * deployment check that fail-opens when it is reached by an unusual path is
 * worse than no deployment check.
 */
export const isEntryPoint = (moduleUrl, argv1 = process.argv[1]) => {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
};

/** What a dist that was never stamped reports. Not an error: running the API or
 *  the runner straight from source (tsx, dev, the test suites) is legitimate,
 *  and "unbuilt" is the honest answer for it. It is never a match for an
 *  expected commit, so a deployment check still fails closed. */
export const UNSTAMPED = Object.freeze({
  stamped: false,
  commit: null,
  dirty: false,
  packageName: null,
  version: null,
  builtAt: null,
});

const isFullObjectId = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

/** Accepts only a whole, well-formed stamp. A half-written or hand-edited
 *  build-info.json is worth less than no stamp at all — it would let a
 *  reconciliation check compare against a field that means nothing. */
const parseBuildInfo = (raw) => {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const { commit, dirty, packageName, version, builtAt } = parsed;
  if (commit !== null && !isFullObjectId(commit)) return null;
  if (typeof dirty !== "boolean") return null;
  if (typeof packageName !== "string" || typeof version !== "string") return null;
  if (typeof builtAt !== "string") return null;
  return Object.freeze({ stamped: true, commit, dirty, packageName, version, builtAt });
};

/**
 * Read the stamp that sits beside the calling module.
 *
 * Callers pass their own `import.meta.url`, so a module in `packages/api/dist`
 * reads the API's stamp and a module in `packages/runner/dist` reads the
 * runner's. That is the point: the two are built at different times, and the
 * incident was precisely one of them being stale while the other was current.
 */
export const readBuildInfo = (moduleUrl) => {
  try {
    return parseBuildInfo(readFileSync(new URL("build-info.json", moduleUrl), "utf8")) ?? UNSTAMPED;
  } catch {
    // Missing (running from source) or unreadable (a broken dist). Neither may
    // be reported as a commit, and neither is a reason to fail to start.
    return UNSTAMPED;
  }
};

/** The one human- and log-facing rendering of a build, so the startup line, the
 *  version endpoint and the deployment check never disagree about what to call
 *  the same dist. A dirty build is never printed as the bare commit. */
export const buildSha = (info) => {
  if (!info.stamped) return "unbuilt";
  if (!info.commit) return "unknown";
  return info.dirty ? `${info.commit}-dirty` : info.commit;
};

/** The startup line's payload. Callers prefix it with their own service name,
 *  which is what identifies the process; everything after it describes the
 *  artefact. Machine-greppable on purpose: `sha=` is what a deployment check or
 *  an incident responder greps for in a launchd log. */
export const formatBuildLine = (info) =>
  `sha=${buildSha(info)} package=${info.packageName ?? "unknown"}@${info.version ?? "unknown"} builtAt=${info.builtAt ?? "unknown"}`;

/**
 * Whether this artefact is the approved commit, and why not when it is not.
 * Shared by the deployment check and its tests so "acceptable to run" has one
 * definition.
 *
 * Dirty is a refusal: a tree with uncommitted work is not the commit that was
 * gated, whatever its HEAD says. So is the wrong package: the api and the
 * runner are stamped separately precisely so they can disagree, and a check
 * that accepts the api's stamp sitting in the runner's dist would report two
 * green lines for a deployment that is half wrong. `expectedPackage` is
 * optional only because a caller may point `--dist` at a directory whose
 * identity cannot be inferred; when it is known it is enforced.
 */
export const reconcile = (info, expectedCommit, expectedPackage = null) => {
  const expected = expectedCommit.toLowerCase();
  if (!isFullObjectId(expected)) {
    return { ok: false, reason: `expected commit must be a full 40-character object id, got: ${expectedCommit}` };
  }
  if (!info.stamped) return { ok: false, reason: "no build stamp: this dist was never built by `npm run build`" };
  if (!info.commit) return { ok: false, reason: "the build recorded no commit: it was built outside a git worktree" };
  if (expectedPackage && info.packageName !== expectedPackage) {
    return { ok: false, reason: `holds a ${info.packageName} build, expected ${expectedPackage}` };
  }
  if (info.commit !== expected) return { ok: false, reason: `built from ${info.commit}, expected ${expected}` };
  if (info.dirty) return { ok: false, reason: `built from ${info.commit} with uncommitted changes in the worktree` };
  return { ok: true, reason: `${info.commit} (clean)${expectedPackage ? "" : ", package identity unchecked"}` };
};

/** The `/version` document a running service serves, as a `BuildInfo`. The
 *  deployment check asks the same question of a dist on disk and of the process
 *  that is actually serving a port — "is this the approved commit" — so both
 *  answers have to arrive in the same shape. Anything that is not a whole,
 *  well-formed document reads as unstamped, never as a half-believed commit. */
export const buildInfoFromVersionDocument = (document) => {
  if (typeof document !== "object" || document === null) return { info: UNSTAMPED, service: null };
  const { service, version, commit, dirty, stamped, builtAt } = document;
  if (stamped !== true) return { info: UNSTAMPED, service: typeof service === "string" ? service : null };
  if (commit !== null && !isFullObjectId(commit)) return { info: UNSTAMPED, service: null };
  if (typeof dirty !== "boolean") return { info: UNSTAMPED, service: null };
  if (typeof service !== "string") return { info: UNSTAMPED, service: null };
  return {
    service,
    info: Object.freeze({
      stamped: true,
      commit,
      dirty,
      packageName: service,
      version: typeof version === "string" ? version : "unknown",
      builtAt: typeof builtAt === "string" ? builtAt : "unknown",
    }),
  };
};
