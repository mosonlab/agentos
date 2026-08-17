import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { formatDateTime, setFormatLocale } from "../lib/format";
import { type Dictionary, DICTIONARIES, interpolate, isLocale, LOCALE_KEY, type Locale, translate } from "../lib/i18n-core";
import { LocaleProvider, useLocale, useT, useTNodes } from "../lib/i18n";
import { storage } from "../lib/storage";

const { en, zh } = DICTIONARIES;

const placeholders = (value: string): string[] =>
  [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

test("the two dictionaries have the same key set, asserted both directions", () => {
  const missingFromZh = Object.keys(en).filter((key) => !(key in zh));
  const missingFromEn = Object.keys(zh).filter((key) => !(key in en));
  assert.deepEqual(missingFromZh, []);
  assert.deepEqual(missingFromEn, []);
  assert.ok(Object.keys(en).length > 0);
});

test("no value in either dictionary is empty or whitespace-only", () => {
  const empty: string[] = [];
  for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
    for (const [key, value] of Object.entries(dictionary)) {
      if (value.trim().length === 0) empty.push(`${locale}:${key}`);
    }
  }
  assert.deepEqual(empty, []);
});

test("Chinese dictionary values do not repeat English prose outside technical identifiers", () => {
  // Product names, CLI/runtime vocabulary, code-shaped placeholders and protocol
  // identifiers remain untranslated by design. Human-facing prose does not.
  const technicalValues = new Set([
    "Agent", "Agents", "Bash", "Claude", "Codex", "Cron", "Daemon", "Endpoint",
    "English", "Environment ID", "Glob", "Grep", "Inbox", "Pi", "Pull request",
    "Runner", "Slug", "cron", "provider/model:effort", "rev", "webhook",
    "Implement feat/inbox-search", "runner {runner}", "{runner} CLI {version}",
  ]);
  const repeatedProse = Object.keys(en).filter((key) =>
    en[key] === zh[key] && /[A-Za-z]{2}/u.test(en[key]!) && !technicalValues.has(en[key]!),
  );
  assert.deepEqual(repeatedProse, []);
});

test("every key carries the same placeholder set in both locales", () => {
  const mismatched = Object.keys(en)
    .filter((key) => placeholders(en[key]!).join(",") !== placeholders(zh[key] ?? "").join(","))
    .map((key) => `${key}: en=${placeholders(en[key]!).join("|")} zh=${placeholders(zh[key] ?? "").join("|")}`);
  assert.deepEqual(mismatched, []);
});

test("the dictionaries are sorted within their blocks, so a duplicate key is visible", () => {
  // Not a full sort assertion — the files are grouped by namespace with blank
  // lines between groups. Within a namespace the keys must ascend.
  const outOfOrder: string[] = [];
  const byNamespace = new Map<string, string[]>();
  for (const key of Object.keys(en)) {
    const namespace = key.slice(0, key.indexOf("."));
    byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), key]);
  }
  for (const [namespace, keys] of byNamespace) {
    if (keys.join(",") !== [...keys].sort().join(",")) outOfOrder.push(namespace);
  }
  assert.deepEqual(outOfOrder, []);
});

test("the fallback chain is zh -> en -> key, and a miss never renders empty", () => {
  const fixtures: Record<Locale, Dictionary> = {
    en: { "a.only-en": "English only", "a.both": "English both" },
    zh: { "a.both": "中文 both" },
  };
  assert.equal(translate("zh", "a.both", undefined, fixtures), "中文 both");
  assert.equal(translate("zh", "a.only-en", undefined, fixtures), "English only");
  assert.equal(translate("zh", "a.nowhere", undefined, fixtures), "a.nowhere");
  assert.equal(translate("en", "a.nowhere", undefined, fixtures), "a.nowhere");
});

test("interpolation replaces named placeholders and leaves an unmatched one visible", () => {
  assert.equal(interpolate("{n} left", { n: 3 }), "3 left");
  assert.equal(interpolate("{a} and {b}", { a: "x" }), "x and {b}");
  assert.equal(interpolate("no vars"), "no vars");
});

test("isLocale accepts exactly the two shipped tags", () => {
  assert.ok(isLocale("en"));
  assert.ok(isLocale("zh"));
  for (const value of ["de", "", null, undefined, "EN", 1]) assert.equal(isLocale(value), false);
});

/* --------------------------------------------------------------- persistence */

const withStorage = <T,>(operation: () => T): T => {
  const held = storage.get(LOCALE_KEY);
  try {
    return operation();
  } finally {
    if (held === null) storage.remove(LOCALE_KEY); else storage.set(LOCALE_KEY, held);
  }
};

const Probe = (): string => {
  const t = useT();
  const { locale } = useLocale();
  return `${locale}:${t("sidebar.settings")}`;
};

test("an absent or unrecognised agentos.locale means en", () => {
  withStorage(() => {
    storage.remove(LOCALE_KEY);
    assert.match(renderToStaticMarkup(<LocaleProvider><Probe /></LocaleProvider>), /en:Settings/);
    storage.set(LOCALE_KEY, "de");
    assert.match(renderToStaticMarkup(<LocaleProvider><Probe /></LocaleProvider>), /en:Settings/);
    storage.set(LOCALE_KEY, "zh");
    assert.match(renderToStaticMarkup(<LocaleProvider><Probe /></LocaleProvider>), /zh:设置/);
  });
});

test("useT and useLocale fall back to en with no provider, rather than throwing", () => {
  assert.match(renderToStaticMarkup(<Probe />), /en:Settings/);
});

test("initialLocale overrides storage, which is what the Chinese tests use", () => {
  withStorage(() => {
    storage.set(LOCALE_KEY, "en");
    assert.match(renderToStaticMarkup(<LocaleProvider initialLocale="zh"><Probe /></LocaleProvider>), /zh:设置/);
  });
});

/* ------------------------------------------------------- node interpolation */

const Banner = (): ReactNode => {
  const tn = useTNodes();
  return <div>{tn("errors.route.unknown", { path: <code>/nope</code> })}</div>;
};

test("a node substitution keeps the markup out of the dictionary, in both locales", () => {
  // Byte-identical to what App.tsx rendered before batch 1 — the Chinese value
  // is the pre-batch wording and the <code> comes from the caller's tree.
  assert.equal(
    renderToStaticMarkup(<LocaleProvider initialLocale="zh"><Banner /></LocaleProvider>),
    "<div>未知路由 <code>/nope</code>。</div>",
  );
  assert.equal(
    renderToStaticMarkup(<LocaleProvider initialLocale="en"><Banner /></LocaleProvider>),
    "<div>Unknown route <code>/nope</code>.</div>",
  );
});

const Unmatched = (): ReactNode => {
  const tn = useTNodes();
  return <div>{tn("errors.unreachable", { base: "/api" })}</div>;
};

test("a placeholder with no node renders as itself rather than vanishing", () => {
  // The same contract `interpolate` keeps: a missing substitution has to be
  // visible, because a silently blank banner reads as working copy.
  const markup = renderToStaticMarkup(<LocaleProvider initialLocale="en"><Unmatched /></LocaleProvider>);
  assert.match(markup, /\/api/);
  assert.match(markup, /\{command\}/);
});

/* ---------------------------------------------------- the format.ts seam */

/**
 * The assertion that would have caught the revision-0 ordering bug: the provider
 * must hand `setFormatLocale` a TWO-argument callback. `translate` is
 * `(locale, key, vars)`, so passing it bare is a type error, and the registration
 * has to happen during render rather than in an effect — `renderToStaticMarkup`
 * runs no effects, so a registration in `useEffect` would leave the module in
 * English here.
 */
test("the provider registers a two-argument translator during render", () => {
  const instant = "2026-03-04T09:05:00.000Z";
  try {
    renderToStaticMarkup(<LocaleProvider initialLocale="en"><Probe /></LocaleProvider>);
    const english = formatDateTime(instant);
    assert.match(english, /^[A-Z][a-z]{2} \d/);

    renderToStaticMarkup(<LocaleProvider initialLocale="zh"><Probe /></LocaleProvider>);
    assert.notEqual(formatDateTime(instant), english);
  } finally {
    setFormatLocale("en", (key, vars) => translate("en", key, vars));
  }
});
