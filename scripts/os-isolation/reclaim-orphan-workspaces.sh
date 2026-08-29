#!/bin/bash
# Reclaim run workspaces that no runner will ever dispose of.
#
# The API removes nothing at all (issue #115): it publishes a reclaim intent and
# the runner that owns the root disposes of the directory. A runner that died
# mid-run — or one that never comes back — therefore leaves its workspace behind
# for good, because nothing is left to sweep it. This script is the operator's
# way to reclaim exactly those, and nothing else.
#
# It is fail-closed by construction:
#   * it reads the database read-only, and deletes nothing it cannot explain;
#   * a directory the database has never heard of is KEPT, never deleted — that
#     mistake is the 2026-08-18 incident (issue #125) in one sentence;
#   * a run that is active, retained, or ended less than --older-than-hours ago
#     is kept;
#   * a directory whose owner is not one of the runner accounts is kept;
#   * deletion runs as the *owning account*, through the same sudo grant the
#     runners use, so this script can never remove something the isolation was
#     supposed to protect from it.
#
#   scripts/os-isolation/reclaim-orphan-workspaces.sh                 # dry run: the list and the reasons
#   scripts/os-isolation/reclaim-orphan-workspaces.sh --apply
#   scripts/os-isolation/reclaim-orphan-workspaces.sh --older-than-hours 72 --limit 20 --apply
#
# Procedure, thresholds, and what to do afterwards:
# the operator-run reclaim pass
set -uo pipefail

APPLY=0
OLDER_THAN_HOURS="${OLDER_THAN_HOURS:-24}"
LIMIT="${LIMIT:-50}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --older-than-hours) OLDER_THAN_HOURS="${2:-}"; shift ;;
    --limit) LIMIT="${2:-}"; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done

RUNNER_COUNT="${RUNNER_COUNT:-8}"
ACCOUNT_PREFIX="${ACCOUNT_PREFIX:-_agentos}"
AGENTOS_PREFIX="${AGENTOS_PREFIX:-/opt/agentos}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$AGENTOS_PREFIX/runs}"

if [ "$(id -u)" = 0 ]; then
  # As root every keep rule above becomes advisory: a bug would delete anything.
  echo "Do not run this as root. Run it as the operator; deletions go through sudo to the owning account." >&2
  exit 64
fi
case "$OLDER_THAN_HOURS" in ''|*[!0-9]*) echo "--older-than-hours needs a whole number" >&2; exit 64 ;; esac
case "$LIMIT" in ''|*[!0-9]*) echo "--limit needs a whole number" >&2; exit 64 ;; esac
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set. This script reads the control-plane database; it never writes to it." >&2
  exit 64
fi
command -v psql >/dev/null 2>&1 || { echo "psql is not on PATH" >&2; exit 64; }
[ -d "$WORKSPACE_ROOT" ] || { echo "$WORKSPACE_ROOT does not exist" >&2; exit 64; }

kept=0
reclaimed=0
failed=0
skipped_over_limit=0
report() { printf '  %-8s %-28s %s\n' "$1" "$2" "$3"; }

printf 'Anneal orphan workspace reclamation — %s\n' "$([ "$APPLY" = 1 ] && echo APPLY || echo 'dry run (nothing is deleted)')"
printf '  root        : %s\n' "$WORKSPACE_ROOT"
printf '  age cutoff  : ended more than %s hour(s) ago\n' "$OLDER_THAN_HOURS"
printf '  limit       : %s director(ies) per run\n\n' "$LIMIT"

candidates=()
while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  candidates+=("$dir")
done < <(find "$WORKSPACE_ROOT" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort)

if [ "${#candidates[@]}" -eq 0 ]; then
  echo "Nothing under $WORKSPACE_ROOT."
  exit 0
fi

# One query for every candidate, quoted as literals. Ids that do not look like
# ids never reach it: a directory name is attacker-influenced input the moment an
# agent can create entries in the shared root (plan §8, item 2).
ids=""
for dir in "${candidates[@]}"; do
  name="$(basename "$dir")"
  case "$name" in
    *[!A-Za-z0-9_-]*) continue ;;
  esac
  ids="$ids${ids:+,}'$name'"
done
rows=""
if [ -n "$ids" ]; then
  query_status=0
  rows="$(psql "$DATABASE_URL" -Atq -F $'\t' -c "
    SELECT r.id,
           r.status,
           r.\"workspaceRetained\",
           coalesce(r.\"workspacePath\", ''),
           coalesce(to_char(r.\"endedAt\", 'YYYY-MM-DD\"T\"HH24:MI:SS'), ''),
           coalesce(extract(epoch from (now() - r.\"endedAt\"))::bigint::text, '')
      FROM \"Run\" r
     WHERE r.id IN ($ids);")" || query_status=$?
  if [ "$query_status" != 0 ]; then
    # Treating an unreachable database as "no rows" would turn every directory
    # into an unknown one — and the unknown rule is the only thing keeping this
    # script away from live workspaces.
    echo "The database query failed (psql exit $query_status). Nothing was changed." >&2
    exit 1
  fi
fi

lookup() { printf '%s\n' "$rows" | awk -F'\t' -v id="$1" '$1 == id { print; exit }'; }

for dir in "${candidates[@]}"; do
  name="$(basename "$dir")"
  if [ -L "$dir" ]; then
    kept=$((kept + 1)); report KEEP "$name" "it is a symlink, not a run directory"; continue
  fi
  owner="$(stat -f '%Su' "$dir" 2>/dev/null)"
  index="${owner#"$ACCOUNT_PREFIX"}"
  case "$owner" in
    "$ACCOUNT_PREFIX"[0-9]*) ;;
    *) kept=$((kept + 1)); report KEEP "$name" "owned by '$owner', not a runner account"; continue ;;
  esac
  case "$index" in
    ''|*[!0-9]*) kept=$((kept + 1)); report KEEP "$name" "owner '$owner' is not one of $ACCOUNT_PREFIX""1..$RUNNER_COUNT"; continue ;;
  esac
  if [ "$index" -lt 1 ] || [ "$index" -gt "$RUNNER_COUNT" ]; then
    kept=$((kept + 1)); report KEEP "$name" "owner '$owner' is outside 1..$RUNNER_COUNT"; continue
  fi
  row="$(lookup "$name")"
  if [ -z "$row" ]; then
    # The keep-unknown-directory rule, restated here so this script cannot become
    # the thing that deletes a live workspace a mispointed database forgot about.
    kept=$((kept + 1)); report KEEP "$name" "no such run in this database — investigate before removing anything"; continue
  fi
  status="$(printf '%s' "$row" | awk -F'\t' '{print $2}')"
  retained="$(printf '%s' "$row" | awk -F'\t' '{print $3}')"
  workspace_path="$(printf '%s' "$row" | awk -F'\t' '{print $4}')"
  ended_at="$(printf '%s' "$row" | awk -F'\t' '{print $5}')"
  age_seconds="$(printf '%s' "$row" | awk -F'\t' '{print $6}')"
  case "$status" in
    queued|claimed|provisioning|running|waiting-inbox)
      kept=$((kept + 1)); report KEEP "$name" "run is $status — deleting it would break a live run"; continue ;;
  esac
  if [ "$retained" = "t" ]; then
    kept=$((kept + 1)); report KEEP "$name" "workspaceRetained: kept on purpose for inspection"; continue
  fi
  if [ -n "$workspace_path" ] && [ "$workspace_path" != "$WORKSPACE_ROOT/$name" ]; then
    kept=$((kept + 1)); report KEEP "$name" "workspacePath '$workspace_path' is not the canonical path — provisioning anomaly"; continue
  fi
  if [ -z "$ended_at" ] || [ -z "$age_seconds" ]; then
    kept=$((kept + 1)); report KEEP "$name" "run is $status but has no endedAt; cannot age it"; continue
  fi
  if [ "$age_seconds" -lt $((OLDER_THAN_HOURS * 3600)) ]; then
    kept=$((kept + 1)); report KEEP "$name" "$status $((age_seconds / 3600))h ago, younger than the $OLDER_THAN_HOURS""h cutoff"; continue
  fi
  if [ "$reclaimed" -ge "$LIMIT" ]; then
    skipped_over_limit=$((skipped_over_limit + 1)); continue
  fi
  if [ "$APPLY" != 1 ]; then
    reclaimed=$((reclaimed + 1)); report PLAN "$name" "$status, ended $ended_at, owner $owner"; continue
  fi
  # As the owner, never as the operator: this is the same grant the runner uses,
  # and it means a bug here cannot reach anything isolation protects.
  if sudo -n -u "$owner" /bin/rm -rf -- "$dir" 2>/dev/null && [ ! -d "$dir" ]; then
    reclaimed=$((reclaimed + 1)); report REMOVED "$name" "$status, ended $ended_at, owner $owner"
  else
    failed=$((failed + 1)); report FAILED "$name" "sudo -u $owner rm -rf did not remove it; check the sudoers grant"
  fi
done

echo
printf 'kept %s   %s %s   failed %s\n' "$kept" "$([ "$APPLY" = 1 ] && echo removed || echo reclaimable)" "$reclaimed" "$failed"
if [ "$skipped_over_limit" -gt 0 ]; then
  # Never silently: a truncated list reads like "that was all of them".
  printf '%s more director(ies) qualified but were not touched because of --limit %s.\n' "$skipped_over_limit" "$LIMIT"
fi
if [ "$APPLY" = 1 ] && [ "$reclaimed" -gt 0 ]; then
  echo
  echo "Sessions for the reclaimed runs still read cleanupStatus='pending' or 'failed',"
  echo "because no runner reported them. Clear them with the statement in the 'After reclaiming' section of"
  echo "Reclaim is an operator action — this script never writes to the database."
fi
[ "$failed" -eq 0 ] || exit 1
