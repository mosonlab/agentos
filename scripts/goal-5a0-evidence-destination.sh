# Goal 5a0 dependency-gate evidence destination — sourced, never executed.
#
# Binding obligation (a) from the plan's final review, which WINS over the
# original harness listing. That listing validated the destination only as
# absolute, creatable, writable, and a directory, and then ran `cp -R "$GATE_DIR/."
# "$EVIDENCE_DIR/"` — so an operator typo pointing at a checkout, a broad
# directory, a symlinked directory, or a populated evidence directory would
# overwrite unrelated files, including a previous run's outcome.txt and
# exit-status.tsv, while the gate claimed artifact hygiene.
#
# The contract here is a destination that CANNOT collide:
#
#   * the operator supplies an evidence ROOT, never the destination itself;
#   * the root must be absolute, allowlisted, a real directory, not a symlink,
#     not a filesystem root, not inside a git checkout, and must contain nothing
#     except this harness's own leaves;
#   * the harness creates the destination LEAF itself with mktemp -d beneath that
#     root, and re-verifies it is a directory, not a symlink, and empty at the
#     moment of use;
#   * the copy scans every source name against the leaf FIRST and refuses the
#     whole capture on any collision, so a stop happens before any file is
#     written rather than after some of them are.
#
# Every function prints one STOPPED_FOR_REROUTE line and returns non-zero.

goal5a0_evidence_stop() {
  printf 'STOPPED_FOR_REROUTE evidence %s\n' "$1" >&2
  return 1
}

# Physical (symlink-resolved) path of an existing directory.
goal5a0_physical_dir() {
  ( cd -P -- "$1" 2>/dev/null && pwd -P ) || return 1
}

# Is $1 equal to, or a descendant of, $2?
goal5a0_path_within() {
  case "$1" in
    "$2") return 0 ;;
    "${2%/}"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# goal5a0_validate_evidence_root <root>
# Allowlist comes from GOAL5A0_EVIDENCE_ROOTS, a colon-separated list of absolute
# paths. There is no default: an unset allowlist is a stop, because "anywhere" is
# exactly the condition this obligation exists to remove.
goal5a0_validate_evidence_root() {
  root="${1:-}"
  [ -n "$root" ] || { goal5a0_evidence_stop "root required"; return 1; }
  case "$root" in /*) ;; *) goal5a0_evidence_stop "root must be absolute: $root"; return 1 ;; esac
  [ -L "$root" ] && { goal5a0_evidence_stop "root is a symlink: $root"; return 1; }
  [ -d "$root" ] || { goal5a0_evidence_stop "root is not an existing directory: $root"; return 1; }

  # The structural refusals come before the writability test on purpose: run as
  # a user who can write to / (a container's root), a writability-first order
  # would report the wrong reason, and the test that pins "/" is refused would
  # pass for a reason that does not hold on every machine.
  physical="$(goal5a0_physical_dir "$root")" \
    || { goal5a0_evidence_stop "root is unresolvable: $root"; return 1; }
  case "$physical" in
    /) goal5a0_evidence_stop "root is the filesystem root"; return 1 ;;
    /*/*) ;;
    *) goal5a0_evidence_stop "root is a top-level directory: $physical"; return 1 ;;
  esac

  [ -w "$root" ] || { goal5a0_evidence_stop "root is not writable: $root"; return 1; }

  allowlist="${GOAL5A0_EVIDENCE_ROOTS:-}"
  [ -n "$allowlist" ] || { goal5a0_evidence_stop "GOAL5A0_EVIDENCE_ROOTS is unset"; return 1; }
  allowed=1
  saved_ifs="$IFS"; IFS=:
  for entry in $allowlist; do
    [ -n "$entry" ] || continue
    case "$entry" in /*) ;; *) continue ;; esac
    entry_physical="$(goal5a0_physical_dir "$entry")" || continue
    if goal5a0_path_within "$physical" "$entry_physical"; then allowed=0; break; fi
  done
  IFS="$saved_ifs"
  [ "$allowed" -eq 0 ] || { goal5a0_evidence_stop "root is outside GOAL5A0_EVIDENCE_ROOTS: $physical"; return 1; }

  # A repository checkout is never an evidence destination: the copy would land
  # inside a working tree and could overwrite tracked files.
  probe="$physical"
  while [ -n "$probe" ] && [ "$probe" != "/" ]; do
    if [ -e "$probe/.git" ]; then
      goal5a0_evidence_stop "root is inside a git checkout: $probe"
      return 1
    fi
    probe="$(dirname -- "$probe")"
  done

  # Nothing but this harness's own leaves may live here. A populated evidence
  # directory or a user directory is refused before anything is created.
  for entry in "$physical"/* "$physical"/.[!.]* "$physical"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case "$(basename -- "$entry")" in
      goal5a0-gate.*) ;;
      *) goal5a0_evidence_stop "root holds unrelated entries, refusing to write near them: $entry"; return 1 ;;
    esac
  done
  return 0
}

# goal5a0_create_evidence_leaf <validated-root> -> prints the leaf path
goal5a0_create_evidence_leaf() {
  root="${1:-}"
  leaf="$(mktemp -d "${root%/}/goal5a0-gate.XXXXXXXX")" \
    || { goal5a0_evidence_stop "leaf uncreatable beneath $root"; return 1; }
  [ -L "$leaf" ] && { goal5a0_evidence_stop "leaf is a symlink: $leaf"; return 1; }
  [ -d "$leaf" ] && [ -w "$leaf" ] || { goal5a0_evidence_stop "leaf unusable: $leaf"; return 1; }
  printf '%s\n' "$leaf"
  return 0
}

# goal5a0_capture_into_leaf <source-dir> <leaf>
# Refuses rather than overwrites, and decides before it writes.
goal5a0_capture_into_leaf() {
  source_dir="${1:-}"
  leaf="${2:-}"
  [ -d "$source_dir" ] || { goal5a0_evidence_stop "source directory missing: $source_dir"; return 1; }
  [ -n "$leaf" ] && [ ! -L "$leaf" ] && [ -d "$leaf" ] && [ -w "$leaf" ] \
    || { goal5a0_evidence_stop "leaf is not a usable directory at the moment of use: $leaf"; return 1; }

  # Verified empty at the moment of use, not merely when it was created.
  for entry in "$leaf"/* "$leaf"/.[!.]* "$leaf"/..?*; do
    if [ -e "$entry" ] || [ -L "$entry" ]; then
      goal5a0_evidence_stop "leaf is not empty at the moment of use: $entry"
      return 1
    fi
  done

  # Collision scan across every source name BEFORE the first byte is copied.
  for entry in "$source_dir"/* "$source_dir"/.[!.]* "$source_dir"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="$(basename -- "$entry")"
    if [ -e "$leaf/$name" ] || [ -L "$leaf/$name" ]; then
      goal5a0_evidence_stop "refusing to overwrite $leaf/$name"
      return 1
    fi
  done

  for entry in "$source_dir"/* "$source_dir"/.[!.]* "$source_dir"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    cp -R -- "$entry" "$leaf/" || { goal5a0_evidence_stop "copy failed: $entry"; return 1; }
  done
  return 0
}
