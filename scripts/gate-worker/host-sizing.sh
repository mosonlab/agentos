# How much of this host the merge gate may use. Sourced by merge-gate.sh and by
# scripts/merge-gate-parallel.test.mjs. Not executable on its own.
#
# What the caller owes this file: `die` and `note`. Everything here either
# derives a width or refuses one, so a caller that cannot refuse cannot use it.

# run-gate.sh states the worker's configured slot count, so a two-slot worker
# gives each gate half the machine. Every parallel width below is derived from
# this one number instead of each phase reading the CPU count for itself: two
# concurrent gates then add up to one host, rather than each sizing itself for a
# whole machine it does not have. An absent variable means half the host because
# the shared runner host is where it is unset; a gate worker always exports its
# own share.
GATE_HOST_SHARE="${AGENTOS_GATE_HOST_SHARE:-2}"
case "${GATE_HOST_SHARE}" in
  1|2) ;;
  *) die "AGENTOS_GATE_HOST_SHARE must be 1 or 2, got ${GATE_HOST_SHARE}" ;;
esac
GATE_CPUS="$(node -e 'const { availableParallelism } = require("node:os");
process.stdout.write(String(Math.max(1, Math.floor(availableParallelism() / Number(process.argv[1])))));' \
  "${GATE_HOST_SHARE}")" || die "could not size this gate against the host"
[[ "${GATE_CPUS}" =~ ^[1-9][0-9]*$ ]] || die "could not size this gate against the host: got '${GATE_CPUS}'"

# The proof waves run together, and they are not contending for one resource.
# The unit wave is processor-bound and ends when the slowest workspace ends. The
# database waves spend most of their wall clock waiting on PostgreSQL, so lanes
# beyond the core count are deliberate oversubscription of something already
# idle, not a claim the machine has more processors than it has.
#
# These were serial until now, and the comment that serialised them cited a
# 4 GiB worker where running them together turned passing suites into timeouts.
# That was a memory ceiling, which is exactly why these widths come from a
# stated share of a measured host instead of from a raw core count.
#
# Each is overridable so that scripts/gate-worker/bench-dbtest-concurrency.sh
# can alternate arms over one fixed commit. A gate never chooses them itself.
GATE_UNIT_LANES="${AGENTOS_GATE_UNIT_LANES:-${GATE_CPUS}}"
GATE_DB_LANES="${AGENTOS_GATE_DB_LANES:-$(( GATE_CPUS < 2 ? 2 : GATE_CPUS ))}"
for lane_setting in GATE_UNIT_LANES GATE_DB_LANES; do
  [[ "${!lane_setting}" =~ ^[1-9][0-9]*$ ]] \
    || die "${lane_setting} must be a positive integer, got '${!lane_setting}'"
done
note "host share: 1/${GATE_HOST_SHARE} of $(node -e 'process.stdout.write(String(require("node:os").availableParallelism()))') cores = ${GATE_CPUS}"
note "lanes:      unit ${GATE_UNIT_LANES}, database ${GATE_DB_LANES}"
