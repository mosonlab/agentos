/**
 * A DOM before the component modules load.
 *
 * Radix decides once, at import time, whether it is running in a browser:
 * `useLayoutEffect` degrades to a no-op and a portal never mounts when
 * `globalThis.document` was undefined while its modules were evaluated. A test
 * file that imports a page and then installs jsdom has already lost that
 * decision, so any dialog the page renders is silently absent from the markup.
 *
 * Importing this module first installs the globals before those decisions are
 * made. `mountPage` still installs its own jsdom per test and restores what was
 * here when it disposes.
 */
import { installDom } from "./dom-harness";

installDom();
// Only the import-time decision belongs to this module. A `window` left behind
// would also leave a `localStorage` that module-level setup writes to and the
// per-test jsdom then replaces, so a page would read back nothing where today
// it reads the memory fallback `storage` keeps for a missing `window`.
Reflect.deleteProperty(globalThis, "window");
