import assert from "node:assert/strict";
import { test } from "node:test";

import { loadExecutorConfig } from "./config.js";

const base = {
  MERGE_EXECUTOR_TOKEN: "executor-only-token",
  MERGE_EXECUTOR_RUNNER_ID: "merge-executor-1",
  MERGE_EXECUTOR_IDENTITY_LOGIN: "agentos-merge",
};

test("the executor carries its own credential, never the fleet-wide runner token", () => {
  const config = loadExecutorConfig({ ...base, RUNNER_TOKEN: "fleet-wide" });
  assert.equal(config.executorToken, "executor-only-token");
});

test("a missing or aliased executor token refuses the start", () => {
  // §D-P1 rule 3 is an *identity* rule. A deployment that "configures" the
  // executor by handing it the runner token has given every runner the ability
  // to claim a mechanical run and author the merge-result the chain trusts, so
  // the process refuses to start rather than run with a shared credential. The
  // API applies the same rule in `mergeExecutorTokenIsDistinct`.
  assert.throws(() => loadExecutorConfig({ ...base, MERGE_EXECUTOR_TOKEN: undefined }), /MERGE_EXECUTOR_TOKEN is required/u);
  assert.throws(
    () => loadExecutorConfig({ ...base, RUNNER_TOKEN: "same" , MERGE_EXECUTOR_TOKEN: "same" }),
    /must not equal RUNNER_TOKEN/u,
  );
  assert.throws(
    () => loadExecutorConfig({ ...base, OPERATOR_TOKEN: "same", MERGE_EXECUTOR_TOKEN: "same" }),
    /must not equal OPERATOR_TOKEN/u,
  );
});
