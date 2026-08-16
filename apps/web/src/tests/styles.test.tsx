import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("legacy selectors stay unlayered while Tailwind utilities stay layered", () => {
  for (const selector of [".row{", ".page{", ".projectMark{", "select{"]) {
    assert.deepEqual(layersAt(built, selectorIndex(selector)), [], selector);
  }
  assert.deepEqual(layersAt(built, selectorIndex(".flex{")), ["utilities"]);

  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const shell = readFileSync(fileURLToPath(new URL("../components/Shell.tsx", import.meta.url)), "utf8");
  const tasks = readFileSync(fileURLToPath(new URL("../pages/Tasks.tsx", import.meta.url)), "utf8");
  const detail = readFileSync(fileURLToPath(new URL("../pages/TaskDetail.tsx", import.meta.url)), "utf8");
  assert.match(app, /className="page" style=\{\{ paddingBottom: 0 \}\}/);
  assert.match(shell, /className="projectMark" style=\{\{ width: 18, height: 18, fontSize: 10 \}\}/);
  assert.match(tasks, /className="row" style=\{\{ alignItems: "flex-start" \}\}/);
  assert.match(tasks, /style=\{\{ gap: 6 \}\}/);
  assert.match(detail, /style=\{\{ width: 130 \}\}/);
});

test("Markdown list markers override Tailwind preflight", () => {
  const preflight = built.search(/(?:ol,ul,menu|menu,ol,ul)\{list-style:none/);
  assert.notEqual(preflight, -1, "missing Tailwind list reset");
  assert.deepEqual(layersAt(built, preflight), ["base"]);
  const unordered = selectorIndex(".md ul{list-style:outside}");
  const ordered = selectorIndex(".md ol{list-style:decimal}");
  assert.deepEqual(layersAt(built, unordered), []);
  assert.deepEqual(layersAt(built, ordered), []);
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
