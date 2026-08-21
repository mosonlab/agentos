# Shared by the local-side gate-worker scripts (mirror-push.sh, remote-gate.sh,
# gate-dispatch.sh). Not executable on its own; source it.
#
# The repository's identity on the worker is the origin repository's name, not
# the checkout's directory name: two worktrees of one repository must land in
# one mirror, and renaming a local directory must not orphan the mirror it has
# been pushing to. A checkout with no origin falls back to its directory name,
# which is the best identity it has.
gate_repo_name() {
  local root="$1" url="" name=""
  url="$(git -C "$root" remote get-url origin 2>/dev/null || true)"
  if [ -n "$url" ]; then
    name="${url%/}"
    name="${name%.git}"
    name="${name##*/}"
    name="${name##*:}"
  else
    name="$(basename "$(cd "$root" && pwd -P)")"
  fi
  # The name becomes a path segment on the worker and travels through an ssh
  # command line, so anything outside this character set is refused, not quoted.
  case "$name" in
    ''|-*|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
  printf '%s' "$name"
}
