import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("../../../dist/", import.meta.url).pathname;
const port = Number(process.env.TC_UX_FIXTURE_PORT ?? 4179);
const now = "2026-08-17T00:00:00.000Z";

const description = (name) => `Product Contract: TC-UX v1.0\nShared dependency and resource identity contract.\n\nStep responsibility: ${name} owns its unique responsibility.`;
const task = (id, name, status = "TODO") => ({
  id, projectId: "fixture-project", assigneeAgentId: "agent-1", repoId: "repo-1",
  templateId: null, templateStepId: null, followUpTaskId: null, name,
  description: description(name), workingDirectory: null, targetBranch: "main",
  failureReason: null, status, assigneeType: id === "t7" ? "HUMAN" : "AGENT",
  approvalGate: id === "t7", scheduleKind: "NOW", runAt: null, cron: null,
  timezone: null, maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 3,
  createdAt: now, updatedAt: now, assigneeAgent: null, repo: null, runs: [],
  chainId: "fixture-chain", chainIndex: Number(id.replace(/\D/g, "")) - 1,
  source: "MANUAL", archivedAt: null, schedulePausedAt: null,
  recurringSourceTaskId: null, templateStep: null, chainProgress: null,
  recurringLastFiredAt: null, recurringFireCount: 0,
});

const row = (position, status, extra = {}) => ({
  taskId: `t${position}`, position, chainIndex: position - 1, name: `TC-UX step ${position}`,
  stepName: `TC-UX step ${position}`, status, approvalGate: position === 7,
  assigneeType: position === 7 ? "HUMAN" : "AGENT",
  agent: position === 7 ? null : { id: "agent-1", title: "Senior developer" },
  archivedAt: null, failureReason: null, latestRun: null, startable: false,
  startAction: null, currentExecution: false, ...extra,
});

const chain = (viewId) => {
  if (viewId === "t4park") return {
    chainId: "fixture-chain", total: 7, done: 3,
    steps: [row(1, "DONE"), row(2, "DONE"), row(3, "DONE"),
      row(4, "BACKLOG", { taskId: "t4park", startable: true, startAction: "recover" }),
      row(5, "TODO"), row(6, "TODO"), row(7, "TODO")],
  };
  return {
    chainId: "fixture-chain", total: 7, done: 3,
    steps: [row(1, "DONE"), row(2, "DONE"), row(3, "DONE"),
      row(4, "DOING", { latestRun: { id: "run-4", status: "RUNNING", runNumber: 1 }, currentExecution: true }),
      row(5, "TODO"), row(6, "TODO"), row(7, "REVIEW")],
  };
};

const json = (response, value, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/api/projects") return json(response, [{ id: "fixture-project", name: "Fixture", slug: "fixture" }]);
  if (url.pathname === "/api/runners") return json(response, []);
  const main = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
  if (main) {
    const id = main[1];
    if (id === "t5") await new Promise((resolve) => setTimeout(resolve, 600));
    return json(response, id === "t4park" ? task(id, "Parked recovery", "BACKLOG") : task(id, `TC-UX step ${id.replace(/\D/g, "")}`, id === "t7" ? "REVIEW" : "TODO"));
  }
  const output = /^\/api\/tasks\/([^/]+)\/output$/.exec(url.pathname);
  if (output) {
    if (output[1] === "t3") return json(response, { id: "o3", taskId: "t3", runId: "r3", kind: "revised-plan", body: "revised-plan browser source artifact", createdAt: now, updatedAt: now });
    return json(response, { error: "Output not found" }, 404);
  }
  const activity = /^\/api\/tasks\/([^/]+)\/activity$/.exec(url.pathname);
  if (activity) return json(response, []);
  const chainPath = /^\/api\/tasks\/([^/]+)\/chain$/.exec(url.pathname);
  if (chainPath) return json(response, chain(chainPath[1]));
  if (request.method !== "GET") return json(response, {}, 200);

  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  let path = join(root, safe);
  try {
    const body = await readFile(path);
    const type = ({ ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" })[extname(path)] ?? "text/html";
    response.writeHead(200, { "Content-Type": type });
    response.end(body);
  } catch {
    path = join(root, "index.html");
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(await readFile(path));
  }
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`TC-UX fixture listening on ${port}\n`));
