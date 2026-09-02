import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import type { ClaimedTask } from "./api.js";
import type { GitIdentity, RunnerConfig } from "./config.js";
import type { CommandRunner } from "./exec.js";

/** The run and Chain identity used to author commit provenance. */
export type GitProvenanceClaim = Pick<ClaimedTask, "executionMode" | "runner"> & {
  task: Pick<ClaimedTask["task"], "chainId" | "chainIndex" | "templateStep">;
  run: Pick<ClaimedTask["run"], "id">;
};

const validIdentityPart = (value: string): boolean => value.trim().length > 0 && !/[\0\r\n]/u.test(value);

const requireIdentity = (identity: GitIdentity | null): GitIdentity => {
  if (!identity || !validIdentityPart(identity.name) || !validIdentityPart(identity.email)) {
    throw new Error(
      "Runner Git identity is incomplete; set both RUNNER_GIT_USER_NAME and RUNNER_GIT_USER_EMAIL, "
      + "or configure both user.name and user.email in the runner account's global Git config",
    );
  }
  return { name: identity.name.trim(), email: identity.email.trim() };
};

export const resolveRunnerGitIdentity = async (
  config: Pick<RunnerConfig, "gitIdentity">,
  run: CommandRunner,
): Promise<GitIdentity> => {
  if (config.gitIdentity !== null && config.gitIdentity !== undefined) return requireIdentity(config.gitIdentity);
  const read = async (key: "user.name" | "user.email"): Promise<string | null> => {
    try {
      return await run("git", ["config", "--global", "--get", key]);
    } catch {
      return null;
    }
  };
  const [name, email] = await Promise.all([read("user.name"), read("user.email")]);
  return requireIdentity(name === null || email === null ? null : { name, email });
};

const safeTrailerValue = (value: string): boolean => value.trim().length > 0 && !/[\0\r\n]/u.test(value);

const provenanceFor = (claim: GitProvenanceClaim): { step: string; provider: "codex" | "claude" | "pi" } | null => {
  const stepName = claim.task.templateStep?.name;
  const provider = claim.runner === "CODEX" ? "codex"
    : claim.runner === "CLAUDE" ? "claude"
      : claim.runner === "PI" ? "pi"
        : null;
  if (claim.executionMode !== "agent"
    || !safeTrailerValue(claim.task.chainId ?? "")
    || !Number.isSafeInteger(claim.task.chainIndex)
    || !safeTrailerValue(stepName ?? "")
    || !safeTrailerValue(claim.run.id)
    || provider === null) return null;
  return {
    step: `${claim.task.chainIndex}: ${stepName!.trim()}`,
    provider,
  };
};

const shellLiteral = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const hookBody = (
  claim: GitProvenanceClaim,
  workspacePath: string,
  commonDir: string,
  provenance: NonNullable<ReturnType<typeof provenanceFor>>,
): string => `#!/bin/sh
set -eu

message_file=$1
source=\${2-}
[ "\${AGENTOS_RUN_ID-}" = ${shellLiteral(claim.run.id)} ] || exit 0

actual_common=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" && pwd -P) || exit 0
actual_top=$(cd "$(git rev-parse --show-toplevel 2>/dev/null)" && pwd -P) || exit 0
[ "$actual_common" = ${shellLiteral(commonDir)} ] || exit 0
case "$actual_top" in
  ${shellLiteral(workspacePath)}|${shellLiteral(`${workspacePath}/`)}*) ;;
  *) exit 0 ;;
esac

strip_anneal_provenance() {
  temporary=$(mktemp "\${message_file}.anneal.XXXXXX") || exit 1
  trap 'rm -f "$temporary"' EXIT HUP INT TERM
  awk '
    {
      lower = tolower($0)
      if (lower ~ /^x-anneal-[^:]*:/) next
      if (lower ~ /^co-authored-by:[[:space:]]*anneal chain[[:space:]]*<chain@anneal[.]invalid>[[:space:]]*$/) next
      print
    }
  ' "$message_file" > "$temporary"
  cat "$temporary" > "$message_file"
  rm -f "$temporary"
  trap - EXIT HUP INT TERM
}

if [ "$source" = "commit" ] \
  || [ -e "$(git rev-parse --git-path CHERRY_PICK_HEAD 2>/dev/null)" ] \
  || [ -e "$(git rev-parse --git-path REVERT_HEAD 2>/dev/null)" ] \
  || [ -d "$(git rev-parse --git-path rebase-merge 2>/dev/null)" ] \
  || [ -d "$(git rev-parse --git-path rebase-apply 2>/dev/null)" ]; then
  strip_anneal_provenance
  exit 0
fi

parsed=$(git interpret-trailers --parse "$message_file")
if printf '%s\n' "$parsed" | grep -Eiq '^(X-Anneal-[^:]*:|Co-Authored-By:.*<chain@anneal\.invalid>[[:space:]]*$)'; then
  run=${shellLiteral(`X-Anneal-Run: ${claim.run.id}`)}
  step=${shellLiteral(`X-Anneal-Step: ${provenance.step}`)}
  provider=${shellLiteral(`X-Anneal-Provider: ${provenance.provider}`)}
  coauthor=${shellLiteral("Co-Authored-By: Anneal Chain <chain@anneal.invalid>")}
  [ "$(printf '%s\n' "$parsed" | grep -Fxc -- "$run" || true)" -eq 1 ] \
    && [ "$(printf '%s\n' "$parsed" | grep -Fxc -- "$step" || true)" -eq 1 ] \
    && [ "$(printf '%s\n' "$parsed" | grep -Fxc -- "$provider" || true)" -eq 1 ] \
    && [ "$(printf '%s\n' "$parsed" | grep -Fxc -- "$coauthor" || true)" -eq 1 ] \
    && [ "$(printf '%s\n' "$parsed" | grep -Eic '^X-Anneal-[^:]*:' || true)" -eq 3 ] \
    && [ "$(printf '%s\n' "$parsed" | grep -Eic '^Co-Authored-By:.*<chain@anneal\.invalid>[[:space:]]*$' || true)" -eq 1 ] \
    && exit 0
  echo "Conflicting or incomplete Anneal provenance trailers; refusing commit" >&2
  exit 1
fi

cat >> "$message_file" <<'ANNEAL_PROVENANCE'

Co-Authored-By: Anneal Chain <chain@anneal.invalid>
X-Anneal-Run: ${claim.run.id}
X-Anneal-Step: ${provenance.step}
X-Anneal-Provider: ${provenance.provider}
ANNEAL_PROVENANCE
`;

/** Pins the human author locally and, for a fully identified chain run only,
 * installs a session-scoped provenance hook in Git metadata. The hook is not
 * selected in local config: only the provider child environment activates it,
 * so a retained workspace cannot mislabel a later human commit. */
export const configureWorkspaceGit = async (
  claim: GitProvenanceClaim,
  workspacePath: string,
  identity: GitIdentity,
  run: CommandRunner,
): Promise<string | null> => {
  await run("git", ["config", "--local", "user.name", identity.name]);
  await run("git", ["config", "--local", "user.email", identity.email]);

  const provenance = provenanceFor(claim);
  if (!provenance) return null;
  const rawCommonDir = await run("git", ["rev-parse", "--git-common-dir"]);
  const commonDir = await realpath(isAbsolute(rawCommonDir) ? rawCommonDir : resolve(workspacePath, rawCommonDir));
  const canonicalWorkspace = await realpath(workspacePath);
  if (commonDir !== canonicalWorkspace && !commonDir.startsWith(`${canonicalWorkspace}${sep}`)) {
    throw new Error(`Run repository Git metadata escaped its workspace: ${commonDir}`);
  }
  const hooksPath = join(commonDir, "anneal-hooks");
  const hookPath = join(hooksPath, "prepare-commit-msg");
  await run("/bin/mkdir", ["-p", hooksPath]);
  await run(
    "/bin/sh",
    ["-c", 'umask 077; cat > "$1"; chmod 700 "$1"', "anneal-commit-hook", hookPath],
    { input: hookBody(claim, canonicalWorkspace, commonDir, provenance) },
  );
  return hooksPath;
};
