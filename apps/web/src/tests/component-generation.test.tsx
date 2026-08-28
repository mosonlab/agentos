import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";

const read = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../components/ui/${file}`, import.meta.url)), "utf8");

/** Comments in these files legitimately name the things the guards below ban —
 *  `input.tsx` explains why `md:text-sm` is gone, `hover-card.tsx` explains why it
 *  ships no animation. A guard that read the prose would fail on the very sentence
 *  documenting the compliance, so the banned-substring scans run on code only. */
const code = (file: string): string =>
  read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/**
 * Every exported part of every file under `components/ui/`, with the `data-slot`
 * it must carry. Enumerated per part rather than per file on purpose: a per-file
 * assertion goes green on a `card.tsx` where five of six parts stayed v3.
 *
 * `badgeVariants` and `buttonVariants` are the only two exports that are not
 * parts; they are named in NOT_A_PART so the export-list cross-check below cannot
 * be satisfied by deleting a part from the export list.
 */
const PARTS: Record<string, string[]> = {
  "badge.tsx": ["Badge"],
  "button.tsx": ["Button"],
  "card.tsx": ["Card", "CardHeader", "CardFooter", "CardTitle", "CardDescription", "CardContent"],
  "checkbox.tsx": ["Checkbox"],
  "dialog.tsx": [
    "Dialog", "DialogPortal", "DialogOverlay", "DialogTrigger", "DialogClose",
    "DialogContent", "DialogHeader", "DialogFooter", "DialogTitle", "DialogDescription",
  ],
  "dropdown-menu.tsx": [
    "DropdownMenu", "DropdownMenuTrigger", "DropdownMenuContent", "DropdownMenuItem",
    "DropdownMenuCheckboxItem", "DropdownMenuRadioItem", "DropdownMenuLabel",
    "DropdownMenuSeparator", "DropdownMenuShortcut", "DropdownMenuGroup",
    "DropdownMenuPortal", "DropdownMenuSub", "DropdownMenuSubContent",
    "DropdownMenuSubTrigger", "DropdownMenuRadioGroup",
  ],
  "hover-card.tsx": ["HoverCard", "HoverCardTrigger", "HoverCardContent"],
  "input.tsx": ["Input"],
  "progress.tsx": ["Progress"],
  "select.tsx": ["Select"],
  "switch.tsx": ["Switch"],
  "table.tsx": ["Table", "TableHeader", "TableBody", "TableFooter", "TableHead", "TableRow", "TableCell", "TableCaption"],
  "textarea.tsx": ["Textarea"],
};

const NOT_A_PART = ["badgeVariants", "buttonVariants"];

const kebab = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

test("the 12 migrated files plus hover-card carry 50 parts, and the plan's count is pinned", () => {
  const migrated = Object.entries(PARTS).filter(([file]) => file !== "hover-card.tsx");
  assert.equal(migrated.length, 12);
  assert.equal(migrated.reduce((total, [, parts]) => total + parts.length, 0), 47);
  assert.equal(PARTS["hover-card.tsx"]!.length, 3);
});

test("every exported part declares its own data-slot", () => {
  const missing: string[] = [];
  for (const [file, parts] of Object.entries(PARTS)) {
    const source = read(file);
    for (const part of parts) {
      if (!source.includes(`data-slot="${kebab(part)}"`)) missing.push(`${file}:${part}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the export lists match the enumerated parts exactly", () => {
  const mismatched: string[] = [];
  for (const [file, parts] of Object.entries(PARTS)) {
    const source = read(file);
    const block = /export\s*\{([^}]*)\}/g;
    const exported = [...source.matchAll(block)]
      .flatMap((match) => (match[1] ?? "").split(","))
      .map((name) => name.trim())
      .filter((name) => name.length > 0 && !NOT_A_PART.includes(name));
    if (exported.sort().join(",") !== [...parts].sort().join(",")) {
      mismatched.push(`${file}: exported ${exported.join("|")} vs enumerated ${parts.join("|")}`);
    }
  }
  assert.deepEqual(mismatched, []);
});

test("no forwardRef, no displayName, and no animation utility survives", () => {
  const offenders: string[] = [];
  for (const file of Object.keys(PARTS)) {
    const source = code(file);
    for (const banned of ["forwardRef", "displayName =", "animate-in", "animate-out", "tw-animate-css"]) {
      if (source.includes(banned)) offenders.push(`${file}: ${banned}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("tw-animate-css is not a dependency", () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
  assert.equal(manifest.dependencies["tw-animate-css"], undefined);
  assert.equal(manifest.devDependencies["tw-animate-css"], undefined);
  assert.ok(manifest.dependencies["@radix-ui/react-hover-card"], "hover-card dependency is missing");
});

/** The parts that render a real DOM element without a Radix provider. The Radix
 *  Root/Portal/Trigger aliases are source-only assertions above: a Root renders no
 *  node of its own and a Trigger needs its Root's context. Listed literally rather
 *  than decided at runtime, so a part that stops rendering is a failure and not a
 *  silent skip. */
test("the DOM-rendering parts emit the attribute, not just declare it", () => {
  const cases: Array<[string, React.ReactElement]> = [
    ["badge", <Badge />],
    ["button", <Button />],
    ["card", <Card />],
    ["card-header", <CardHeader />],
    ["card-title", <CardTitle />],
    ["card-description", <CardDescription />],
    ["card-content", <CardContent />],
    ["card-footer", <CardFooter />],
    ["input", <Input />],
    ["select", <Select />],
    ["textarea", <Textarea />],
    ["table", <Table />],
    ["table-header", <table><TableHeader /></table>],
    ["table-body", <table><TableBody /></table>],
    ["table-footer", <table><TableFooter /></table>],
    ["table-row", <table><tbody><TableRow /></tbody></table>],
    ["table-head", <table><thead><tr><TableHead /></tr></thead></table>],
    ["table-cell", <table><tbody><tr><TableCell /></tr></tbody></table>],
    ["table-caption", <table><TableCaption /></table>],
  ];
  const missing = cases
    .filter(([slot, element]) => !renderToStaticMarkup(element).includes(`data-slot="${slot}"`))
    .map(([slot]) => slot);
  assert.deepEqual(missing, []);
});

/** The repo-specific strings the shadcn CLI would have discarded. Asserted as
 *  source substrings so a future regeneration that drops `legacyDanger` — or the
 *  measured `h-9`, or the ported chevron — fails loudly instead of quietly. */
test("the repo's deviations from stock shadcn survived the migration", () => {
  const button = read("button.tsx");
  for (const variant of ["legacy:", "legacyPrimary:", "legacyDanger:", "legacySmall:", "legacyIcon:"]) {
    assert.ok(button.includes(variant), `button.tsx lost ${variant}`);
  }
  assert.ok(button.includes("reproduce `.btn` / `.iconBtn`"), "button.tsx lost its comment block");

  const input = code("input.tsx");
  assert.ok(input.includes("flex h-9 w-full"), "input.tsx lost the measured h-9");
  assert.ok(input.includes("text-[12.5px]") && input.includes("px-[11px] py-[9px]"), "input.tsx lost its geometry");
  assert.ok(input.includes("shadow-sm"), "input.tsx lost shadow-sm");
  assert.ok(!input.includes("md:text-sm"), "input.tsx regained md:text-sm");

  const select = code("select.tsx");
  assert.ok(select.includes("linear-gradient(45deg,transparent_50%,var(--faint)_50%)"), "select.tsx lost the chevron");
  assert.ok(select.indexOf("px-[11px]") < select.indexOf("pr-[30px]"), "select.tsx reordered px/pr");

  assert.ok(read("checkbox.tsx").includes('"grid place-content-center peer'), "checkbox.tsx lost its leading grid");
  assert.ok(read("switch.tsx").includes("h-5 w-9 shrink-0"), "switch.tsx lost its base geometry");
  assert.ok(read("switch.tsx").includes("border-2 border-transparent"), "switch.tsx lost its transparent border");
  assert.ok(read("table.tsx").includes("leading-[1.4285714]"), "table.tsx lost the measured leading");
});

test("focus rings are the v4 3px idiom everywhere a ring is drawn", () => {
  const offenders: string[] = [];
  for (const file of Object.keys(PARTS)) {
    const source = code(file);
    for (const stale of ["focus-visible:outline-none", "focus-visible:ring-1", "focus-visible:ring-2", "ring-offset-background"]) {
      if (source.includes(stale)) offenders.push(`${file}: ${stale}`);
    }
    if (source.includes("focus-visible:ring-") && !source.includes("focus-visible:ring-[3px]")) {
      offenders.push(`${file}: rings but no 3px`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the form controls carry aria-invalid styling", () => {
  for (const file of ["input.tsx", "textarea.tsx", "select.tsx", "checkbox.tsx"]) {
    assert.ok(read(file).includes("aria-invalid:border-destructive"), `${file} has no aria-invalid styling`);
  }
});
