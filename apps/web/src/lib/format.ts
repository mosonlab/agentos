const DATE_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

export const formatDateTime = (value: string | null | undefined): string =>
  value ? DATE_TIME.format(new Date(value)) : "—";

export const formatDate = (value: string | null | undefined): string =>
  value ? DATE.format(new Date(value)) : "—";

export const timeAgo = (value: string | null | undefined): string => {
  if (!value) return "—";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : formatDate(value);
};

export const duration = (from: string | null | undefined, to: string | null | undefined): string => {
  if (!from) return "—";
  const end = to ? new Date(to).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
};

/** Decimal columns arrive as strings; `null` means the runner never reported cost. */
export const money = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? "—" : `$${Number(value).toFixed(2)}`;

export const sha = (value: string | null | undefined): string => (value ? value.slice(0, 7) : "—");

export const titleCase = (value: string): string =>
  value.toLowerCase().replace(/[_-]/g, " ").replace(/(^|\s)\S/g, (match) => match.toUpperCase());

/** First non-empty line — inbox rows show it as the message title. */
export const firstLine = (body: string): string => {
  const line = body.split("\n").find((candidate) => candidate.trim().length > 0);
  return (line ?? "").replace(/[*`#]/g, "").trim();
};

export const restLines = (body: string): string => {
  const lines = body.split("\n");
  const index = lines.findIndex((candidate) => candidate.trim().length > 0);
  return lines.slice(index + 1).join(" ").replace(/[*`#]/g, "").replace(/\s+/g, " ").trim();
};

export const initial = (value: string): string => (value.trim()[0] ?? "?").toUpperCase();

/** Token counts, shortened for a stat pill. `null` means the runner never
 *  reported usage — never `0`, which would read as "this run spent nothing". */
export const compactTokens = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const short = (divided: number, suffix: string): string =>
    `${divided.toFixed(1).replace(/\.0$/, "")}${suffix}`;
  // Thresholds compare the *rounded* value, not the raw one: at exactly
  // 1_000_000 the raw test renders 999_999 as `1000K`, which reads as a
  // formatting bug rather than a number. 999_950 is where `toFixed(1)` of
  // `value / 1_000` first reaches `1000.0`.
  if (Math.abs(value) >= 999_950) return short(value / 1_000_000, "M");
  if (Math.abs(value) >= 999.95) return short(value / 1_000, "K");
  return String(value);
};

/** A repo remote as a browsable GitHub URL, or `null` when it is anything else.
 *  No other forge is recognised: a wrong guess would render a broken link. */
export const repoWebUrl = (remoteUrl: string | null | undefined): string | null => {
  if (!remoteUrl) return null;
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remoteUrl);
  if (https) return `https://github.com/${https[1]}/${https[2]}`;
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remoteUrl);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  return null;
};

export const compact = (value: unknown, max = 160): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
