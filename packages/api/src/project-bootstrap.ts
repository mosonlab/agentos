import {
  applyCanonicalInstallation,
  loadAgentSources,
  loadAllTemplateStepSources,
  NetworkingMode,
  planCanonicalInstallation,
  Prisma,
  PR_TEMPLATE_NAME,
  type AgentSources,
  type CanonicalTemplateName,
  type Project,
  type PrismaClient,
  type TemplateStepSource,
} from "@anneal/db";
import { z } from "zod";

/** The public fields accepted by `POST /projects`. */
const projectFields = {
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  yamlDocument: z.string(),
};

export const projectInput = z.object({
  ...projectFields,
  yamlDocument: projectFields.yamlDocument.default(""),
});

export type ProjectInput = z.infer<typeof projectInput>;

/**
 * Only these canonical roles are installed in a newly created Project. The
 * source loader still reads and validates the complete agents/ contract, but
 * a Project bootstrap must not silently broaden its installed role set.
 */
export const PROJECT_BOOTSTRAP_ROLE_NAMES = [
  "senior-dev-luna",
  "review-coordinator-sol",
  "review-coordinator-opus",
  "senior-dev",
] as const;

export type ProjectBootstrapRoleLoader = () => Promise<AgentSources>;
export type ProjectBootstrapTemplateLoader = () => Promise<
  ReadonlyMap<CanonicalTemplateName, readonly TemplateStepSource[]>
>;

/** Source capabilities are explicit so route tests can replace filesystem
 * reads without replacing the database operation itself. */
export type ProjectBootstrapLoaders = Readonly<{
  loadAgentSources: ProjectBootstrapRoleLoader;
  loadAllTemplateStepSources: ProjectBootstrapTemplateLoader;
}>;

export const defaultProjectBootstrapLoaders: ProjectBootstrapLoaders = {
  loadAgentSources,
  loadAllTemplateStepSources,
};

export const PROJECT_SLUG_TAKEN = "project-slug-taken" as const;
export const PROJECT_SLUG_TAKEN_MESSAGE = "Project slug is already taken";

export type CreateProjectResult =
  | { ok: true; project: Project }
  | { ok: false; code: typeof PROJECT_SLUG_TAKEN; message: typeof PROJECT_SLUG_TAKEN_MESSAGE };

const isProjectSlugTaken = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034");

const requireRoleSources = (sources: AgentSources): Map<string, AgentSources["roles"][number]> => {
  const rolesByName = new Map(sources.roles.map((role) => [role.name, role]));
  for (const roleName of PROJECT_BOOTSTRAP_ROLE_NAMES) {
    if (!rolesByName.has(roleName)) {
      throw new Error(`Canonical role ${roleName} was not found`);
    }
  }
  return rolesByName;
};

const requireTemplateSource = (
  sources: ReadonlyMap<CanonicalTemplateName, readonly TemplateStepSource[]>,
): readonly TemplateStepSource[] => {
  const steps = sources.get(PR_TEMPLATE_NAME);
  if (!steps) throw new Error(`Canonical template source ${PR_TEMPLATE_NAME} was not found`);
  return steps;
};

/**
 * Create a Project with the roles and pull-request workflow it needs to be
 * immediately usable. Filesystem-backed source loading and all source shape
 * checks happen before the transaction opens; the Project, Environment,
 * Agents, and canonical template are one atomic Serializable write.
 */
export const createProjectBootstrap = async (
  db: PrismaClient,
  input: ProjectInput,
  loaders: Partial<ProjectBootstrapLoaders> = {},
): Promise<CreateProjectResult> => {
  // Keep validation pure and before any source I/O or database access. Parsing
  // here as well as at the route boundary makes direct operation callers safe.
  const parsedInput = projectInput.parse(input);
  const sourceLoaders: ProjectBootstrapLoaders = {
    ...defaultProjectBootstrapLoaders,
    ...loaders,
  };
  const [agentSources, allTemplateSources] = await Promise.all([
    sourceLoaders.loadAgentSources(),
    sourceLoaders.loadAllTemplateStepSources(),
  ]);
  const rolesByName = requireRoleSources(agentSources);
  const templateSteps = requireTemplateSource(allTemplateSources);
  // The installer receives a one-entry map deliberately: this operation owns
  // only the PR workflow, while the complete source loader remains useful for
  // contract validation and future canonical installation paths.
  const templateSources = new Map<CanonicalTemplateName, readonly TemplateStepSource[]>([
    [PR_TEMPLATE_NAME, templateSteps],
  ]);

  try {
    const project = await db.$transaction(async (tx) => {
      const createdProject = await tx.project.create({ data: parsedInput });
      const environment = await tx.environment.create({
        data: {
          projectId: createdProject.id,
          name: "local",
          networking: NetworkingMode.OPEN,
          allowedHosts: [],
        },
      });

      for (const roleName of PROJECT_BOOTSTRAP_ROLE_NAMES) {
        const role = rolesByName.get(roleName)!;
        await tx.agent.create({
          data: {
            projectId: createdProject.id,
            environmentId: environment.id,
            name: role.name,
            title: role.title,
            model: role.model,
            runnerPreference: role.runnerPreference,
            inboxAccess: role.inboxAccess,
            foundationalPrompt: agentSources.foundationalPrompt,
            rolePrompt: role.rolePrompt,
            disabledTools: [],
          },
        });
      }

      const plan = planCanonicalInstallation([], templateSources, [createdProject.id]);
      await applyCanonicalInstallation(tx, plan, templateSources);
      return createdProject;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { ok: true, project };
  } catch (error: unknown) {
    // Do not retry: this operation intentionally exposes the first conflict to
    // the route as the stable slug-taken response, preserving rollback semantics
    // for every other transaction failure.
    if (isProjectSlugTaken(error)) {
      return { ok: false, code: PROJECT_SLUG_TAKEN, message: PROJECT_SLUG_TAKEN_MESSAGE };
    }
    throw error;
  }
};
