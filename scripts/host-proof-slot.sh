#!/usr/bin/env bash

# A host invocation is deliberately handled before this file inspects any
# argument or environment value other than the two admission switches.  npm
# already started this shell, so this path must not add a process, a stat, or a
# lock-file touch before replacing it with the requested command.

host_proof_slot_exec_child() {
  # The public contract is <script> <workspace> -- <command> [args...].  The
  # contract is valid on the fast path; shift is a shell builtin and exec is a
  # shell builtin, so the wrapper contributes no observable output here.
  shift 3
  exec "$@"
}

if [[ -z "${AGENTOS_RUN_ID:-}" || "${AGENTOS_RUN_SCOPE_BYPASS:-}" == "regression-verification" ]]; then
  host_proof_slot_exec_child "$@"
fi

# These two functions are intentionally small source seams.  Production uses
# the target macOS utilities; the standalone test sources this file and
# replaces them with a deterministic clock and wait, without adding a
# production environment switch or a dependency to the wrapper.
host_proof_slot_set_now() {
  HOST_PROOF_SLOT_NOW=$(/bin/date +%s) || return $?
}

host_proof_slot_wait() {
  /bin/sleep 1
}

host_proof_slot_invalid() {
  # Setup failures are deliberately non-zero and otherwise quiet.  The only
  # wrapper diagnostic promised by the contract is the timeout line below;
  # lockf and command failures retain their own status and output.
  return 64
}

host_proof_slot_try() {
  local slot_file="$1"
  shift
  HOST_PROOF_SLOT_ACQUIRED=0

  # Read-only opening is intentional: it cannot create a missing file.  The
  # daemon creates all persistent files before any Run can reach this code.
  # The descriptor remains open in this shell after lockf exits, which keeps
  # the kernel lock held while the complete child command runs.
  if ! exec 9<"$slot_file"; then
    return 74
  fi

  /usr/bin/lockf -s -t 0 9
  local lock_status=$?
  if (( lock_status != 0 )); then
    exec 9<&-
    return "$lock_status"
  fi

  HOST_PROOF_SLOT_ACQUIRED=1
  "$@"
  local child_status=$?
  exec 9<&-
  return "$child_status"
}

host_proof_slot_main() {
  local script_name="${1:-}"
  local workspace_name="${2:-}"
  local slot_directory="${AGENTOS_HOST_PROOF_SLOT_DIR:-}"
  local slot_count_raw="${AGENTOS_HOST_PROOF_SLOTS:-}"

  # Validate the invocation before any filesystem or tool work.  This path is
  # only reached for an ordinary Run; host and exact Regression-bypass calls
  # have already exec'd their child above.
  if (( $# < 4 )) || [[ "$3" != "--" || -z "$script_name" || -z "$workspace_name" || -z "${4:-}" ]]; then
    host_proof_slot_invalid
    return $?
  fi
  if [[ -z "$slot_directory" || -z "$slot_count_raw" ]]; then
    host_proof_slot_invalid
    return $?
  fi
  if [[ ! "$slot_count_raw" =~ ^[0-9]+$ ]]; then
    host_proof_slot_invalid
    return $?
  fi

  # Bash treats numbers with a leading zero as octal in arithmetic contexts;
  # normalize those zeros while preserving the same decimal contract as the
  # runner's positiveInteger parser.
  local slot_count="$slot_count_raw"
  while [[ "$slot_count" == 0* && ${#slot_count} -gt 1 ]]; do
    slot_count="${slot_count#0}"
  done
  if [[ "$slot_count" == "0" || ${#slot_count} -gt 16 ]] || ! (( 10#$slot_count > 0 )); then
    host_proof_slot_invalid
    return $?
  fi
  # Match the runner's Number.isSafeInteger boundary so an injected unsafe
  # count cannot turn the retry loop into an unbounded arithmetic walk.
  if (( 10#$slot_count > 9007199254740991 )); then
    host_proof_slot_invalid
    return $?
  fi

  if [[ ! -d "$slot_directory" || -L "$slot_directory" || ! -x /usr/bin/lockf || ! -x /bin/sleep ]]; then
    host_proof_slot_invalid
    return $?
  fi

  local slot_number=1
  local slot_file
  while (( slot_number <= 10#$slot_count )); do
    slot_file="${slot_directory}/slot-${slot_number}.lock"
    if [[ ! -f "$slot_file" || -L "$slot_file" ]]; then
      host_proof_slot_invalid
      return $?
    fi
    slot_number=$((slot_number + 1))
  done

  shift 3
  local command_status
  local now_status
  local start_seconds
  local elapsed_seconds
  host_proof_slot_set_now
  now_status=$?
  if (( now_status != 0 )); then
    return "$now_status"
  fi
  start_seconds="$HOST_PROOF_SLOT_NOW"

  while :; do
    host_proof_slot_set_now
    now_status=$?
    if (( now_status != 0 )); then
      return "$now_status"
    fi
    elapsed_seconds=$((HOST_PROOF_SLOT_NOW - start_seconds))
    if (( elapsed_seconds >= 1200 )); then
      printf 'host-proof-slot: %s for workspace %s in Run %s timed out after 1200s waiting in %s\n' \
        "$script_name" "$workspace_name" "$AGENTOS_RUN_ID" "$slot_directory" >&2
      return 75
    fi

    slot_number=1
    while (( slot_number <= 10#$slot_count )); do
      slot_file="${slot_directory}/slot-${slot_number}.lock"
      host_proof_slot_try "$slot_file" "$@"
      command_status=$?
      if (( HOST_PROOF_SLOT_ACQUIRED != 0 )); then
        return "$command_status"
      fi
      # lockf's EX_TEMPFAIL (75) means this candidate is held.  Any other
      # status is a setup/lock failure and must not be mistaken for contention.
      if (( command_status != 75 )); then
        return "$command_status"
      fi
      slot_number=$((slot_number + 1))
    done

    host_proof_slot_wait
    now_status=$?
    if (( now_status != 0 )); then
      return "$now_status"
    fi
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  host_proof_slot_main "$@"
fi
