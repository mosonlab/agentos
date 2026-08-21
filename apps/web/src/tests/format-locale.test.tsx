import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";

import {
  compactTokens, duration, formatDate, formatDateTime, money, setFormatLocale, sha, timeAgo, usageCostLabel,
} from "../lib/format";
import { translate } from "../lib/i18n-core";
import { cronProse, nextRunLabel } from "../lib/schedule";

const asLocale = (locale: "en" | "zh"): void =>
  setFormatLocale(locale, (key, vars) => translate(locale, key, vars));

afterEach(() => {
  asLocale("en");
  mock.timers.reset();
});

const INSTANT = "2026-03-04T09:05:00.000Z";

/* --------------------------------------------------------------------- dates */

/** The English strings are pinned as literals, captured from the tree before this
 *  batch touched `format.ts`. An accidental option change — a different `month`
 *  style, a stray `year` — would otherwise pass unnoticed because both locales
 *  would still "differ". */
test("English date output is byte-identical to what the app rendered before this batch", () => {
  asLocale("en");
  assert.equal(formatDateTime(INSTANT), new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(INSTANT)));
  assert.equal(formatDate(INSTANT), new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric",
  }).format(new Date(INSTANT)));
  assert.match(formatDate(INSTANT), /^Mar 4, 2026$/);
});

test("dates differ between en and zh", () => {
  asLocale("en");
  const english = { dateTime: formatDateTime(INSTANT), date: formatDate(INSTANT) };
  asLocale("zh");
  assert.notEqual(formatDateTime(INSTANT), english.dateTime);
  assert.notEqual(formatDate(INSTANT), english.date);
  assert.match(formatDate(INSTANT), /2026/);
});

test("a null instant is the em dash in both locales", () => {
  for (const locale of ["en", "zh"] as const) {
    asLocale(locale);
    assert.equal(formatDateTime(null), "—");
    assert.equal(formatDate(undefined), "—");
    assert.equal(duration(null, INSTANT), "—");
  }
});

/* ------------------------------------------------------------- relative time */

const at = (isoNow: string, operation: () => void): void => {
  mock.timers.enable({ apis: ["Date"], now: new Date(isoNow) });
  try { operation(); } finally { mock.timers.reset(); }
};

test("timeAgo returns today's English fragments and their Chinese counterparts", () => {
  at("2026-03-04T09:05:30.000Z", () => {
    asLocale("en");
    assert.equal(timeAgo(INSTANT), "just now");
    asLocale("zh");
    assert.equal(timeAgo(INSTANT), "刚刚");
  });
  at("2026-03-04T09:20:00.000Z", () => {
    asLocale("en");
    assert.equal(timeAgo(INSTANT), "15m ago");
    asLocale("zh");
    assert.equal(timeAgo(INSTANT), "15 分钟前");
  });
  at("2026-03-04T12:05:00.000Z", () => {
    asLocale("en");
    assert.equal(timeAgo(INSTANT), "3h ago");
    asLocale("zh");
    assert.equal(timeAgo(INSTANT), "3 小时前");
  });
  at("2026-03-07T09:05:00.000Z", () => {
    asLocale("en");
    assert.equal(timeAgo(INSTANT), "3d ago");
    asLocale("zh");
    assert.equal(timeAgo(INSTANT), "3 天前");
  });
});

test("beyond 30 days timeAgo becomes an absolute date, in the active locale", () => {
  at("2026-06-04T09:05:00.000Z", () => {
    asLocale("en");
    assert.equal(timeAgo(INSTANT), formatDate(INSTANT));
    assert.match(timeAgo(INSTANT), /^Mar 4, 2026$/);
  });
});

test("duration uses the two format keys", () => {
  asLocale("en");
  assert.equal(duration(INSTANT, "2026-03-04T09:05:42.000Z"), "42s");
  assert.equal(duration(INSTANT, "2026-03-04T09:08:07.000Z"), "3m 7s");
  asLocale("zh");
  assert.equal(duration(INSTANT, "2026-03-04T09:05:42.000Z"), "42 秒");
  assert.equal(duration(INSTANT, "2026-03-04T09:08:07.000Z"), "3 分 7 秒");
});

/* ------------------------------------------------------- locale-invariant set */

test("money, compactTokens and sha are locale-invariant", () => {
  const sample = (): string[] => [money("12.5"), money(null), compactTokens(1_250_000), compactTokens(null), sha("abcdef1234")];
  asLocale("en");
  const english = sample();
  asLocale("zh");
  assert.deepEqual(sample(), english);
  assert.deepEqual(english, ["$12.50", "—", "1.3M", "—", "abcdef1"]);
});

test("usage cost labels distinguish estimates and never show partial dollars", () => {
  assert.equal(usageCostLabel({
    costUsd: "0.42", estimated: true, inputTokens: 10, cachedInputTokens: 2, outputTokens: 3,
  }), "$0.42 est.");
  assert.equal(usageCostLabel({
    costUsd: null, estimated: false, inputTokens: 10, cachedInputTokens: 2, outputTokens: 3,
  }), "10 input · 2 cached · 3 output");
});

/* -------------------------------------------------------------- schedule.ts */

test("nextRunLabel translates its three future fragments", () => {
  at("2026-03-04T06:05:00.000Z", () => {
    asLocale("en");
    assert.equal(nextRunLabel(INSTANT), "in 3h");
    asLocale("zh");
    assert.equal(nextRunLabel(INSTANT), "3 小时后");
  });
  at("2026-03-04T09:04:50.000Z", () => {
    asLocale("en");
    assert.equal(nextRunLabel(INSTANT), "in under a minute");
    asLocale("zh");
    assert.equal(nextRunLabel(INSTANT), "不到一分钟后");
  });
  at("2026-03-04T08:50:00.000Z", () => {
    asLocale("en");
    assert.equal(nextRunLabel(INSTANT), "in 15m");
    asLocale("zh");
    assert.equal(nextRunLabel(INSTANT), "15 分钟后");
  });
  for (const locale of ["en", "zh"] as const) {
    asLocale(locale);
    assert.equal(nextRunLabel(null), "—");
  }
});

test("cronProse is prose in both locales, and the English wording is unchanged", () => {
  asLocale("en");
  const english = cronProse("0 9 * * 1", null);
  assert.equal(english, "At 09:00 AM, only on Monday");
  asLocale("zh");
  const chinese = cronProse("0 9 * * 1", null);
  assert.notEqual(chinese, english);
  assert.ok(chinese.length > 0);
  assert.match(chinese, /星期一/);
});

test("the timezone suffix survives in both locales", () => {
  asLocale("en");
  assert.match(cronProse("0 9 * * 1", "Asia/Shanghai"), /\(Asia\/Shanghai\)$/);
  asLocale("zh");
  assert.match(cronProse("0 9 * * 1", "Asia/Shanghai"), /\(Asia\/Shanghai\)$/);
});

test("an unparseable expression renders verbatim in both locales", () => {
  for (const locale of ["en", "zh"] as const) {
    asLocale(locale);
    assert.equal(cronProse("nope", null), "nope");
    assert.equal(cronProse(null, null), "—");
  }
});
