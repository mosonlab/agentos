const sections = [
  "Agents",
  "Skills",
  "Files",
  "MCPs",
  "Repos",
  "Secrets",
  "Tasks",
  "Goals",
  "Inbox",
  "Triggers",
  "Automations",
  "Sessions",
  "Activity",
] as const;

export const App = () => (
  <div className="shell">
    <aside className="sidebar">
      <div className="brand">
        <span className="brandMark">A</span>
        <div>
          <strong>AgentOS</strong>
          <small>Local control plane</small>
        </div>
      </div>

      <nav aria-label="Control-plane sections">
        {sections.map((section, index) => (
          <a
            className={index === 0 ? "active" : undefined}
            href={`#${section.toLowerCase()}`}
            key={section}
          >
            {section}
          </a>
        ))}
      </nav>
    </aside>

    <main>
      <header>
        <div>
          <span className="eyebrow">PHASE 0</span>
          <h1>Agent control plane</h1>
        </div>
        <span className="status">Local</span>
      </header>

      <section className="emptyState">
        <div className="pulse" />
        <h2>The foundation is ready.</h2>
        <p>
          Projects, agents, tasks, and sessions will arrive in Phase 1. This
          shell already reserves the control-plane surfaces from the blueprint.
        </p>
      </section>
    </main>
  </div>
);

