import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Card, Pill, Segmented, Tabs } from "../components/ui";

test("Tabs and Segmented preserve the legacy direct-button structure", () => {
  const tabs = renderToStaticMarkup(<Tabs value="one" onChange={() => undefined} options={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} />);
  const segmented = renderToStaticMarkup(<Segmented value="one" onChange={() => undefined} options={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} />);
  for (const markup of [tabs, segmented]) {
    assert.equal((markup.match(/<button/g) ?? []).length, 2);
    assert.doesNotMatch(markup, /role="tablist"|aria-controls=/);
  }
});

test("Card and Pill retain their section and span host semantics", () => {
  assert.match(renderToStaticMarkup(<Card>Body</Card>), /^<section\b[^>]*shadow-none/);
  assert.match(renderToStaticMarkup(<Pill tone="grey">State</Pill>), /^<span\b[^>]*font-normal/);
});
