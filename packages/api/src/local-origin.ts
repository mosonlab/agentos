/**
 * Which browser origins the control plane answers cross-origin.
 *
 * In the supported v0.1.0 path the browser never asks cross-origin at all: the
 * Vite dev/preview server proxies `/api` on its own origin and attaches the
 * operator token in its own process, so these requests are same-origin and CORS
 * is not consulted. This list is therefore a boundary, not a transport — it
 * exists so that a page on any other origin cannot read a control-plane response
 * out of a browser that has been pointed at the API directly.
 *
 * `origin: "*"` used to stand here, which is the one value that makes the
 * boundary vacuous. `hono/cors` compares this list by exact string equality —
 * no prefix or suffix matching, because `http://127.0.0.1:5173.evil.example`
 * starts with the right thing.
 */

/** Vite's dev port, as configured in `apps/web/vite.config.ts`. */
export const WEB_DEV_PORT = 5173;

/** Vite's preview port, as configured in `apps/web/vite.config.ts`. */
export const WEB_PREVIEW_PORT = 4173;

/**
 * The exact origins, spelled as a browser spells them. Numeric loopback only:
 * `http://localhost:5173` is a different origin to a browser, and it is also a
 * name whose resolution this process does not control.
 */
export const LOOPBACK_BROWSER_ORIGINS: readonly string[] = Object.freeze([
  `http://127.0.0.1:${WEB_DEV_PORT}`,
  `http://127.0.0.1:${WEB_PREVIEW_PORT}`,
]);

/** Any numeric-loopback http origin, whatever port it was started on. The port
 *  bound is checked separately: this pattern admits five digits, and only 65535
 *  of those are ports. */
const LOOPBACK_ORIGIN_SHAPE = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u;

const HIGHEST_PORT = 65_535;

/**
 * Whether a request carrying this `Origin` may reach a handler at all.
 *
 * This is a different question from the CORS allowlist above, which decides
 * which origin may *read* a response. `hono/cors` does not refuse anything: a
 * cross-origin request from a foreign page still executes and still commits its
 * side effect, and the browser merely withholds the answer from the caller. That
 * is the correct CORS semantic, and it is why the Vite guard was for a while the
 * only thing standing between a page the operator happened to visit and a task
 * that runs Codex on the host — a single barrier, which then turned out to have
 * a hole (review S-1).
 *
 * So the control plane refuses on its own account, and it refuses by *shape*
 * rather than against the two-entry allowlist: the dev server may legitimately
 * be started on another port, `apps/web`'s own guard already adapts to the port
 * it actually bound, and pinning 5173/4173 here would 403 a working `vite
 * --port 5199`. No page served from the internet can present a `127.0.0.1`
 * origin, which is exactly the blast radius S-1 described.
 *
 * An absent `Origin` is admitted: that is a same-origin navigation, the runner,
 * the CLI or a local `curl`, none of which a browser can forge an absence for on
 * a cross-origin write.
 */
export const originMayReachHandlers = (origin: string | undefined | null): boolean => {
  if (origin === undefined || origin === null) return true;
  const value = origin.trim();
  if (value === "") return true;
  const shape = LOOPBACK_ORIGIN_SHAPE.exec(value);
  return shape !== null && Number(shape[1]) <= HIGHEST_PORT;
};
