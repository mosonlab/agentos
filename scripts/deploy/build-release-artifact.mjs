#!/usr/bin/env node
import { buildReleaseArtifact } from "./release-artifact.mjs";

const revision = process.argv[2];
const deployRoot = process.env.AGENTOS_REPOSITORY_ROOT ?? process.cwd();
const result = buildReleaseArtifact({
  deployRoot,
  revision,
  sourceRemote: process.env.DEPLOY_SOURCE_REMOTE,
  gitBinary: process.env.DEPLOY_GIT_BINARY,
  nodeBinary: process.env.DEPLOY_NODE_BINARY,
  npmBinary: process.env.DEPLOY_NPM_BINARY,
});

for (const path of result.excludedPaths) process.stderr.write(`EXCLUDED release-path path=${path}\n`);
process.stdout.write(`RELEASE-ARTIFACT ${JSON.stringify({
  releaseName: result.releaseName,
  revision: result.revision,
  digest: result.digest,
  cloneAttempts: result.cloneAttempts,
})}\n`);
