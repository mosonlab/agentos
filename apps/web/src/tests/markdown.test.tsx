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

test("hard-wrapped ordered items stay in one list and keep their text", () => {
  const markup = renderToStaticMarkup(<Markdown text={"1. first item\n  first continuation\n2. second item\n   second continuation\n3. third item\n  third continuation"} />);
  assert.equal((markup.match(/<ol\b/g) ?? []).length, 1);
  assert.equal((markup.match(/<li\b/g) ?? []).length, 3);
  assert.match(markup, /first item first continuation/);
  assert.match(markup, /second item second continuation/);
  assert.match(markup, /third item third continuation/);
});

test("ordered lists preserve a non-one starting number", () => {
  const markup = renderToStaticMarkup(<Markdown text={"4. fourth\n5. fifth"} />);
  assert.match(markup, /<ol[^>]*start="4"[^>]*>/);
});

test("hard-wrapped unordered items stay in one list and keep their text", () => {
  const markup = renderToStaticMarkup(<Markdown text={"- first item\n   first continuation\n- second item\n  second continuation"} />);
  assert.equal((markup.match(/<ul\b/g) ?? []).length, 1);
  assert.equal((markup.match(/<li\b/g) ?? []).length, 2);
  assert.match(markup, /first item first continuation/);
  assert.match(markup, /second item second continuation/);
});

test("headings, blank lines, inline code and fenced blocks remain separated", () => {
  const markup = renderToStaticMarkup(<Markdown text={"# Heading\n\n- item\n  wrapped\n\n1. numbered\n\n`inline`\n\n```\n- raw\n```"} />);
  assert.match(markup, /<strong[^>]*>Heading<\/strong>/);
  assert.equal((markup.match(/<ul\b/g) ?? []).length, 1);
  assert.equal((markup.match(/<ol\b/g) ?? []).length, 1);
  assert.match(markup, /<code[^>]*>inline<\/code>/);
  assert.match(markup, /- raw/);
  assert.doesNotMatch(markup, /<li[^>]*>[^<]*raw/);
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
  assert.equal(repoWebUrl("ssh://git@github.com/o/r.git"), "https://github.com/o/r");
  assert.equal(repoWebUrl("ssh://git@github.com/o/r"), "https://github.com/o/r");
  assert.equal(repoWebUrl("ssh://git@github.com/mosonlab/anneal.git"), "https://github.com/mosonlab/anneal");
  assert.equal(repoWebUrl("ssh://git@github.com/mosonlab/anneal"), "https://github.com/mosonlab/anneal");
  // A different SSH user or host is not a shape we can browse.
  assert.equal(repoWebUrl("ssh://deploy@github.com/o/r.git"), null);
  assert.equal(repoWebUrl("ssh://GIT@github.com/o/r.git"), null);
  assert.equal(repoWebUrl("ssh://git@gitlab.com/o/r.git"), null);
  assert.equal(repoWebUrl("ssh://git@github.com/o/r?tab=readme"), null);
  assert.equal(repoWebUrl("ssh://git@github.com/o/r#readme"), null);
  assert.equal(repoWebUrl("ssh://git@github.com/o/r/"), null);
  assert.equal(repoWebUrl("https://gitlab.com/o/r"), null);
  assert.equal(repoWebUrl(null), null);
  assert.equal(repoWebUrl(""), null);
});
