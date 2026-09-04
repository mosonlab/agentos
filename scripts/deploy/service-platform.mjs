/**
 * Resolve the platform used by the service management paths.
 *
 * Service deployment intentionally supports only the two platforms with a
 * maintained service definition.  The optional arguments are a test seam;
 * normal callers use the process platform and environment defaults.
 */
export const resolveServicePlatform = ({
  platform = process.platform,
  environment = process.env,
} = {}) => {
  const configured = environment?.AGENTOS_SERVICE_PLATFORM;
  const selected = configured === undefined ? platform : configured;
  if (selected !== "darwin" && selected !== "linux") {
    throw new Error(`service-platform-unsupported:${String(selected)}`);
  }
  return selected;
};
