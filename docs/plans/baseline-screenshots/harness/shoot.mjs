// Baseline screenshot driver (W0). Headless Chrome over CDP; its own
// --user-data-dir so it cannot disturb the operator's browser.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const ORIGIN = "http://localhost:5199";
const OUT = process.argv[2];
const PROFILE = "/tmp/agentos-mock/chrome-profile";

mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--hide-scrollbars", "--force-color-profile=srgb", "--force-device-scale-factor=1",
  "--window-size=1440,1000", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const targets = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
    catch { await sleep(300); }
  }
  throw new Error("chrome never opened its debugging port");
};

const list = await targets();
const page = list.find((entry) => entry.type === "page");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

let nextId = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = (nextId += 1);
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

await send("Page.enable");
await send("Runtime.enable");

// The app is hash-routed (lib/router.tsx), so a path lives after "#". Reload
// rather than relying on hashchange, so each frame boots with the theme that
// was just written to localStorage.
const goto = async (path) => {
  await send("Page.navigate", { url: `${ORIGIN}/#${path}` });
  await sleep(600);
  await send("Page.reload");
  await sleep(3000);
};

const setViewport = (width, height) =>
  send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });

const shoot = async (name, clip) => {
  const height = clip ? clip.height : await evaluate(
    "Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 1000)");
  const full = clip ?? { x: 0, y: 0, width: 1440, height: Math.ceil(height), scale: 1 };
  const { data } = await send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: true, clip: full,
  });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, "base64"));
  console.log(`${name}.png  ${full.width}x${full.height} @${full.scale}`);
};

const PAGES = [
  ["agents", "/agents"],
  ["taskdetail", "/tasks/tsk_impl"],
  ["goals", "/goals"],
  ["secrets", "/secrets"],
  ["tasks", "/tasks"],
  ["projects", "/projects"],
  ["connections", "/connections"],
  ["inbox", "/inbox"],
];

await setViewport(1440, 1000);
await goto("/tasks");

for (const theme of ["light", "dark"]) {
  await evaluate(`(() => {
    localStorage.setItem("agentos.theme", ${JSON.stringify(theme)});
    localStorage.setItem("agentos.projectId", "prj_agentos");
    return true;
  })()`);

  for (const [name, path] of PAGES) {
    await goto(path);
    await shoot(`${name}-${theme}`);
  }

  // Targeted: the Agents detail page's toggle switches, close up (G2's only
  // evidence). The Capabilities tab shows switches in both states at once.
  await goto("/agents/agt_frontend");
  // Located by label, not by `.tabs button`: that class only exists before W13.
  // Works against both the legacy and the migrated DOM.
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Capabilities");
    if (tab) tab.click();
    return true;
  })()`);
  await sleep(1200);
  const box = await evaluate(`(() => {
    const knobs = [...document.querySelectorAll('[role="switch"]')];
    if (knobs.length === 0) return null;
    const boxes = knobs.map((k) => k.getBoundingClientRect());
    const top = Math.min(...boxes.map((b) => b.top));
    const bottom = Math.max(...boxes.map((b) => b.bottom));
    const left = Math.min(...boxes.map((b) => b.left));
    return { x: Math.max(0, left - 430), y: Math.max(0, top + window.scrollY - 26),
             w: 480, h: Math.min(330, Math.ceil(bottom - top) + 52) };
  })()`);
  if (box) await shoot(`agents-toggle-${theme}`, { x: box.x, y: box.y, width: box.w, height: box.h, scale: 3 });
  else console.log(`!! no toggle found for ${theme}`);

  // Targeted: the Tasks kanban board, including a column in its resting state.
  await goto("/tasks");
  // Likewise: `.board` is gone after W13, so fall back to the element whose four
  // children are the status columns. Same element, same clip, either way.
  const board = await evaluate(`(() => {
    const heads = ["Todo", "Doing", "Review", "Done"];
    const el = document.querySelector(".board") ?? [...document.querySelectorAll("div")].find((node) =>
      node.children.length === 4 &&
      [...node.children].every((child, i) => child.textContent.trim().startsWith(heads[i])));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.left - 12), y: Math.max(0, r.top + window.scrollY - 12),
             w: Math.ceil(r.width) + 24, h: Math.ceil(r.height) + 24 };
  })()`);
  if (board) await shoot(`tasks-board-${theme}`, { x: board.x, y: board.y, width: board.w, height: board.h, scale: 2 });
  else console.log(`!! no board found for ${theme}`);
}

socket.close();
chrome.kill();
