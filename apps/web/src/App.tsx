import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Status = "TODO" | "DOING" | "REVIEW" | "DONE";
type Project = { id: string; name: string };
type Agent = { id: string; name: string; title: string; runnerPreference: string };
type Session = { id: string; status: string; failureReason: string | null };
type Task = {
  id: string;
  name: string;
  description: string;
  workingDirectory: string | null;
  failureReason: string | null;
  status: Status;
  assigneeAgentId: string | null;
  assigneeAgent: Agent | null;
  sessions: Session[];
};
type Activity = { id: string; actorType: string; body: string; createdAt: string; metadata?: { stream?: string; failed?: boolean } };

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const defaultToken = import.meta.env.VITE_API_TOKEN ?? "";
const columns: { status: Status; title: string; caption: string }[] = [
  { status: "TODO", title: "Todo", caption: "Ready to claim" },
  { status: "DOING", title: "Doing", caption: "Runner active" },
  { status: "REVIEW", title: "Review", caption: "Needs your decision" },
  { status: "DONE", title: "Done", caption: "Human approved" },
];

const api = async <T,>(path: string, token: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.status === 204 ? undefined as T : await response.json() as T;
};

export const App = () => {
  const [token, setToken] = useState(() => localStorage.getItem("agentos-token") ?? defaultToken);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");

  const loadProjects = useCallback(async () => {
    if (!token) return;
    try {
      const result = await api<Project[]>("/projects", token);
      setProjects(result);
      setProjectId((current) => current || result[0]?.id || "");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [token]);

  const loadBoard = useCallback(async () => {
    if (!token || !projectId) return;
    try {
      const [nextAgents, nextTasks] = await Promise.all([
        api<Agent[]>(`/projects/${projectId}/agents`, token),
        api<Task[]>(`/tasks?projectId=${encodeURIComponent(projectId)}`, token),
      ]);
      setAgents(nextAgents);
      setTasks(nextTasks);
      setSelected((current) => current ? nextTasks.find((task) => task.id === current.id) ?? null : null);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [projectId, token]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);
  useEffect(() => {
    void loadBoard();
    const timer = window.setInterval(() => void loadBoard(), 4_000);
    return () => window.clearInterval(timer);
  }, [loadBoard]);
  useEffect(() => {
    if (!selected) { setActivity([]); return; }
    const load = (): void => { void api<Activity[]>(`/tasks/${selected.id}/activity`, token).then(setActivity).catch(() => undefined); };
    load();
    const timer = window.setInterval(load, 2_000);
    return () => window.clearInterval(timer);
  }, [selected?.id, token]);

  const grouped = useMemo(() => Object.fromEntries(columns.map(({ status }) => [status, tasks.filter((task) => task.status === status)])) as Record<Status, Task[]>, [tasks]);

  const saveToken = (value: string): void => {
    localStorage.setItem("agentos-token", value);
    setToken(value);
  };

  const createTask = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await api(`/projects/${projectId}/tasks`, token, {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          description: data.get("description"),
          workingDirectory: data.get("workingDirectory"),
          assigneeAgentId: data.get("assigneeAgentId"),
        }),
      });
      setShowCreate(false);
      await loadBoard();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const moveToDone = async (taskId: string): Promise<void> => {
    await api(`/tasks/${taskId}`, token, { method: "PATCH", body: JSON.stringify({ status: "DONE" }) });
    await loadBoard();
  };

  if (!token) {
    return <main className="login"><div className="loginCard"><span className="brandMark">A</span><h1>Connect to AgentOS</h1><p>Enter the shared bearer token from your <code>.env</code>.</p><input aria-label="Bearer token" type="password" onKeyDown={(event) => { if (event.key === "Enter") saveToken(event.currentTarget.value); }} placeholder="Bearer token" /></div></main>;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brandMark">A</span><div><strong>AgentOS</strong><small>Local control plane</small></div></div>
        <nav><a className="active" href="#tasks">Tasks</a><a href="#agents">Agents</a><a href="#sessions">Sessions</a><a href="#activity">Activity</a></nav>
        <div className="sidebarFoot"><span className="dot" /> Runner control plane</div>
      </aside>

      <main className="workspace">
        <header>
          <div><span className="eyebrow">PHASE 1 · TASKS</span><h1>Task board</h1><p>Assign work, watch agents run, and approve completed tasks.</p></div>
          <div className="headerActions">
            <select aria-label="Project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
            <button className="primary" disabled={!projectId || agents.length === 0} onClick={() => setShowCreate(true)}>+ New task</button>
          </div>
        </header>
        {error && <div className="error"><span>{error}</span><button onClick={() => saveToken("")}>Change token</button></div>}
        <section className="board" aria-label="Kanban board">
          {columns.map((column) => (
            <div className="column" key={column.status} onDragOver={(event) => { if (column.status === "DONE") event.preventDefault(); }} onDrop={(event) => {
              if (column.status !== "DONE") return;
              const task = tasks.find((item) => item.id === event.dataTransfer.getData("text/task-id"));
              if (task?.status === "REVIEW") void moveToDone(task.id).catch((reason: unknown) => setError(String(reason)));
            }}>
              <div className="columnHead"><div><h2>{column.title}</h2><span>{column.caption}</span></div><b>{grouped[column.status].length}</b></div>
              <div className="cards">
                {grouped[column.status].map((task) => <article className={`card ${task.failureReason ? "failed" : ""}`} draggable={task.status === "REVIEW"} key={task.id} onDragStart={(event) => event.dataTransfer.setData("text/task-id", task.id)} onClick={() => setSelected(task)}>
                  <div className="cardTop"><span className={`agentAvatar ${task.assigneeAgent?.runnerPreference.toLowerCase()}`}>{task.assigneeAgent?.name.slice(0, 1).toUpperCase() ?? "?"}</span><span className="runner">{task.assigneeAgent?.runnerPreference.toLowerCase() ?? "unassigned"}</span></div>
                  <h3>{task.name}</h3><p>{task.description || "No description"}</p>
                  <div className="cardFoot"><span>{task.assigneeAgent?.name ?? "Unassigned"}</span>{task.status === "REVIEW" && <span className="dragHint">Drag to done →</span>}</div>
                </article>)}
                {grouped[column.status].length === 0 && <div className="empty">No tasks</div>}
              </div>
            </div>
          ))}
        </section>
      </main>

      {showCreate && <div className="modalBackdrop" onMouseDown={() => setShowCreate(false)}><form className="modal" onSubmit={(event) => void createTask(event)} onMouseDown={(event) => event.stopPropagation()}><div className="modalHead"><div><span className="eyebrow">NEW WORK</span><h2>Create task</h2></div><button type="button" className="iconButton" onClick={() => setShowCreate(false)}>×</button></div><label>Title<input name="name" required autoFocus /></label><label>Description<textarea name="description" rows={5} /></label><label>Working directory<input name="workingDirectory" required placeholder="/absolute/path/to/existing/repo" /></label><label>Agent<select name="assigneeAgentId" required defaultValue={agents.find((agent) => agent.name === "default")?.id ?? agents[0]?.id}>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name} · {agent.runnerPreference.toLowerCase()}</option>)}</select></label><div className="modalActions"><button type="button" onClick={() => setShowCreate(false)}>Cancel</button><button className="primary" type="submit">Create task</button></div></form></div>}

      {selected && <aside className="drawer"><div className="drawerHead"><div><span className="eyebrow">TASK DETAIL</span><h2>{selected.name}</h2></div><button className="iconButton" onClick={() => setSelected(null)}>×</button></div><div className="taskMeta"><span className={`pill ${selected.status.toLowerCase()}`}>{selected.status.toLowerCase()}</span><span>{selected.assigneeAgent?.name}</span></div><p className="description">{selected.description || "No description"}</p>{selected.failureReason && <div className="failureBanner">Failed: {selected.failureReason}</div>}<code className="path">{selected.workingDirectory}</code><div className="activityHead"><h3>Activity</h3><span>refreshes every 2s</span></div><div className="activityList">{activity.map((item) => <div className={`activityItem ${item.metadata?.failed ? "failure" : ""}`} key={item.id}><div><b>{item.actorType}</b><time>{new Date(item.createdAt).toLocaleTimeString()}</time></div><pre>{item.body}</pre></div>)}{activity.length === 0 && <div className="empty">No activity yet</div>}</div></aside>}
    </div>
  );
};
