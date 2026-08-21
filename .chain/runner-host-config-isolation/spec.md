Runner-launched CLI sessions load no operator-host configuration - no host
CLAUDE.md or AGENTS.md, no host settings, hooks, skills, plugins, or memory
contents - while continuing to authenticate exactly as they do today.

Background: spawnRuntime builds the child environment through
buildChildEnvironment/workspaceEnvironment, passing only PATH/HOME/LANG (and
GIT_TERMINAL_PROMPT), with HOME taken once at daemon startup from RUNNER_HOME
?? HOME; adapters.ts builds the claude and codex argv. Nothing in
packages/runner excludes the operator's user configuration layer, so every
runner-launched claude session loads ~/.claude/CLAUDE.md, the hooks and
permissions in ~/.claude/settings.json, everything under ~/.claude/skills and
~/.claude/plugins, and the auto-memory under ~/.claude/projects/<slug>/memory;
every codex session loads ~/.codex/AGENTS.md and ~/.codex/config.toml. Four
consequences, all observed: host canon text has leaked into pushed .chain/
artifacts (toy-chain gate deviation 2, run6 SEQ 9-10); operator PreToolUse
hooks intercept platform tool calls and surface as agent failure rather than as
configuration refusal; operator-personal skills and plugins are offered to
platform sessions; and platform behavior drifts with the operator machine
instead of being reproducible from the repository. The claude CLI exposes
`--setting-sources`, which selects which of the user/project/local settings
sources load; excluding `user` removes all four claude-side vectors and leaves
authentication, the repository's own AGENTS.md, permissions, model selection,
and explicitly passed MCP configuration working unchanged.

Changes:
1. The claude adapter argv gains `--setting-sources project,local`. The runner
   must not set CLAUDE_CONFIG_DIR and must not override HOME for claude.
2. Add a repo-versioned platform settings file and pass it to claude as
   `--settings <path>`. It carries platform-required settings only and contains
   no operator personal instruction text. Every setting the platform relies on
   that today comes from the host user layer must be restated in this file;
   auditing the host user layer for such settings is part of this item.
3. The runner injects HTTP_PROXY, HTTPS_PROXY and NO_PROXY into the claude and
   codex child process environment, taken from the runner process environment.
   They must not be routed through `--settings` (settings-level env does not
   reach the child process environment - appendix E). Whenever the runner
   process has one of these set, the child must receive the same value; the
   runner must never silently drop it.
4. The codex adapter points CODEX_HOME at an ephemeral per-session config root
   created during provision, seeded from a repo-versioned platform baseline
   that carries config.toml only and no AGENTS.md, with the host ~/.codex/auth.json copied in. No other host file is copied. The host ~/.codex must no longer be codex's config source for platform sessions.
5. Lifecycle for the codex session config root: created during provision,
   removed on successful run completion, retained on failure with its path
   included in the run's failure information.
6. pi: apply the equivalent lever only if pi exposes one; otherwise record the
   gap in the pull request description rather than inventing a mechanism.

Out of scope: CLAUDE_CONFIG_DIR, HOME override, CLAUDE_CODE_OAUTH_TOKEN, and
any other change to how claude authenticates - claude keeps using the operator
Keychain login exactly as today. Shared host mutable state (~/.claude.json,
history.jsonl, sessions/, file-history/) and the concurrency and
transcript-mixing problems it causes. The claude auto-memory directory path,
which still resolves under the host home after this change - its contents are
no longer injected, but preventing platform writes to it is separate work.
RUNNER_RUN_AS_PREFIX and multi-uid isolation; CLI availability probing;
workspace (git clone) provisioning; spawn-level failure classification.

Base: start from main on a new branch. Do not branch from, merge, or cherry-pick
runner-session-cli-config-home - its claude-side CLAUDE_CONFIG_DIR code is
invalid and must not reach main in any form, and building on it would leave its
codex-side code outside this chain's review diff. That codex-side code is
nonetheless a correct reference implementation of Changes 4 and 5. The
workspace is a `--single-branch` clone, so those objects are not present and
`git show` alone fails; fetch the ref explicitly first:

    git fetch --no-tags origin runner-session-cli-config-home
    git show 44c529e 90fc7d3 -- packages/runner/

Read them before writing Changes 4 and 5, and reproduce what fits the brief
rather than re-deriving it. Everything you keep must appear as new code in
this chain's own diff, so reviewers judge every line against this brief. Do not
merge or cherry-pick that ref, and do not leave it as a tracked remote branch
the delivery step could push.

Constraints: never silently fall back to host configuration. If the codex
session config root cannot be created, or auth.json cannot be copied into it,
the run fails loudly in the PROVISION phase with a reason naming the cause.
Platform session behavior must be reproducible from the repository plus the
runner process environment alone.

Acceptance:
1. Automated test: the claude argv built by the adapter contains
   `--setting-sources project,local` and `--settings` pointing at the
   repo-versioned platform settings file, and no CLAUDE_CONFIG_DIR appears in
   the claude child environment.
2. Automated test: when the runner process environment carries HTTP_PROXY,
   HTTPS_PROXY or NO_PROXY, the claude and codex child environments carry the
   same values.
3. Automated test: a codex session's child environment contains CODEX_HOME
   pointing inside the session root; the root contains the baseline config.toml
   and a copy of auth.json, and contains no AGENTS.md.
4. Automated test: a successful run removes the codex session config root; a
   failed run retains it and the run's failure information includes its path.
5. Automated test: a codex config-root creation failure or auth.json copy
   failure produces a PROVISION-phase failure and no CLI process is spawned
   against the host ~/.codex.
6. One-time verification recorded in the pull request: a headless claude
   session launched the way the runner launches it, asked whether its
   instructions contain the operator global rules (reply-in-Chinese, Clash
   Verge, commit author mosonlab), answers no; the same probe without
   `--setting-sources project,local` answers yes. This probe requires no
   credential and no operator interaction.
7. Existing runner package tests (under a scratch RUNNER_WORKSPACE_ROOT) pass.
