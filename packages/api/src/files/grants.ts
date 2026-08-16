import { contains, normalizeRelPath } from "./paths.js";

export type FileOperation = "list" | "stat" | "read" | "write" | "mkdir" | "delete";
export type FileCapability = "canRead" | "canWrite" | "canDelete";
export type GrantLike = { folderPath: string; canRead: boolean; canWrite: boolean; canDelete: boolean };

export const requiredCapability = (operation: FileOperation): FileCapability => {
  if (operation === "list" || operation === "stat" || operation === "read") return "canRead";
  if (operation === "write" || operation === "mkdir") return "canWrite";
  return "canDelete";
};

export const grantAdmits = (
  grants: GrantLike[],
  operation: FileOperation,
  path: string,
): { admitted: true } | { admitted: false; missing: FileCapability } => {
  const normalizedPath = normalizeRelPath(path);
  const capability = requiredCapability(operation);
  for (const grant of grants) {
    let prefix: string;
    try {
      prefix = normalizeRelPath(grant.folderPath);
    } catch {
      continue;
    }
    if (prefix !== grant.folderPath || !contains(prefix, normalizedPath)) continue;
    if (grant[capability]) return { admitted: true };
  }
  return { admitted: false, missing: capability };
};
