import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import { KeyValue, METRICS, Segmented } from "../components/ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";

/**
 * What a phone must be able to reach and read.
 *
 * The shapes below were measured at 390x844 against the production control
 * plane: a two-column definition list broke `danger-full-access` mid-word, three
 * metrics claimed a whole first screen, and every text control was 28-34px tall
 * against the 44px an operator's finger needs. The assertions are on class
 * strings because jsdom computes no layout and the breakpoint is a media query —
 * so what is pinned is the rule, not the rendered pixel.
 */

/** The one breakpoint the application has; `max-[900px]:` is not the same query
 *  and would stop a pixel short (see the note in components/ui.tsx). */
const PHONE = "[@media(max-width:900px)]:";

const source = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");

test("a definition list is one column on a phone, whatever it is on a desktop", () => {
  const markup = renderToStaticMarkup(
    <KeyValue columns={3} items={[{ k: "Codex sandbox", v: "danger-full-access" }]} />,
  );
  assert.match(markup, /grid-cols-\[repeat\(3,minmax\(0,1fr\)\)\]/);
  assert.ok(markup.includes(`${PHONE}grid-cols-[minmax(0,1fr)]`), "the phone column count is not pinned");
  // The two-column default takes the same phone rule, so no call site is left
  // holding a second column it never asked for.
  const two = renderToStaticMarkup(<KeyValue items={[{ k: "Branch", v: "main" }]} />);
  assert.ok(two.includes(`${PHONE}grid-cols-[minmax(0,1fr)]`));
});

test("metrics sit two to a row on a phone rather than one", () => {
  assert.ok(METRICS.includes(`${PHONE}grid-cols-[repeat(auto-fit,minmax(140px,1fr))]`));
});

test("the controls an operator taps are at least 44px on a phone", () => {
  const legacy = renderToStaticMarkup(<Button variant="legacy" size="legacy">Refresh</Button>);
  const small = renderToStaticMarkup(<Button variant="legacy" size="legacySmall">Edit</Button>);
  for (const markup of [legacy, small]) assert.ok(markup.includes(`${PHONE}min-h-[44px]`));
  // `min-h`, not `h`: the onboarding wizard passes `h-auto` and must still clear
  // the target rather than collapse back to its content height.
  for (const markup of [renderToStaticMarkup(<Input />), renderToStaticMarkup(<Select />)]) {
    assert.ok(markup.includes(`${PHONE}min-h-[44px]`));
  }
  const segmented = renderToStaticMarkup(
    <Segmented value="a" onChange={() => undefined} options={[{ value: "a", label: "Today" }, { value: "b", label: "7d" }]} />,
  );
  assert.ok(segmented.includes(`${PHONE}min-h-[44px]`));
});

test("the controls too small to grow carry a hit halo instead", () => {
  // A `::before` overlay is hit-tested as part of its host and takes no space in
  // the flow, which is the only way the 16px back arrow and the 28px row menu
  // reach 44px without moving the title and the card content beside them.
  const ui = source("ui.tsx");
  assert.ok(ui.includes(`export const TOUCH_HALO = "relative before:absolute before:content-[''] ${PHONE}before:-inset-[14px]"`),
    "the halo lost its shape");
  assert.ok(ui.includes("BACK_LINK = `") && ui.includes("${TOUCH_HALO}`"), "the back link lost its halo");
  assert.match(ui, /variant="icon" size="legacyIcon" className=\{TOUCH_HALO\}/);
  assert.ok(source("ui/dialog.tsx").includes(`${PHONE}before:-inset-[16px]`), "the dialog close lost its halo");
});

test("the phone status strip says it can be swiped without showing a scrollbar", () => {
  const list = source("mobile-task-list.tsx");
  // Two elements: the fade is painted by the bar, which does not scroll, and the
  // tablist is the scroller inside it. One element cannot do both — an overlay
  // inside a scroll container travels with the content it is meant to fade.
  assert.match(list, /const TABS_BAR = "sticky top-\[52px\][^"]*after:bg-\[linear-gradient\(to_right,transparent,var\(--popover\)\)\]"/);
  assert.match(list, /const TABS = "flex gap-\[6px\] overflow-x-auto \[scrollbar-width:none\] \[&::-webkit-scrollbar\]:hidden/);
  assert.match(list, /<div className=\{TABS_BAR\}>\s*<div className=\{TABS\} role="tablist"/);
});
