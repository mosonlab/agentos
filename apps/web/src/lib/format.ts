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

export const compact = (value: unknown, max = 160): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
