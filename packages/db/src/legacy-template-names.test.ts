import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import { canonicalTemplateIdentity, legacyTemplateName } from "./canonical-template-transition.js";

/** Discover declarations rather than maintaining a second list of name helpers. */
test("every exported legacy template name helper produces a registered identity", async () => {
  const workspace = new URL("../", import.meta.url);
  let checked = 0;
  for (const directory of ["src/", "prisma/"]) {
    for (const entry of await readdir(new URL(directory, workspace), { recursive: true })) {
      if (!entry.endsWith(".ts") || /\.(?:test|dbtest)\.ts$/u.test(entry)) continue;
      const url = new URL(`${directory}${entry}`, workspace);
      const source = ts.createSourceFile(entry, await readFile(url, "utf8"), ts.ScriptTarget.Latest, true);
      const names: string[] = [];
      for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          names.push(...statement.exportClause.elements.map(({ name }) => name.text));
        }
        if (!ts.canHaveModifiers(statement)
          || !ts.getModifiers(statement)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) continue;
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
          }
        } else if (ts.isFunctionDeclaration(statement) && statement.name) {
          names.push(statement.name.text);
        }
      }
      // This resolver reads a name; unlike the other matching exports it does not mint one.
      const helpers = names.filter((name) => /^legacy.+TemplateName$/u.test(name)
        && name !== "legacyGenerationMarkerForTemplateName");
      if (helpers.length === 0) continue;
      const exports = await import(url.href) as Record<string, unknown>;
      for (const name of helpers) {
        const helper = exports[name] as (...args: string[]) => string;
        assert.equal(typeof helper, "function", `${entry}: ${name}`);
        const argumentLists = helper.length === 1
          ? [["template-row"]]
          : ["compound-engineer-workflow", "direct-engineer-workflow"].map((template) => [template, "template-row"]);
        for (const args of argumentLists) {
          const minted = helper(...args);
          assert.ok(canonicalTemplateIdentity(minted), `${entry}: ${name} minted unregistered ${minted}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 0, "must discover legacy template name helpers");
});

test("seed-era legacy names preserve their exact template and generation", () => {
  for (const [canonicalName, markers] of [
    ["compound-engineer-workflow", ["10", "9", "human-12", "regression-first-13"]],
    ["direct-engineer-workflow", ["human-6"]],
  ] as const) {
    for (const generation of markers) {
      assert.deepEqual(canonicalTemplateIdentity(`${canonicalName}-legacy-${generation}-persisted-row`), {
        canonicalName, generation,
      });
      assert.equal(canonicalTemplateIdentity(`${canonicalName}-legacy-${generation}-`), null);
    }
  }
});

test("name minting refuses unknown generations and missing row identities", () => {
  assert.throws(() => legacyTemplateName("compound-engineer-workflow", "unregistered", "row"), /Unregistered legacy/);
  assert.throws(() => legacyTemplateName("unknown-template", "10", "row"), /Unregistered legacy/);
  assert.throws(() => legacyTemplateName("direct-engineer-workflow", "10", "row"), /Unregistered legacy/);
  assert.throws(() => legacyTemplateName("compound-engineer-workflow", "10", ""), /requires a row id/);
});
