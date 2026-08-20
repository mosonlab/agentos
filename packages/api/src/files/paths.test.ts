import assert from "node:assert/strict";
import test from "node:test";

import { contains, isCanonicalRelPath, normalizeRelPath } from "./paths.js";
import { InvalidPathError } from "./store.js";

test("normalizeRelPath accepts root and normalizes paths that remain inside", () => {
  assert.equal(normalizeRelPath(""), "");
  assert.equal(normalizeRelPath("."), "");
  assert.equal(normalizeRelPath("a/../b.txt"), "b.txt");
  assert.equal(normalizeRelPath("a//b/"), "a/b");
});

test("normalizeRelPath rejects traversal, absolute, Windows, NUL, and overlong paths", () => {
  for (const path of ["..", "../x", "a/../../x", "/etc/passwd", "C:\\evil", "C:evil", "a\0b", "x".repeat(4097)]) {
    assert.throws(() => normalizeRelPath(path), InvalidPathError, path);
  }
});

test("a backslash is an ordinary POSIX filename character, not a separator", () => {
  // It used to be rejected, which made list() return paths read/stat/delete refused.
  // It is not a separator here: the whole thing stays one segment and cannot traverse.
  assert.equal(normalizeRelPath("a\\b"), "a\\b");
  assert.equal(normalizeRelPath("report\\draft.txt"), "report\\draft.txt");
  assert.equal(normalizeRelPath("\\\\server\\share"), "\\\\server\\share");
  assert.equal(isCanonicalRelPath("a\\b"), true);
  assert.throws(() => normalizeRelPath("..\\..\\x/../../escape"), InvalidPathError);
});

test("path normalization never percent-decodes", () => {
  assert.equal(normalizeRelPath("%2e%2e%2fsecret"), "%2e%2e%2fsecret");
  assert.equal(normalizeRelPath("%252e%252e"), "%252e%252e");
  assert.throws(() => normalizeRelPath("../secret"), InvalidPathError);
});

test("isCanonicalRelPath requires a non-root byte-identical canonical path", () => {
  for (const path of ["a", "a/b", "报告.md", "%2e%2e"]) assert.equal(isCanonicalRelPath(path), true, path);
  for (const path of ["", ".", "./a", "a/", "a//b", "a/../b", "/a", ".."]) assert.equal(isCanonicalRelPath(path), false, path);
});

test("contains compares normalized path segments and root contains everything", () => {
  assert.equal(contains("", "anything/here"), true);
  assert.equal(contains("a", "a"), true);
  assert.equal(contains("a", "a/b"), true);
  assert.equal(contains("a", "ab"), false);
  assert.equal(contains("a/b", "a"), false);
});
