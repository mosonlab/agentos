import assert from "node:assert/strict";
import test from "node:test";

import { grantAdmits, requiredCapability, type GrantLike } from "./grants.js";

const grant = (folderPath: string, permissions: Partial<GrantLike> = {}): GrantLike => ({
  folderPath, canRead: false, canWrite: false, canDelete: false, ...permissions,
});

test("requiredCapability covers the full operation matrix", () => {
  for (const operation of ["list", "stat", "read"] as const) assert.equal(requiredCapability(operation), "canRead");
  for (const operation of ["write", "mkdir"] as const) assert.equal(requiredCapability(operation), "canWrite");
  assert.equal(requiredCapability("delete"), "canDelete");
});

test("drop-box, overlap, and root grant semantics admit any sufficient grant", () => {
  const dropbox = grant("drop", { canWrite: true });
  assert.deepEqual(grantAdmits([dropbox], "write", "drop/item"), { admitted: true });
  assert.deepEqual(grantAdmits([dropbox], "read", "drop/item"), { admitted: false, missing: "canRead" });
  assert.deepEqual(grantAdmits([grant("a", { canRead: true }), grant("a/b", { canWrite: true })], "write", "a/b/x"), { admitted: true });
  assert.deepEqual(grantAdmits([grant("", { canRead: true })], "read", "every/folder"), { admitted: true });
});

test("dirty historical grant rows fail closed", () => {
  for (const folderPath of ["/abs", "a/../..", "..\\x", "a/"]) {
    assert.deepEqual(grantAdmits([grant(folderPath, { canRead: true })], "read", "a/x"), { admitted: false, missing: "canRead" });
  }
});
