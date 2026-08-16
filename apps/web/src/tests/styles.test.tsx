import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "../components/ui";

const sourcePath = fileURLToPath(new URL("../styles.css", import.meta.url));
const source = readFileSync(sourcePath, "utf8");
const distDirectory = fileURLToPath(new URL("../../dist/assets/", import.meta.url));
const cssAsset = readdirSync(distDirectory).find((name) => name.endsWith(".css"));
if (!cssAsset) throw new Error("Build apps/web before running CSS regression tests");
const built = readFileSync(`${distDirectory}${cssAsset}`, "utf8");

const layersAt = (css: string, index: number): string[] => {
  const stack: Array<string | null> = [];
  let headerStart = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const char = css[cursor];
    if (char === "{") {
      const header = css.slice(headerStart, cursor).trim();
      stack.push(/^@layer\s+([\w-]+)/.exec(header)?.[1] ?? null);
      headerStart = cursor + 1;
    } else if (char === "}") {
      stack.pop();
      headerStart = cursor + 1;
    } else if (char === ";") {
      headerStart = cursor + 1;
    }
  }
  return stack.filter((layer): layer is string => layer !== null);
};

const selectorIndex = (selector: string): number => {
  const index = built.indexOf(selector);
  assert.notEqual(index, -1, `missing built selector ${selector}`);
  return index;
};

/** Every innermost `{...}` block in the built sheet, with the byte offset of its
 *  opening brace so `layersAt` can say which layers enclose it. The inner body
 *  pattern excludes braces, so an at-rule header is never captured as a
 *  selector — the walker descends into `@media`/`@supports`/`@layer` and yields
 *  the rules inside them. */
const rules = (): Array<{ selector: string; body: string; brace: number }> => {
  const found: Array<{ selector: string; body: string; brace: number }> = [];
  for (const match of built.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? "").trim();
    found.push({ selector, body: match[2] ?? "", brace: match.index + (match[1] ?? "").length });
  }
  return found;
};

/** A declaration block that sets anything other than a custom property. This is
 *  the carve-out that lets `.dark { --background: … }` stay unlayered without an
 *  allowlist of class names: it declares tokens, not appearance. */
const declaresAppearance = (body: string): boolean =>
  body.split(";").some((declaration) => {
    const property = declaration.slice(0, declaration.indexOf(":")).trim();
    return property.length > 0 && !property.startsWith("--");
  });

const CLASS_TOKEN = /(?:^|[\s,>+~()])\.[A-Za-z_-]/;

test("no unlayered class rule styles the app", () => {
  const walked = rules();
  const unlayered = walked.filter((rule) => layersAt(built, rule.brace).length === 0);

  // Guards against a parser change quietly making the assertion vacuous: the
  // sheet does still contain unlayered rules (`:root`, `.dark`, `@property`).
  assert.ok(unlayered.length > 0, "walker found no unlayered rules at all");

  const offenders = unlayered
    .filter((rule) => !rule.selector.startsWith("@"))
    .filter((rule) => CLASS_TOKEN.test(rule.selector))
    .filter((rule) => declaresAppearance(rule.body))
    .map((rule) => `${rule.selector}{${rule.body.slice(0, 60)}}`);
  assert.deepEqual(offenders, []);

  assert.deepEqual(layersAt(built, selectorIndex(".flex{")), ["utilities"]);
});

test("Markdown list markers override Tailwind preflight", () => {
  const preflight = built.search(/(?:ol,ul,menu|menu,ol,ul)\{list-style:none/);
  assert.notEqual(preflight, -1, "missing Tailwind list reset");
  assert.deepEqual(layersAt(built, preflight), ["base"]);

  // The reset is beaten by utilities now, not by an unlayered `.md ul` rule.
  assert.deepEqual(layersAt(built, selectorIndex(".list-disc{")), ["utilities"]);
  assert.deepEqual(layersAt(built, selectorIndex(".list-decimal{")), ["utilities"]);

  // …and the renderer still puts those utilities on the list elements, which is
  // the half a CSS-only assertion cannot see.
  const markup = renderToStaticMarkup(<Markdown text={"- a\n\n1. b"} />);
  assert.match(markup, /<ul[^>]*\blist-disc\b/);
  assert.match(markup, /<ol[^>]*\blist-decimal\b/);
});

const lightBlock = /:root\s*\{([^}]+)\}/.exec(source)?.[1] ?? "";
const token = (name: string): string => {
  const value = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(lightBlock)?.[1];
  assert.ok(value, `missing light token --${name}`);
  return value;
};
const luminance = (hex: string): number => {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};
const contrast = (foreground: string, background: string): number => {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
};

test("light text tokens meet 4.5:1 on every surface where small text is rendered", () => {
  const combinations: Array<[string, string, string]> = [
    ["foreground/background", "foreground", "background"],
    ["secondary/background", "secondary-foreground", "background"],
    ["muted/background", "muted-foreground", "background"],
    ["faint/background", "faint", "background"],
    ["primary/background", "primary", "background"],
    ["primary label", "primary-foreground", "primary"],
    ["primary/code", "primary", "code-background"],
    ["muted/accent", "muted-foreground", "accent"],
    ["faint/code", "faint", "code-background"],
    ["faint/sidebar", "faint", "sidebar"],
    ["green pill", "status-green-fg", "status-green-bg"],
    ["amber pill", "status-amber-fg", "status-amber-bg"],
    ["violet pill", "status-violet-fg", "status-violet-bg"],
    ["destructive notice", "destructive-fg", "destructive-bg"],
  ];
  const failures = combinations.flatMap(([label, foreground, background]) => {
    const ratio = contrast(token(foreground), token(background));
    return ratio >= 4.5 ? [] : [`${label}=${ratio.toFixed(2)}`];
  });
  assert.deepEqual(failures, []);
});
