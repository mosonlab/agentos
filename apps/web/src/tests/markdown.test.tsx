import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "../components/ui";
import { compactTokens, repoWebUrl } from "../lib/format";

test("a fenced block renders verbatim and is not processed as markdown", () => {
  const markup = renderToStaticMarkup(<Markdown text={"before\n```\n- item\n**bold**\n```\nafter"} />);
  assert.match(markup, /- item/);
  assert.match(markup, /\*\*bold\*\*/);
  // Nothing inside the fence became a list or a <strong>.
  assert.doesNotMatch(markup, /<ul/);
  assert.doesNotMatch(markup, /<strong[^>]*>bold/);
  assert.match(markup, /whitespace-pre-wrap/);
  assert.match(markup, />before</);
  assert.match(markup, />after</);
});

test("a fence with a language shows the language caption", () => {
  const markup = renderToStaticMarkup(<Markdown text={"```ts\nconst x = 1;\n```"} />);
  assert.match(markup, />ts</);
  assert.match(markup, /const x = 1;/);
});

test("an unterminated fence renders its remaining lines and drops nothing", () => {
  const markup = renderToStaticMarkup(<Markdown text={"```\nline one\nline two"} />);
  assert.match(markup, /line one\nline two/);
});

test("markdown links are anchors only for http and https", () => {
  const safe = renderToStaticMarkup(<Markdown text="see [docs](https://example.com/x) now" />);
  assert.match(safe, /<a href="https:\/\/example\.com\/x"[^>]*target="_blank"[^>]*rel="noreferrer"/);
  assert.match(safe, />docs</);

  for (const hostile of ["[a](javascript:alert(1))", "[a](/relative)", "[a](data:text/html,x)"]) {
    const markup = renderToStaticMarkup(<Markdown text={hostile} />);
    assert.doesNotMatch(markup, /<a /, hostile);
    assert.match(markup, /\[a\]\(/, hostile);
  }
});

test("lists, bold and inline code still render as before", () => {
  const markup = renderToStaticMarkup(<Markdown text={"- one\n- two\n\n1. first\n\n**bold** and `code`"} />);
  assert.match(markup, /<ul[^>]*list-disc/);
  assert.match(markup, /<ol[^>]*list-decimal/);
  assert.match(markup, /<strong[^>]*>bold<\/strong>/);
  assert.match(markup, /<code[^>]*>code<\/code>/);
});

test("compactTokens is honest about absence and never rounds to a fake zero", () => {
  assert.equal(compactTokens(null), "—");
  assert.equal(compactTokens(undefined), "—");
  assert.equal(compactTokens(0), "0");
  assert.equal(compactTokens(999), "999");
  assert.equal(compactTokens(1_000), "1K");
  assert.equal(compactTokens(8_900), "8.9K");
  // The threshold compares the rounded value: 999_999 / 1_000 renders as
  // `1000.0`, and `1000K` reads as a formatting bug rather than a number.
  assert.equal(compactTokens(999_949), "999.9K");
  assert.equal(compactTokens(999_950), "1M");
  assert.equal(compactTokens(999_999), "1M");
  assert.equal(compactTokens(1_200_000), "1.2M");
});

test("repoWebUrl recognises GitHub only", () => {
  assert.equal(repoWebUrl("https://github.com/o/r"), "https://github.com/o/r");
  assert.equal(repoWebUrl("https://github.com/o/r.git"), "https://github.com/o/r");
  assert.equal(repoWebUrl("git@github.com:o/r.git"), "https://github.com/o/r");
  assert.equal(repoWebUrl("git@github.com:o/r"), "https://github.com/o/r");
  assert.equal(repoWebUrl("https://gitlab.com/o/r"), null);
  assert.equal(repoWebUrl(null), null);
  assert.equal(repoWebUrl(""), null);
});
