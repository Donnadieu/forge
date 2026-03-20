import type { WorkflowConfig } from "./schema.js";

/**
 * Env vars that forge injects at runtime — users don't need to set these.
 */
const SYSTEM_PROVIDED_VARS = new Set([
  "WORKSPACE_PATH",
  "ISSUE_ID",
  "ISSUE_IDENTIFIER",
  "ISSUE_TITLE",
  "ISSUE_STATE",
  "ISSUE_BRANCH",
]);

/**
 * Validate that all required environment variables are set before starting.
 * Checks tracker-specific vars and scans hook scripts for referenced env vars.
 * Throws with a clear, actionable error listing every missing variable.
 */
export function validateRequiredEnv(config: WorkflowConfig): void {
  const missing: string[] = [];

  // Tracker-specific requirements
  if (config.tracker.kind === "linear" && !process.env.LINEAR_API_KEY) {
    missing.push("LINEAR_API_KEY (required for tracker: linear)");
  }

  // Scan hook scripts for env var references
  const hooks = config.workspace.hooks;
  for (const [hookName, value] of Object.entries(hooks)) {
    if (typeof value !== "string") continue;
    for (const varName of extractEnvVarRefs(value)) {
      if (!process.env[varName]) {
        missing.push(`${varName} (referenced in hook: ${hookName})`);
      }
    }
  }

  if (missing.length > 0) {
    const list = missing.map((v) => `  - ${v}`).join("\n");
    throw new Error(
      `Missing required environment variables:\n${list}\n\nSet them in .env or your shell environment.`,
    );
  }
}

/**
 * Extract env var references ($VAR / ${VAR}) from a shell script string,
 * excluding system-provided variables that forge injects at runtime.
 */
function extractEnvVarRefs(script: string): string[] {
  const refs = new Set<string>();
  const regex = /\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g;
  for (let match = regex.exec(script); match !== null; match = regex.exec(script)) {
    const varName = match[1] || match[2];
    if (!SYSTEM_PROVIDED_VARS.has(varName)) {
      refs.add(varName);
    }
  }
  return [...refs];
}
