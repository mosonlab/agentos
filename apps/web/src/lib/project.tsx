import { type ReactNode, createContext, useContext, useEffect, useMemo } from "react";

import { usePoll, useLocalStorage } from "./hooks";
import type { ApiError, } from "./api";
import type { Project } from "./types";

/** Every page is scoped to one project (DECISIONS #16: data is isolated by the
 *  selected project). The selection survives reloads in localStorage. */
export type ProjectScope = {
  projects: Project[];
  project: Project | null;
  projectId: string;
  select: (id: string) => void;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
};

const ProjectContext = createContext<ProjectScope | null>(null);

export const ProjectProvider = ({ children, initialProjects }: {
  children: ReactNode;
  /** What `StartupGate` already fetched. The provider still polls, but seeding it
   *  means the first frame after the gate is the operator's project list instead
   *  of an empty sidebar that fills in a tick later. */
  initialProjects?: Project[];
}): ReactNode => {
  const { data, error, loading, reload } = usePoll<Project[]>("/projects", 5_000);
  const [projectId, select] = useLocalStorage("agentos.projectId", "");
  const projects = useMemo(() => data ?? initialProjects ?? [], [data, initialProjects]);

  useEffect(() => {
    if (projects.length === 0) return;
    if (projects.some((candidate) => candidate.id === projectId)) return;
    select(projects[0]?.id ?? "");
  }, [projects, projectId, select]);

  const value = useMemo<ProjectScope>(() => ({
    projects,
    project: projects.find((candidate) => candidate.id === projectId) ?? null,
    projectId,
    select,
    loading,
    error,
    reload,
  }), [projects, projectId, select, loading, error, reload]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
};

export const useProjectScope = (): ProjectScope => {
  const scope = useContext(ProjectContext);
  if (!scope) throw new Error("useProjectScope must be used inside ProjectProvider");
  return scope;
};
