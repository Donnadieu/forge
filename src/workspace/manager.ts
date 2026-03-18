import { execSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { NormalizedIssue } from "../tracker/types.js";

export interface WorkspaceConfig {
  root: string;
  hooks: {
    after_create?: string;
    before_run?: string;
    after_run?: string;
    before_remove?: string;
  };
  hookTimeoutMs?: number;
}

export class WorkspaceManager {
  private config: WorkspaceConfig;
  private createdPaths = new Set<string>();

  constructor(config: WorkspaceConfig) {
    this.config = config;
  }

  /**
   * Ensure a workspace exists for the given issue.
   * Creates the directory if it doesn't exist, runs after_create hook on first creation.
   */
  async ensureWorkspace(issue: NormalizedIssue | string): Promise<string> {
    const identifier = typeof issue === "string" ? issue : issue.identifier;

    // Validate the raw identifier path before sanitization to catch traversal attempts
    const rawPath = join(this.config.root, identifier);
    this.validatePath(rawPath);

    const safeId = this.toSafeId(identifier);
    const workspacePath = join(this.config.root, safeId);

    // Validate the sanitized path as well
    this.validatePath(workspacePath);

    // Ensure root exists
    mkdirSync(this.config.root, { recursive: true });

    const isNew = !existsSync(workspacePath);

    if (existsSync(workspacePath)) {
      // If it exists but is a file (not directory), remove and recreate
      const stat = lstatSync(workspacePath);
      if (!stat.isDirectory()) {
        rmSync(workspacePath);
        mkdirSync(workspacePath, { recursive: true });
      }
    } else {
      mkdirSync(workspacePath, { recursive: true });
    }

    // Run after_create hook only on first creation
    if (isNew && this.config.hooks.after_create) {
      await this.runHook("after_create", workspacePath);
    }

    this.createdPaths.add(workspacePath);
    return workspacePath;
  }

  /**
   * Remove a workspace directory, running before_remove hook first.
   */
  async removeWorkspace(workspacePath: string): Promise<void> {
    this.validatePath(workspacePath);

    if (this.config.hooks.before_remove) {
      await this.runHook("before_remove", workspacePath);
    }

    if (existsSync(workspacePath)) {
      rmSync(workspacePath, { recursive: true, force: true });
    }

    this.createdPaths.delete(workspacePath);
  }

  /**
   * Run a named lifecycle hook in the workspace directory.
   */
  async runHook(
    hookName: keyof WorkspaceConfig["hooks"],
    workspacePath: string,
  ): Promise<void> {
    const command = this.config.hooks[hookName];
    if (!command) return;

    const timeout = this.config.hookTimeoutMs ?? 300_000; // 5 min default

    try {
      execSync(command, {
        cwd: workspacePath,
        shell: "/bin/sh",
        timeout,
        stdio: "pipe",
        env: { ...process.env, WORKSPACE_PATH: workspacePath },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Hook '${hookName}' failed in ${workspacePath}: ${msg}`);
    }
  }

  /**
   * Write MCP config file for agent to use in the workspace.
   */
  async writeMcpConfig(
    workspacePath: string,
    mcpServers: Record<string, unknown>,
  ): Promise<string> {
    const forgeDir = join(workspacePath, ".forge");
    mkdirSync(forgeDir, { recursive: true });

    const configPath = join(forgeDir, "mcp.json");
    const config = { mcpServers };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    return configPath;
  }

  /**
   * Generate a safe filesystem identifier from an issue identifier.
   * Replaces non-alphanumeric characters (except . - _) with underscore.
   */
  toSafeId(identifier: string): string {
    return identifier.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  /**
   * Validate that a workspace path is safe:
   * - Must be under the configured root
   * - Must not equal the root
   * - No symlink escape
   */
  private validatePath(workspacePath: string): void {
    const canonicalRoot = resolve(this.config.root);
    const canonicalWorkspace = resolve(workspacePath);

    if (canonicalWorkspace === canonicalRoot) {
      throw new Error(
        `Workspace path cannot be the root directory: ${canonicalWorkspace}`,
      );
    }

    if (!canonicalWorkspace.startsWith(canonicalRoot + "/")) {
      throw new Error(
        `Workspace path escapes root: ${canonicalWorkspace} is not under ${canonicalRoot}`,
      );
    }

    // Check for symlink escape if the path exists
    if (existsSync(workspacePath)) {
      const realPath = this.resolveSymlinks(workspacePath);
      const realRoot = this.resolveSymlinks(this.config.root);

      if (!realPath.startsWith(realRoot + "/") && realPath !== realRoot) {
        throw new Error(
          `Symlink escape detected: ${workspacePath} resolves to ${realPath} which is outside ${realRoot}`,
        );
      }
    }
  }

  /**
   * Resolve symlinks to their real path.
   */
  private resolveSymlinks(targetPath: string): string {
    try {
      return realpathSync(targetPath);
    } catch {
      return resolve(targetPath);
    }
  }
}
