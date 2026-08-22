import { type MouseEvent, type ReactNode, useCallback, useEffect, useState } from "react";

/** Hash routing keeps the app a static bundle: no dev-server rewrite rules and
 *  `vite preview` behaves exactly like `vite dev`. */

/** Everything after the `#`, path and query together. */
const currentTarget = (): string => {
  const raw = window.location.hash.replace(/^#/, "");
  return raw.length === 0 ? "/" : raw;
};

export const navigate = (target: string): void => {
  if (currentTarget() === target) return;
  window.location.hash = target;
  window.scrollTo({ top: 0 });
};

/**
 * Same location, no history entry, and no scroll.
 *
 * For state the URL should *describe* rather than be navigated to: stepping
 * through five status tabs must not cost five presses of Back to leave the
 * board. `replaceState` does not fire `hashchange`, so the event every listener
 * here is already waiting on is dispatched by hand.
 */
export const replace = (target: string): void => {
  if (currentTarget() === target) return;
  window.history.replaceState(null, "", `#${target}`);
  window.dispatchEvent(new Event("hashchange"));
};

const useHash = (): string => {
  const [raw, setRaw] = useState(currentTarget);
  useEffect(() => {
    const handler = (): void => setRaw(currentTarget());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return raw;
};

export const useRoute = (): string => useHash().split("?")[0] ?? "/";

/** Re-renders on every hash change, query included. */
export const useQuery = (): URLSearchParams => new URLSearchParams(useHash().split("?")[1] ?? "");

/** Matches `/tasks/:taskId` style patterns; returns captured params or null. */
export const matchRoute = (pattern: string, path: string): Record<string, string> | null => {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index] ?? "";
    const actual = pathParts[index] ?? "";
    if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return null;
  }
  return params;
};

export const Link = ({ to, className, children, title }: {
  to: string;
  className?: string;
  children: ReactNode;
  title?: string;
}): ReactNode => {
  const onClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate(to);
  }, [to]);
  return (
    <a href={`#${to}`} className={className} onClick={onClick} {...(title === undefined ? {} : { title })}>
      {children}
    </a>
  );
};
