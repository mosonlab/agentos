/**
 * The splitter's whole job is to not cut inside a literal, and to say so when
 * it meets something it cannot reason about.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitSqlStatements } from "./sql-statements.js";

describe("splitSqlStatements", () => {
  it("splits ordinary setup and drops the empty tail", () => {
    assert.deepEqual(
      splitSqlStatements(`DROP SCHEMA IF EXISTS "x" CASCADE; CREATE SCHEMA "x";`),
      ['DROP SCHEMA IF EXISTS "x" CASCADE', 'CREATE SCHEMA "x"'],
    );
    assert.deepEqual(splitSqlStatements("  \n  "), []);
    assert.deepEqual(splitSqlStatements("SELECT 1"), ["SELECT 1"], "a statement without a terminator still counts");
  });

  it("does not cut on a semicolon inside a string literal", () => {
    // The reason this module exists: a seed row carrying a semicolon used to be
    // fine only because a separate process parsed the SQL.
    assert.deepEqual(
      splitSqlStatements(`INSERT INTO "T" ("d") VALUES ('a; not a boundary'); SELECT 1;`),
      [`INSERT INTO "T" ("d") VALUES ('a; not a boundary')`, "SELECT 1"],
    );
  });

  it("treats a doubled quote as an escape rather than a boundary", () => {
    assert.deepEqual(
      splitSqlStatements(`INSERT INTO "T" VALUES ('it''s; fine'); SELECT 2;`),
      [`INSERT INTO "T" VALUES ('it''s; fine')`, "SELECT 2"],
    );
  });

  it("does not cut on a semicolon inside a quoted identifier", () => {
    assert.deepEqual(
      splitSqlStatements(`SELECT "weird;column" FROM "T"; SELECT 3;`),
      [`SELECT "weird;column" FROM "T"`, "SELECT 3"],
    );
  });

  it("ignores comments, including a semicolon inside one", () => {
    assert.deepEqual(
      splitSqlStatements(`SELECT 1; -- trailing; comment\nSELECT 2; /* block; comment */ SELECT 3;`),
      ["SELECT 1", "SELECT 2", "SELECT 3"],
    );
  });

  it("refuses what it cannot reason about instead of guessing", () => {
    assert.throws(() => splitSqlStatements("SELECT $$body$$"), /dollar quoting/u);
    assert.throws(() => splitSqlStatements("SELECT $tag$body$tag$"), /dollar quoting/u);
    assert.throws(() => splitSqlStatements("SELECT 'unterminated"), /unterminated string/u);
    assert.throws(() => splitSqlStatements('SELECT "unterminated'), /unterminated identifier/u);
    assert.throws(() => splitSqlStatements("SELECT 1 /* unterminated"), /unterminated block comment/u);
  });
});
