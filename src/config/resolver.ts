import { homedir } from "node:os";
import { resolve } from "node:path";
import { WorkflowConfigSchema, type WorkflowConfig } from "./schema.js";

/**
 * Resolve environment variables and paths in config values.
 *
 * - Recursively resolves $ENV_VAR and ${ENV_VAR} references in all string values
 * - Expands ~ to home directory in workspace.root
 * - Parses through Zod schema with defaults
 */
export function resolveConfig(raw: Record<string, unknown>): WorkflowConfig {
  const resolved = resolveEnvVars(raw);
  resolved.workspace = resolveWorkspacePaths(resolved.workspace);
  return WorkflowConfigSchema.parse(resolved);
}

function resolveEnvVars(obj: unknown): any {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g, (_, braced, bare) => {
      const varName = braced || bare;
      const value = process.env[varName];
      if (value === undefined) {
        throw new Error(`Environment variable ${varName} is not set`);
      }
      return value;
    });
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value);
    }
    return result;
  }
  return obj;
}

function resolveWorkspacePaths(workspace: any): any {
  if (!workspace || typeof workspace !== "object") return workspace;
  if (typeof workspace.root === "string") {
    workspace.root = resolvePath(workspace.root);
  }
  return workspace;
}

export function resolvePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}
