#!/usr/bin/env bash

# Authenticate the narrow Regression bypass by its process ancestry. The
# environment value is only a request; AGENTOS_TOOLS identifies the
# runner-provided script that must actually be present in the parent chain.
agentos_regression_bypass_is_authenticated() {
  AGENTOS_RUN_SCOPE_CALLER_COMMAND="unreadable process $$"

  [[ "${AGENTOS_RUN_SCOPE_BYPASS:-}" == "regression-verification" ]] || return 1
  [[ -n "${AGENTOS_TOOLS:-}" ]] || return 1

  local expected_script="${AGENTOS_TOOLS%/}/regression-verification.sh"
  local current_pid="$$"
  local process_record
  local parent_pid
  local command_line
  local command_word
  local -a command_words
  local depth=0

  # Capture this process for the audit line, then authenticate parents only.
  process_record="$(/bin/ps -ww -p "$current_pid" -o ppid= -o command= 2>/dev/null)" || return 1
  [[ -n "$process_record" ]] || return 1
  read -r parent_pid command_line <<< "$process_record"
  [[ "$parent_pid" =~ ^[0-9]+$ && -n "$command_line" ]] || return 1
  current_pid="$parent_pid"

  while [[ "$current_pid" =~ ^[0-9]+$ ]] && (( current_pid > 1 && depth < 128 )); do
    process_record="$(/bin/ps -ww -p "$current_pid" -o ppid= -o command= 2>/dev/null)" || return 1
    [[ -n "$process_record" ]] || return 1
    read -r parent_pid command_line <<< "$process_record"
    [[ "$parent_pid" =~ ^[0-9]+$ && -n "$command_line" ]] || return 1
    if (( depth == 0 )); then
      AGENTOS_RUN_SCOPE_CALLER_COMMAND="$command_line"
    fi

    read -r -a command_words <<< "$command_line"
    if [[ "${command_words[0]:-}" == "$expected_script" ]]; then
      return 0
    fi
    case "${command_words[0]:-}" in
      bash|*/bash)
        for command_word in "${command_words[@]:1}"; do
          # A command string can mention any path without executing it.
          [[ "$command_word" == "-c" || "$command_word" == "--command" ]] && break
          [[ "$command_word" == "$expected_script" ]] && return 0
        done
        ;;
    esac

    [[ "$parent_pid" != "$current_pid" ]] || return 1
    current_pid="$parent_pid"
    depth=$((depth + 1))
  done

  return 1
}

agentos_regression_bypass_audit_refusal() {
  printf 'run-scope-bypass: refused forged Regression bypass from caller: %s\n' \
    "${AGENTOS_RUN_SCOPE_CALLER_COMMAND:-unreadable process $$}" >&2
}
