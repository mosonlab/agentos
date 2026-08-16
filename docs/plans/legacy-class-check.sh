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
#          docs/plans/legacy-class-check.sh --self-test
# Output:  one line per file, "<count>\t<file>". Every count must be 0 at
#          acceptance. Exit status is 1 if any count is non-zero, else 0.
#
# Method: extract every className attribute value (plain string, template
# literal, or braced expression), split on whitespace, drop ${...} fragments,
# and count tokens that equal a name in docs/specs/legacy-classes.txt. Inside a
# braced expression every string literal is scanned, so a non-class operand
# (`tone === "green" ? … : …`) counts too — the check over-reports rather than
# miss residue.
#
# The extractor reads whole files and balances braces rather than matching
# per line. A line-oriented `grep -oE 'className=\{[^}]*\}'` cannot see a
# `className={cn(` whose arguments wrap onto the next line — 31 such sites in
# apps/web/src — so it would keep reporting 0 for residue reintroduced there.
# `--self-test` runs the extractor over legacy-class-check-fixture.tsx, which
# hides two legacy names inside a wrapped cn() call, and fails if they are not
# both found.

set -uo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
names="${LEGACY_CLASSES:-$repo_root/docs/specs/legacy-classes.txt}"
fixture="$repo_root/docs/plans/legacy-class-check-fixture.tsx"

if [ ! -f "$names" ]; then
  echo "legacy-class-check: cannot read $names" >&2
  exit 2
fi

# The program is held in a quoted heredoc rather than a single-quoted argument: it has to
# compare against both quote characters, and a single quote cannot be written
# inside a single-quoted shell word.
read -r -d '' PERL_EXTRACT <<'PERL_EXTRACT_END'
    my $src = $_;
    my $len = length $src;
    my $i = 0;
    my @literals;
    while ($i < $len) {
      my $at = index($src, "className=", $i);
      last if $at < 0;
      my $p = $at + length("className=");
      my $head = substr($src, $p, 1);
      if ($head eq '"' or $head eq "'") {
        my $end = index($src, $head, $p + 1);
        last if $end < 0;
        push @literals, substr($src, $p + 1, $end - $p - 1);
        $i = $end + 1;
      } elsif ($head eq "{") {
        my $depth = 0;
        my $quote = "";
        my $j = $p;
        while ($j < $len) {
          my $c = substr($src, $j, 1);
          if ($quote ne "") {
            if ($c eq "\\") { $j += 2; next }
            $quote = "" if $c eq $quote;
          } elsif ($c eq '"' or $c eq "'" or $c eq '`') {
            $quote = $c;
          } elsif ($c eq "{") {
            $depth++;
          } elsif ($c eq "}") {
            $depth--;
            last if $depth == 0;
          }
          $j++;
        }
        my $expr = substr($src, $p + 1, $j - $p - 1);
        # Every string and template literal inside the expression.
        while ($expr =~ /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/gs) {
          push @literals, defined $1 ? $1 : (defined $2 ? $2 : $3);
        }
        $i = $j + 1;
      } else {
        $i = $p;
      }
    }
    for my $literal (@literals) {
      my $text = $literal;
      $text =~ s/\$\{[^{}]*\}/\x01/g;
      for my $token (split /\s+/, $text) {
        next if $token eq "";
        next if index($token, "\x01") >= 0;
        print "$token\n";
      }
    }
PERL_EXTRACT_END

# Emits one candidate className token per line for the file named in $1.
# ${...} interpolations collapse to \x01 so a token that is partly dynamic
# ("btn${size}") can never equal a legacy name, while the static tokens
# around it ("notice ${tone}" -> "notice") still count.
extract_tokens() {
  perl -0777 -ne "$PERL_EXTRACT" "$1"
}

count_file() {
  extract_tokens "$1" | grep -Fxf <(sort "$names") | wc -l | tr -d ' '
}

if [ "${1:-}" = "--self-test" ]; then
  if [ ! -f "$fixture" ]; then
    echo "legacy-class-check: cannot read $fixture" >&2
    exit 2
  fi
  got=$(count_file "$fixture")
  if [ "$got" = "2" ]; then
    echo "self-test ok: the wrapped cn() fixture yields 2 legacy tokens"
    exit 0
  fi
  echo "self-test FAILED: expected 2 legacy tokens in $fixture, got $got" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <file> [<file> ...]" >&2
  echo "       $0 --self-test" >&2
  exit 2
fi

status=0
for f in "$@"; do
  if [ ! -f "$f" ]; then
    echo "legacy-class-check: no such file: $f" >&2
    status=2
    continue
  fi
  n=$(count_file "$f")
  printf '%s  %s\n' "$n" "$f"
  [ "$n" = "0" ] || status=1
done
exit "$status"
