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
  local emitter node_binary listing diagnostics status label unit plist index

  emitter="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service-inventory.mjs"
  if ! node_binary="$(command -v node)"; then
    printf 'service-inventory-node-unavailable\n' >&2
    return 64
  fi
  # The emitter's stderr is kept out of the listing. A Node warning carries no
  # tab, so merging the two streams would append it as an entry with no unit
  # and no plist name instead of showing it to the operator.
  if ! diagnostics="$(mktemp "${TMPDIR:-/tmp}/agentos-service-inventory.XXXXXX")"; then
    printf 'service-inventory-tempfile-unavailable\n' >&2
    return 64
  fi
  listing="$("$node_binary" "$emitter" 2>"$diagnostics")" && status=0 || status=$?
  if [ -s "$diagnostics" ]; then
    cat "$diagnostics" >&2
  fi
  rm -f "$diagnostics"
  if [ "$status" -ne 0 ]; then
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

# True when the loaded inventory contains one label. A control-plane label is
# absent from a runner-role host's inventory, and a caller that only checks a
# service this host runs asks this before looking the entry up.
agentos_service_inventory_has_label() {
  local wanted="$1" index

  for index in "${!AGENTOS_SERVICE_LABELS[@]}"; do
    if [ "${AGENTOS_SERVICE_LABELS[$index]}" = "$wanted" ]; then
      return 0
    fi
  done
  return 1
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
