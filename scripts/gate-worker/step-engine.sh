# The gate's step engine: what it means to run a step, to run a group of steps
# at once, and what the run's outcome is when it ends. Sourced by merge-gate.sh
# and by scripts/merge-gate-parallel.test.mjs. Not executable on its own.
#
# Two things the caller owes this file. It must have sourced lib.sh first, for
# GATE_EXIT_NO_VERDICT. And it must define `say` and `note`, the two output
# helpers a step announces itself through; they are the gate's log format, not
# the engine's, and the fixtures supply their own.
#
# Not here: which steps the gate runs, in what order, and in which group. That
# is the plan, it lives in merge-gate.sh where an operator reads it, and this
# file knows nothing about it.
#
# Deliberately not in lib.sh. lib.sh is installed on the worker beside
# run-gate.sh and carries the verdict's wire format, which run-gate.sh and
# gate-dispatch.sh read. Neither of them runs a step, and neither should be
# shipped the gate's state machine to find that out. merge-gate.sh is the
# opposite case: run-gate.sh creates a worktree from the mirror at the
# candidate oid and runs scripts/merge-gate.sh inside it, so what merge-gate.sh
# sources out of the repository tree arrives with the commit. This file
# therefore travels with the commit and is not installed on the worker.

# The engine's state. Every one of these is read back through gate_steps_report
# and gate_steps_outcome; nothing outside this file needs to know they exist.
gate_steps_begin() {
  # What each step reported: one preformatted line per step, in the order the
  # steps were submitted.
  STEP_REPORT=()
  # Where the gate is. Set on entry to a step and cleared when it passes, so a
  # run that dies anywhere still names the step it died in.
  FAILED_STEP=""
  # Set only when the run was stopped rather than decided. It is what turns the
  # last line into GATE NOT RUN instead of a FAIL nothing formed.
  NO_VERDICT_REASON=""
  NO_VERDICT_EXIT="${GATE_EXIT_NO_VERDICT}"
  # Named the moment a step is seen to have failed on its own, which is earlier
  # than its group's accounting: a signal arriving while a later member is still
  # stuck must not erase a failure this run already observed.
  GATE_REAL_FAILURE=""
  # The members a parallel group has in flight. See gate_steps_stop_running.
  GATE_GROUP_PIDS=()
}

# A step that was stopped from outside against one that failed on its own. The
# first set is what an operator, a supervisor or the OOM killer sends: nothing
# was learned about the commit, so the run has no verdict to give. A crash the
# step produced itself (SIGSEGV, SIGABRT, SIGBUS, SIGFPE) is the code under test
# behaving badly and stays a FAIL, which is the direction this is allowed to be
# wrong in: it never converts a real failure into an errand.
stopped_from_outside() {
  case "$1" in
    129 | 130 | 131 | 137 | 143) return 0 ;;
    *) return 1 ;;
  esac
}

record_stop() {
  NO_VERDICT_REASON="${1} was stopped before it could be judged"
  NO_VERDICT_EXIT="${GATE_EXIT_NO_VERDICT}"
}

record_real_failure() {
  GATE_REAL_FAILURE="${GATE_REAL_FAILURE:+${GATE_REAL_FAILURE}, }${1}"
}

step() {
  local label="$1"; shift
  say "${label}"
  local started; started=$(date +%s)
  FAILED_STEP="${label}"
  local status=0
  ( cd "${REPO_ROOT}" && "$@" ) || status=$?
  if [ "${status}" -ne 0 ]; then
    if stopped_from_outside "${status}"; then
      STEP_REPORT+=("STOP  ${label}")
      record_stop "${label}"
    else
      STEP_REPORT+=("FAIL  ${label}")
      record_real_failure "${label}"
    fi
    return 1
  fi
  STEP_REPORT+=("$(printf 'ok    %-42s %4ss' "${label}" "$(( $(date +%s) - started ))")")
  FAILED_STEP=""
}

# Run independent steps at the same time.
#
# Members are separated by `::`: each one is a label followed by the command it
# runs, exactly as `step` takes them. Nothing about what a step proves changes
# here — only how many of them are in flight at once. The gate is a chain of
# eighteen serial steps on a worker with twelve cores, and for most of a run
# eleven of them have nothing to do.
#
# Two properties this has to keep, because a parallel group is where both are
# normally lost:
#
# Output stays readable. Each member writes to its own file and the files are
# replayed in submission order after the group finishes, so the log reads like
# the serial steps it replaced instead of interleaved fragments from a dozen
# processes. `parallel_lint` already worked this way; this is that pattern with
# more than two members.
#
# Every failure is named, not just the first. A group that stopped at the
# earliest non-zero status would send someone back for a second gate to find
# the second problem, and running these together is precisely what makes it
# cheap to learn all of them in one pass. Each member is waited for, each keeps
# its own duration, and the verdict line lists all of them.
GATE_STEP_SEPARATOR="::"

# The members a parallel group has in flight. cleanup has to be able to reach
# them: it deletes GATE_TMP, releases the worktree lock and removes the
# postgres container, and each of those is a statement that this gate has
# stopped working. `kill` on this script alone interrupts the parent's `wait`
# without touching the members, so the teardown would run while a build is
# still writing dist/ and the next gate would take the lock this one just
# released. The serial layout this replaced had one child at a time and no log
# of its own to delete; nine at once is worth the accounting.

# Signalling the member alone is not enough, and the shape of the miss is easy
# to reproduce: the member is a subshell, the work it runs is a process below
# that, and `npm ci` or `tsc` is a process below *that*. Killing the member
# leaves the rest orphaned and running. So members are started under `set -m`,
# which makes each one a process-group leader, and the whole group is signalled
# at once.
gate_steps_stop_running() {
  [ "${#GATE_GROUP_PIDS[@]}" -gt 0 ] || return 0
  local group alive attempt
  printf '\n   interrupted: stopping %s step(s) still running\n' "${#GATE_GROUP_PIDS[@]}"
  for group in "${GATE_GROUP_PIDS[@]}"; do kill -TERM -"${group}" 2>/dev/null || true; done
  # Five seconds to end on their own, then stop asking. Waiting without a
  # deadline hands a member that ignores TERM the power to hang the gate
  # forever, which is worse than the leak this is closing.
  for ((attempt=0; attempt<50; attempt++)); do
    alive=0
    for group in "${GATE_GROUP_PIDS[@]}"; do kill -0 -"${group}" 2>/dev/null && alive=1; done
    [ "${alive}" -eq 0 ] && break
    sleep 0.1
  done
  for group in "${GATE_GROUP_PIDS[@]}"; do kill -KILL -"${group}" 2>/dev/null || true; done
  # Reaped, not just signalled: returning while they are still dying is the
  # race this exists to close.
  for group in "${GATE_GROUP_PIDS[@]}"; do wait "${group}" 2>/dev/null || true; done
  GATE_GROUP_PIDS=()
}

parallel_steps() {
  local title="$1"; shift
  local -a labels=() serialized=() pids=() statuses=() logs=() current=() failures=() stopped=()
  local token index slot seconds

  for token in "$@" "${GATE_STEP_SEPARATOR}"; do
    if [ "${token}" = "${GATE_STEP_SEPARATOR}" ]; then
      if [ "${#current[@]}" -gt 0 ]; then
        [ "${#current[@]}" -ge 2 ] \
          || { printf 'parallel_steps: member "%s" names no command\n' "${current[0]}" >&2; return 1; }
        labels+=("${current[0]}")
        # %q quoting is produced by bash for bash, so the eval below restores
        # exactly this argument vector. Every member here is a literal in this
        # file; none of it comes from the commit being gated.
        serialized+=("$(printf '%q ' "${current[@]:1}")")
        current=()
      fi
      continue
    fi
    current+=("${token}")
  done
  [ "${#labels[@]}" -gt 0 ] || { printf 'parallel_steps: %s has no members\n' "${title}" >&2; return 1; }

  # Set before anything is spawned: if this group dies without reaching its own
  # accounting, the verdict still names where the gate was.
  FAILED_STEP="${title}"
  say "${title} (${#labels[@]} steps at once)"

  for ((index=0; index<${#labels[@]}; index++)); do
    slot="$(printf '%s' "${labels[index]}" | tr -c '[:alnum:]' '-')"
    logs[index]="${GATE_TMP}/group-${index}-${slot}.log"
    # The member times itself. Timing it from here would charge each member for
    # however long the parent happened to wait on the members before it.
    # Job control, on for the spawn only: it is what puts the member and
    # everything it starts into one process group gate_steps_stop_running can
    # reach. It changes nothing on the normal path -- exit codes still arrive
    # through `wait`, and a group that ends on its own prints nothing.
    set -m
    (
      cd "${REPO_ROOT}" || exit 1
      __started=$(date +%s)
      eval "${serialized[index]}"
      __status=$?
      printf '%s\n' "$(( $(date +%s) - __started ))" > "${logs[index]}.seconds"
      exit "${__status}"
    ) >"${logs[index]}" 2>&1 &
    pids[index]=$!
    GATE_GROUP_PIDS+=("$!")
    set +m
    note "started ${labels[index]}"
  done

  # The member's own status, not a flattened 1: 128+N is how a member that was
  # killed is told apart from one that ran and failed, and the difference is
  # whether this group has a verdict at all.
  for ((index=0; index<${#labels[@]}; index++)); do
    if wait "${pids[index]}"; then statuses[index]=0; else statuses[index]=$?; fi
    # Recorded here rather than in the accounting below, which a signal arriving
    # while a later member is still stuck would never reach.
    if [ "${statuses[index]}" -ne 0 ] && ! stopped_from_outside "${statuses[index]}"; then
      record_real_failure "${labels[index]}"
    fi
  done
  GATE_GROUP_PIDS=()

  for ((index=0; index<${#labels[@]}; index++)); do
    printf '\n--- %s ---\n' "${labels[index]}"
    cat "${logs[index]}" 2>/dev/null || true
  done

  for ((index=0; index<${#labels[@]}; index++)); do
    # A member killed before it could write its own duration reports `?` rather
    # than a number this run did not measure.
    seconds="$(cat "${logs[index]}.seconds" 2>/dev/null || printf '?')"
    [ -n "${seconds}" ] || seconds="?"
    if [ "${statuses[index]}" -eq 0 ]; then
      STEP_REPORT+=("$(printf 'ok    %-42s %4ss' "${labels[index]}" "${seconds}")")
    elif stopped_from_outside "${statuses[index]}"; then
      STEP_REPORT+=("$(printf 'STOP  %-42s %4ss' "${labels[index]}" "${seconds}")")
      stopped+=("${labels[index]}")
    else
      STEP_REPORT+=("$(printf 'FAIL  %-42s %4ss' "${labels[index]}" "${seconds}")")
      failures+=("${labels[index]}")
    fi
  done

  # A member that ran and failed is a judgement about the commit and outranks a
  # member that was stopped: the gate did learn something, and burying that
  # under "no verdict" would let a real FAIL be re-dispatched as an errand.
  if [ "${#failures[@]}" -gt 0 ]; then
    FAILED_STEP="$(printf '%s, ' "${failures[@]}")"
    FAILED_STEP="${FAILED_STEP%, }"
    return 1
  fi
  if [ "${#stopped[@]}" -gt 0 ]; then
    FAILED_STEP="$(printf '%s, ' "${stopped[@]}")"
    FAILED_STEP="${FAILED_STEP%, }"
    record_stop "${FAILED_STEP}"
    return 1
  fi
  FAILED_STEP=""
}

# What a signal that stopped the gate is, recorded rather than judged: whether
# it outranks anything is gate_steps_outcome's question and is answered there
# once. The caller keeps its trap handlers, because a trap has to exit in the
# gate's own process.
gate_steps_note_signal() {
  NO_VERDICT_REASON="the gate was stopped by SIG${1}${FAILED_STEP:+ during ${FAILED_STEP}}"
  NO_VERDICT_EXIT="$2"
}

# Every step's result, in submission order, ready to print.
gate_steps_report() {
  [ "${#STEP_REPORT[@]}" -gt 0 ] || return 0
  local line
  for line in "${STEP_REPORT[@]}"; do printf '   %s\n' "${line}"; done
}

# What this run learned about the commit, as one line:
#
#   pass
#   fail <step>[, <step>...]
#   no-verdict <exit> <reason>
#
# The order of these three branches is the engine's whole rule and is stated
# here and nowhere else. A failure the run actually observed is a judgement
# about the commit, and neither a signal arriving afterwards nor a member that
# was stopped unmakes it — that is the direction this is allowed to be wrong
# in, because the opposite lets a real FAIL be re-dispatched as an errand. Only
# a run that learned nothing reports the absence of a verdict.
gate_steps_outcome() {
  if [ -n "${GATE_REAL_FAILURE}" ]; then
    printf 'fail %s\n' "${GATE_REAL_FAILURE}"
  elif [ -n "${NO_VERDICT_REASON}" ]; then
    printf 'no-verdict %s %s\n' "${NO_VERDICT_EXIT}" "${NO_VERDICT_REASON}"
  elif [ -n "${FAILED_STEP}" ]; then
    printf 'fail %s\n' "${FAILED_STEP}"
  else
    printf 'pass\n'
  fi
}
