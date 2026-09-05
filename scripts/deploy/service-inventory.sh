#!/bin/bash
# Read the deployed service inventory for shell entrypoints.
#
# service-inventory.mjs is the only generator of labels, unit names, plist
# names and runner indexes; this helper exists so os-isolation scripts consume
# that inventory instead of each re-spelling the mapping.
#
# agentos_load_service_inventory populates, in inventory order:
#   AGENTOS_SERVICE_LABELS AGENTOS_SERVICE_UNITS AGENTOS_SERVICE_PLISTS
# and, indexed by runner index (1-based):
#   AGENTOS_RUNNER_LABELS AGENTOS_RUNNER_UNITS AGENTOS_RUNNER_PLISTS
#   AGENTOS_RUNNER_SERVICE_COUNT
agentos_load_service_inventory() {
  local emitter node_binary listing label unit plist index

  emitter="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service-inventory.mjs"
  if ! node_binary="$(command -v node)"; then
    printf 'service-inventory-node-unavailable\n' >&2
    return 64
  fi
  if ! listing="$("$node_binary" "$emitter" 2>&1)"; then
    printf '%s\n' "$listing" >&2
    return 64
  fi

  AGENTOS_SERVICE_LABELS=()
  AGENTOS_SERVICE_UNITS=()
  AGENTOS_SERVICE_PLISTS=()
  AGENTOS_RUNNER_LABELS=()
  AGENTOS_RUNNER_UNITS=()
  AGENTOS_RUNNER_PLISTS=()
  AGENTOS_RUNNER_SERVICE_COUNT=0
  while IFS=$'\t' read -r label unit plist index _; do
    [ -n "$label" ] || continue
    AGENTOS_SERVICE_LABELS+=("$label")
    AGENTOS_SERVICE_UNITS+=("$unit")
    AGENTOS_SERVICE_PLISTS+=("$plist")
    if [ -n "$index" ]; then
      AGENTOS_RUNNER_LABELS[$index]="$label"
      AGENTOS_RUNNER_UNITS[$index]="$unit"
      AGENTOS_RUNNER_PLISTS[$index]="$plist"
      AGENTOS_RUNNER_SERVICE_COUNT=$((AGENTOS_RUNNER_SERVICE_COUNT + 1))
    fi
  done <<< "$listing"

  if [ "${#AGENTOS_SERVICE_LABELS[@]}" -eq 0 ]; then
    printf 'service-inventory-empty\n' >&2
    return 64
  fi
}

# Print the installed wrapper path for one repository root. The wrapper is
# installed outside any release, and only service-inventory.mjs spells where.
agentos_service_wrapper_path() {
  local emitter node_binary

  emitter="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service-inventory.mjs"
  if ! node_binary="$(command -v node)"; then
    printf 'service-inventory-node-unavailable\n' >&2
    return 64
  fi
  "$node_binary" "$emitter" --wrapper-path "$1"
}

# Set AGENTOS_SERVICE_UNIT and AGENTOS_SERVICE_PLIST for one label. A label the
# inventory does not contain is a refusal, not a silently skipped check.
agentos_service_entry_for_label() {
  local wanted="$1" index

  for index in "${!AGENTOS_SERVICE_LABELS[@]}"; do
    if [ "${AGENTOS_SERVICE_LABELS[$index]}" = "$wanted" ]; then
      AGENTOS_SERVICE_UNIT="${AGENTOS_SERVICE_UNITS[$index]}"
      AGENTOS_SERVICE_PLIST="${AGENTOS_SERVICE_PLISTS[$index]}"
      return 0
    fi
  done
  printf 'service-label-unknown:%s\n' "$wanted" >&2
  return 64
}
