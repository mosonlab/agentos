Auto-deploy is bootstrap-blocked whenever a commit adds, removes, or renames a file under packages/runner/runtime-tools/.

Observed 2026-09-02: after main added packages/runner/runtime-tools/git-credential-runner.sh (commit 8c52e9a8), every auto-deploy tick failed with release-artifact-runtime-incomplete: packages/runner/dist/runtime-tools-inventory-mismatch, and escalation does not self-clear, so the host stopped deploying entirely.

Root cause: launchd runs current/scripts/deploy/quiet-window-deploy.mjs, which calls join(SCRIPT_DIR, 'build-release-artifact.mjs') -- the already-deployed release's copy. So RUNTIME_TOOL_ENTRIES in release-artifact.mjs always comes from the previous build, while the tree being verified is the new target commit. The target tree already carried the correct three-entry inventory; the stale verifier only knew two.

This is structural, not incidental: every runtime-tool inventory change costs one manual cross-version deploy. It was cleared this time by staging the target tree's scripts/deploy/ and running it with AGENTOS_REPOSITORY_ROOT pointed at the production checkout.

Acceptance criteria:
- The release artifact verification uses the release-artifact.mjs from the target commit being built, not from the currently deployed release.
- Adding a file under packages/runner/runtime-tools/ in a commit deploys through auto-deploy with no operator action.
- The change keeps the existing rejections intact: a misplaced runtime-tools component, a symlink alias to the canonical tree, and a missing or non-regular tool file all still fail the build.

Out of scope: the runner drain roll, shipping runtime-tools separately from the release bundle, the maintenance lock, migrations, and any change to what the release artifact contains beyond using the target tree's own verifier.