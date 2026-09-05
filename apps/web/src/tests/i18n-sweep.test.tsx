import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { I18N_ALLOWLIST } from "./i18n-allowlist";

export const USER_COPY_NAMES = new Set([
  "placeholder", "title", "aria-label", "alt", "label", "hint", "message",
  "what", "empty", "description", "confirmLabel",
]);

type Category = "jsx-text" | "copy-attribute" | "copy-property" | "return-copy" | "dialog-copy" | "template-copy";
type Finding = { file: string; text: string; category: Category; line: number };

const hasProse = (text: string): boolean => /[A-Za-z]{2}/u.test(text.replace(/&[a-z]+;/giu, ""));

const callName = (node: ts.CallExpression): string | null => {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) {
    return `${node.expression.expression.getText()}.${node.expression.name.text}`;
  }
  return null;
};

const isTranslationCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && ["t", "translate", "formatT"].includes(callName(node) ?? "");

const literalParts = (node: ts.Node): Array<{ node: ts.Node; text: string; template: boolean }> => {
  if (isTranslationCall(node)) return [];
  if (ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxSelfClosingElement(node)) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [{ node, text: node.text, template: ts.isNoSubstitutionTemplateLiteral(node) }];
  }
  if (ts.isTemplateExpression(node)) {
    return [
      { node: node.head, text: node.head.text, template: true },
      ...node.templateSpans.map((span) => ({ node: span.literal, text: span.literal.text, template: true })),
    ];
  }
  const found: Array<{ node: ts.Node; text: string; template: boolean }> = [];
  node.forEachChild((child) => found.push(...literalParts(child)));
  return found;
};

const functionName = (node: ts.Node): string | null => {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      if (current.name && ts.isIdentifier(current.name)) return current.name.text;
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
      if (ts.isPropertyAssignment(current.parent)) return current.parent.name.getText().replace(/["']/gu, "");
      return null;
    }
    current = current.parent;
  }
  return null;
};

const copyName = (name: ts.PropertyName | ts.JsxAttributeName): string => {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return name.getText();
};

export const scanSource = (file: string, source: string): Finding[] => {
  // Generic arrow functions (`<T>`) in lib/*.ts are parsed as JSX by the TSX
  // grammar. Pick the grammar from the extension while keeping the AST scan.
  const scriptKind = file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const findings: Finding[] = [];
  const add = (node: ts.Node, text: string, category: Category): void => {
    const cleaned = text.replace(/\s+/gu, " ").trim();
    if (!hasProse(cleaned)) return;
    findings.push({ file, text: cleaned, category, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 });
  };
  const addParts = (node: ts.Node, category: Exclude<Category, "template-copy">): void => {
    for (const part of literalParts(node)) add(part.node, part.text, part.template ? "template-copy" : category);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && node.text.trim()) add(node, node.text, "jsx-text");

    if (ts.isJsxAttribute(node) && USER_COPY_NAMES.has(copyName(node.name)) && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) add(node.initializer, node.initializer.text, "copy-attribute");
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) addParts(node.initializer.expression, "copy-attribute");
    }

    if (ts.isPropertyAssignment(node) && (USER_COPY_NAMES.has(copyName(node.name)) || copyName(node.name) === "note")) {
      addParts(node.initializer, "copy-property");
    }

    if (ts.isReturnStatement(node) && node.expression && /(?:Label$|^render|Text$)/u.test(functionName(node) ?? "")) {
      if (ts.isStringLiteral(node.expression) || ts.isTemplateLiteral(node.expression) || ts.isConditionalExpression(node.expression)) {
        addParts(node.expression, "return-copy");
      }
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body) && /(?:Label$|^render|Text$)/u.test(functionName(node) ?? "")) {
      if (ts.isStringLiteral(node.body) || ts.isTemplateLiteral(node.body) || ts.isConditionalExpression(node.body)) {
        addParts(node.body, "return-copy");
      }
    }

    if (ts.isCallExpression(node) && ["window.confirm", "window.alert", "window.prompt"].includes(callName(node) ?? "")) {
      if (node.arguments[0]) addParts(node.arguments[0], "dialog-copy");
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

const testRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(testRoot, "..");

const sourceFiles = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
  const path = resolve(directory, name);
  if (statSync(path).isDirectory()) return sourceFiles(path);
  return /\.[jt]sx?$/u.test(name) ? [path] : [];
});

test("the translated UI source has no unapproved user-facing English literals", () => {
  // The startup gate's entries (`.env` and the three `npm run …` commands) are
  // its own vocabulary: a configuration file name and shell commands an operator
  // types verbatim into a terminal. Translating them would break them, which is
  // the line this cap protects — prose grows, identifiers are counted. The cap
  // is the current 23 entries plus two of headroom.
  assert.ok(I18N_ALLOWLIST.length <= 25, `i18n allowlist has ${I18N_ALLOWLIST.length} entries (maximum 25)`);
  const files = ["pages", "components", "lib"].flatMap((name) => sourceFiles(resolve(sourceRoot, name)));
  const all = files.flatMap((path) => scanSource(relative(sourceRoot, path), readFileSync(path, "utf8")));
  const remaining = all.filter((finding) => !I18N_ALLOWLIST.some((entry) => entry.file === finding.file && entry.text === finding.text));
  assert.deepEqual(remaining, []);
});

for (const fixture of [
  ["jsx-text", "i18n-regression-jsx.tsx"],
  ["copy-attribute", "i18n-regression-attribute.tsx"],
  ["copy-property", "i18n-regression-property.tsx"],
  ["return-copy", "i18n-regression-return.tsx"],
  ["dialog-copy", "i18n-regression-dialog.tsx"],
  ["template-copy", "i18n-regression-template.tsx"],
] as const) {
  test(`the sweep detects ${fixture[0]} regressions`, () => {
    const path = resolve(testRoot, "fixtures", fixture[1]);
    assert.ok(scanSource(fixture[1], readFileSync(path, "utf8")).some((finding) => finding.category === fixture[0]));
  });
}

test("the sweep accepts translated source as a positive control", () => {
  const path = resolve(testRoot, "fixtures", "i18n-positive.tsx");
  assert.deepEqual(scanSource("i18n-positive.tsx", readFileSync(path, "utf8")), []);
});
