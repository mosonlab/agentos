import { type BuildInfo, buildSha, formatBuildLine, readBuildInfo } from "@anneal/build-info";

/** What this process calls itself in its startup line and on `/version`. The
 *  package name in the stamp says what was built; this says what is running,
 *  and an unbuilt process still has to be able to name itself. */
export const API_SERVICE = "@anneal/api";

// Resolved once, from beside this module: in `dist` that is the API's own build
// stamp, and under tsx there is no stamp at all, which reports as "unbuilt".
// Both are the truth about the process that is answering.
const info: BuildInfo = readBuildInfo(import.meta.url);

/** The startup line. Printed before anything can fail, because the first thing
 *  an incident asks of a control plane is which build it is. */
export const apiBuildLine = (buildInfo: BuildInfo = info): string =>
  `AgentOS API build: ${formatBuildLine(buildInfo)}`;

export type VersionPayload = {
  service: string;
  version: string | null;
  buildSha: string;
  commit: string | null;
  dirty: boolean;
  stamped: boolean;
  builtAt: string | null;
};

/**
 * The public version document.
 *
 * Deliberately nothing but provenance: no configuration, no paths, no database
 * state, no principal-dependent fields. It answers "which commit is serving
 * this port" for anyone who can reach the port, which is the question an
 * operator, a deployment check and a release audit all ask — and it is
 * unauthenticated for the same reason `/health` is, because the answer is
 * useless to an attacker and needed by whoever is trying to find out whether a
 * restart actually took.
 */
export const versionPayload = (buildInfo: BuildInfo = info): VersionPayload => ({
  service: API_SERVICE,
  version: buildInfo.version,
  buildSha: buildSha(buildInfo),
  commit: buildInfo.commit,
  dirty: buildInfo.dirty,
  stamped: buildInfo.stamped,
  builtAt: buildInfo.builtAt,
});
