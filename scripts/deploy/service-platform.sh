#!/bin/bash
# Resolve the service-management platform for shell entrypoints.
#
# Keep this in step with service-platform.mjs: callers may force either
# supported platform for tests, while an unsupported value is always a hard
# refusal. The uname probe lives here so os-isolation scripts do not each grow
# a subtly different platform detector.
agentos_service_platform() {
  local raw_platform

  if [ "${AGENTOS_SERVICE_PLATFORM+x}" = x ]; then
    raw_platform="$AGENTOS_SERVICE_PLATFORM"
  else
    case "$(uname -s 2>/dev/null || true)" in
      Darwin) raw_platform=darwin ;;
      Linux) raw_platform=linux ;;
      *) raw_platform="$(uname -s 2>/dev/null || true)" ;;
    esac
  fi

  case "$raw_platform" in
    darwin|linux) printf '%s\n' "$raw_platform" ;;
    *)
      printf 'service-platform-unsupported:%s\n' "$raw_platform" >&2
      return 64
      ;;
  esac
}

# The verification branch uses the descriptive resolver name. Keep this
# compatibility alias while the existing provisioning scripts use the
# historical function name; both names resolve through the same implementation.
resolve_service_platform() {
  agentos_service_platform "$@"
}
