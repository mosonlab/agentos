#!/usr/bin/env bash

# Authenticate the narrow Regression bypass by its process ancestry. The
# environment value is only a request; AGENTOS_TOOLS identifies the
# runner-provided script that must actually be present in the parent chain.
agentos_regression_bypass_is_authenticated() {
  AGENTOS_RUN_SCOPE_CALLER_COMMAND="unreadable process $$"

  [[ "${AGENTOS_RUN_SCOPE_BYPASS:-}" == "regression-verification" ]] || return 1

  local expected_script="${AGENTOS_TOOLS:-}"
  expected_script="${expected_script%/}/regression-verification.sh"
  local ps_command
  local current_pid="$$"
  local process_record
  local parent_pid
  local process_name
  local command_line
  local command_word
  local -a command_words
  local depth=0

  if [[ -x /bin/ps ]]; then
    ps_command=/bin/ps
  elif [[ -x /usr/bin/ps ]]; then
    ps_command=/usr/bin/ps
  else
    return 1
  fi

  # Find the immediate parent first; authentication considers parents only.
  process_record="$("$ps_command" -ww -p "$current_pid" -o ppid= -o ucomm= -o command= 2>/dev/null)" || return 1
  [[ -n "$process_record" ]] || return 1
  read -r parent_pid process_name command_line <<< "$process_record"
  [[ "$parent_pid" =~ ^[0-9]+$ && -n "$process_name" && -n "$command_line" ]] || return 1
  current_pid="$parent_pid"

  while [[ "$current_pid" =~ ^[0-9]+$ ]] && (( current_pid > 1 && depth < 128 )); do
    process_record="$("$ps_command" -ww -p "$current_pid" -o ppid= -o ucomm= -o command= 2>/dev/null)" || return 1
    [[ -n "$process_record" ]] || return 1
    read -r parent_pid process_name command_line <<< "$process_record"
    [[ "$parent_pid" =~ ^[0-9]+$ && -n "$process_name" && -n "$command_line" ]] || return 1
    if (( depth == 0 )); then
      AGENTOS_RUN_SCOPE_CALLER_COMMAND="$command_line"
    fi

    if [[ -n "${AGENTOS_TOOLS:-}" && "$process_name" == "bash" ]]; then
      read -r -a command_words <<< "$command_line"
      for command_word in "${command_words[@]:1}"; do
        # The script path must be Bash's first non-option argument. This rejects
        # command strings, stdin programs and argv[0] spoofing without narrowing
        # legitimate `bash -x /runner/tools/regression-verification.sh` calls.
        case "$command_word" in
          -c|--command|-s|-) break ;;
        esac
        if [[ "$command_word" != -* ]]; then
          [[ "$command_word" == "$expected_script" ]] && return 0
          break
        fi
      done
    fi

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
