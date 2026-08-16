#!/usr/bin/env bash
# Acceptance check B1–B12 for the frontend-convergence batch.
#
# Why this exists: spec §9.B's grep uses \b, and \b treats "-" as a word
# boundary, so a legacy name matches as a *segment* of an ordinary Tailwind
# utility ("top" in "top-4", "primary" in "bg-primary"). That check fires on
# files the spec itself certifies legacy-free, so B1–B12 can never pass as
# written. This script compares WHOLE className tokens instead.
#
# Usage:   docs/plans/legacy-class-check.sh <file> [<file> ...]
# Output:  one line per file, "<count>\t<file>". Every count must be 0 at
#          acceptance. Exit status is 1 if any count is non-zero, else 0.
#
# Method: extract every className attribute value (plain string, template
# literal, or braced expression), split on whitespace, drop ${...} fragments,
# and count tokens that equal a name in docs/specs/legacy-classes.txt.

set -uo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
names="${LEGACY_CLASSES:-$repo_root/docs/specs/legacy-classes.txt}"

if [ ! -f "$names" ]; then
  echo "legacy-class-check: cannot read $names" >&2
  exit 2
fi

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <file> [<file> ...]" >&2
  exit 2
fi

status=0
for f in "$@"; do
  if [ ! -f "$f" ]; then
    echo "legacy-class-check: no such file: $f" >&2
    status=2
    continue
  fi
  n=$(grep -oE 'className=("[^"]*"|\{`[^`]*`\}|\{[^}]*\})' "$f" \
      | grep -oE '("[^"]*"|`[^`]*`)' \
      | tr -d '"`' | tr ' ' '\n' \
      | grep -vE '^\$\{|^$' \
      | grep -Fxf <(sort "$names") \
      | wc -l | tr -d ' ')
  printf '%s  %s\n' "$n" "$f"
  [ "$n" = "0" ] || status=1
done
exit "$status"
