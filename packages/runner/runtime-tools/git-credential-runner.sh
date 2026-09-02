#!/usr/bin/env bash
# Git credential helper for an Agent session whose HOME has been relocated.
#
# Codex and PI move HOME to a per-session config root so user-level skill
# discovery stays isolated (see adapters/codex.ts). The runner keeps Git's own
# configuration reachable by pinning GIT_CONFIG_GLOBAL to the runner account's
# absolute path -- but a credential helper declared there resolves its own
# state through HOME, so that pin preserves the declaration and not the answer.
# A public remote never noticed, because it needs no credential at all; a
# private one failed every session with "could not read Username".
#
# The answer comes from asking Git again with the runner account's home
# restored. The runner-owned GIT_CONFIG_* overrides are environment variables,
# so an inner git would load this helper again: dropping them is what stops the
# recursion at one level, and it also restores the account's own
# GIT_CONFIG_GLOBAL default, which HOME now points at.

set -u

case "${1:-}" in
  get) action=fill ;;
  store) action=approve ;;
  erase) action=reject ;;
  # Git may add helper operations. Declining an unknown one leaves the
  # credential unanswered, which is the same outcome as having no helper.
  *) exit 0 ;;
esac

[ -n "${AGENTOS_RUNNER_HOME:-}" ] \
  || { printf 'git-credential-runner: AGENTOS_RUNNER_HOME is required\n' >&2; exit 1; }

while IFS= read -r name; do
  unset "$name"
done < <(env | sed -n 's/^\(GIT_CONFIG_[A-Za-z0-9_]*\)=.*/\1/p')

export HOME="$AGENTOS_RUNNER_HOME"
exec git credential "$action"
