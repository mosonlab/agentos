#!/usr/bin/env bash
# Goal 5a0 dependency gate — supervisor.
#
# This file is the artifact-hygiene and signal-safety supervisor; the dry checks L, 0, A, C, and B are supplied as the
# GATE_CHECKS entry point, which the supervisor runs as a child.
#
# The evidence destination is governed by binding obligation (a) and implemented
# in scripts/goal-5a0-evidence-destination.sh: the operator supplies
# an allowlisted evidence ROOT, this script creates its own empty leaf beneath
# it, and the copy refuses rather than overwrites. See that file's header for
# why the listing's `mkdir -p` plus `cp -R "$GATE_DIR/."` is not usable.
#
# Usage: goal-5a0-dependency-gate.sh <evidence-root>
#   GOAL5A0_EVIDENCE_ROOTS  colon-separated absolute allowlist (required)
#   GATE_CHECKS             executable running checks L, 0, A, C, B (required)
#
# It prints exactly one of STOPPED_FOR_REROUTE or SAFE_TO_IMPLEMENT, and writes
# nothing to the repository or the working tree.
set -u
set -o pipefail

HERE="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/goal-5a0-evidence-destination.sh
. "$HERE/goal-5a0-evidence-destination.sh"

# 1. Validate the destination FIRST, and create the leaf, so a signal handler
#    always has somewhere safe — and empty — to copy to.
EVIDENCE_ROOT="${1:-}"
if [ -z "$EVIDENCE_ROOT" ]; then echo "STOPPED_FOR_REROUTE evidence root required"; exit 1; fi
goal5a0_validate_evidence_root "$EVIDENCE_ROOT" || { echo "STOPPED_FOR_REROUTE evidence root refused"; exit 1; }
EVIDENCE_DIR="$(goal5a0_create_evidence_leaf "$EVIDENCE_ROOT")" \
  || { echo "STOPPED_FOR_REROUTE evidence leaf refused"; exit 1; }

# 2. Allowlist TMPDIR itself, before mktemp consumes it; then validate mktemp's own output.
TMPROOT="${TMPDIR:-/tmp}"
case "$TMPROOT" in
  /tmp|/tmp/|/var/folders/*|/private/var/folders/*) ;;
  *) echo "STOPPED_FOR_REROUTE untrusted TMPDIR: $TMPROOT"; exit 1 ;;
esac
GATE_DIR="$(mktemp -d "${TMPROOT%/}/goal5a0-gate.XXXXXXXX")" || { echo STOPPED_FOR_REROUTE; exit 1; }
case "$GATE_DIR" in
  /tmp/*|/var/folders/*|/private/var/folders/*) ;;
  *) echo "STOPPED_FOR_REROUTE untrusted temp root: $GATE_DIR"; exit 1 ;;
esac
[ -d "$GATE_DIR" ] && [ -w "$GATE_DIR" ] || { echo "STOPPED_FOR_REROUTE unusable temp root"; exit 1; }
export GATE_DIR

STATUS_LOG="$GATE_DIR/exit-status.tsv"; printf 'label\texit\n' > "$STATUS_LOG"
OUTCOME="$GATE_DIR/outcome.txt"
printf 'STOPPED_FOR_REROUTE incomplete\n' > "$OUTCOME"   # SAFE is never the fallthrough value

capture() { [ -d "$GATE_DIR" ] || return 1; goal5a0_capture_into_leaf "$GATE_DIR" "$EVIDENCE_DIR" >/dev/null 2>&1; }

CHECKS_PID=""
on_signal() {                        # record, force a stop, preserve, clean — in that order, and never return
  printf 'signal-%s\t1\n' "$1" >> "$STATUS_LOG" 2>/dev/null
  printf 'STOPPED_FOR_REROUTE interrupted by SIG%s\n' "$1" > "$OUTCOME" 2>/dev/null
  [ -n "$CHECKS_PID" ] && kill -TERM "$CHECKS_PID" 2>/dev/null
  capture; cap=$?
  trap - EXIT INT TERM; rm -rf "$GATE_DIR"
  echo "STOPPED_FOR_REROUTE interrupted by SIG$1 (evidence-copy rc=$cap)"; exit 1
}
trap 'on_signal INT'  INT
trap 'on_signal TERM' TERM
trap 'rm -rf "$GATE_DIR"' EXIT       # the ONLY cleanup handler; it removes the validated root and nothing else

# 3. Run checks L, 0, A, C, B as a CHILD under an explicit wait, so the supervisor is never blocked
#    inside a foreground command that could defer and then discard the signal.
GATE_CHECKS="${GATE_CHECKS:?checks entry point required}"   # runs L, 0, A, C, B, each through record()
"$GATE_CHECKS" & CHECKS_PID=$!
wait "$CHECKS_PID"; crc=$?
printf 'checks\t%d\n' "$crc" >> "$STATUS_LOG"

# 4. Terminal exit-status guard: any recorded status >= 128 is signal death, handler or no handler.
BADSIG=$(awk -F'\t' 'NR>1 && ($2+0)>=128 {n++} END{print n+0}' "$STATUS_LOG")
if [ "$crc" -ge 128 ] || [ "$BADSIG" -gt 0 ]; then
  printf 'STOPPED_FOR_REROUTE signal-terminated command (checks rc=%d, signalled=%d)\n' "$crc" "$BADSIG" > "$OUTCOME"
  capture; cat "$OUTCOME"; exit 1
fi
[ "$crc" -eq 0 ] || { printf 'STOPPED_FOR_REROUTE checks rc=%d\n' "$crc" > "$OUTCOME"; capture; cat "$OUTCOME"; exit 1; }

printf 'SAFE_TO_IMPLEMENT\n' > "$OUTCOME"                # written only here, by the success path alone
capture || { echo "STOPPED_FOR_REROUTE evidence capture failed"; exit 1; }
cat "$OUTCOME"
