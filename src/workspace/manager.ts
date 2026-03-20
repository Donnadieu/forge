import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, posix, resolve } from "node:path";
import { writeMcpConfig as writeMcpConfigFile } from "./mcp-config.js";
import { runSshCommand, shellEscape } from "./ssh.js";
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
  skillsDir?: string;
  sshConfigPath?: string;
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

    let isNew: boolean;

    if (existsSync(workspacePath)) {
      const stat = lstatSync(workspacePath);
      if (!stat.isDirectory()) {
        // Exists as a file — remove and recreate as directory
        rmSync(workspacePath);
        mkdirSync(workspacePath, { recursive: true });
        isNew = true;
      } else {
        isNew = false;
      }
    } else {
      mkdirSync(workspacePath, { recursive: true });
      isNew = true;
    }

    // Run after_create hook only on first creation
    if (isNew && this.config.hooks.after_create) {
      await this.runHook("after_create", workspacePath);
    }

    // Copy skills into workspace if configured
    if (this.config.skillsDir) {
      this.copySkills(workspacePath, this.config.skillsDir);
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
    issueEnv?: Record<string, string>,
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
        env: { ...process.env, WORKSPACE_PATH: workspacePath, ...issueEnv },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Hook '${hookName}' failed in ${workspacePath}: ${msg}`);
    }
  }

  /**
   * Copy skill files from the configured skills directory into the workspace.
   */
  private copySkills(workspacePath: string, skillsDir: string): void {
    if (!existsSync(skillsDir)) return;

    const destDir = join(workspacePath, ".forge", "skills");
    mkdirSync(destDir, { recursive: true });

    const files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      copyFileSync(join(skillsDir, file), join(destDir, file));
    }
  }

  /**
   * Write MCP config file for agent to use in the workspace.
   */
  async writeMcpConfig(
    workspacePath: string,
    mcpServers: Record<string, unknown>,
  ): Promise<string> {
    return writeMcpConfigFile(workspacePath, mcpServers);
  }

  /**
   * Generate a safe filesystem identifier from an issue identifier.
   * Replaces non-alphanumeric characters (except . - _) with underscore.
   */
  toSafeId(identifier: string): string {
    return identifier.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  /**
   * Ensure a workspace exists on a remote host for the given issue.
   * Creates the directory via SSH, runs after_create hook on first creation.
   */
  async ensureRemoteWorkspace(host: string, issue: NormalizedIssue): Promise<string> {
    const safeId = this.toSafeId(issue.identifier);
    const wsPath = `${this.config.root}/${safeId}`;
    this.validateRemotePath(wsPath);

    // Create directory remotely
    const sshOpts = { sshConfigPath: this.config.sshConfigPath };
    const mkdirResult = await runSshCommand(host, `mkdir -p ${shellEscape(wsPath)}`, sshOpts);
    if (mkdirResult.exitCode !== 0) {
      throw new Error(`Failed to create remote workspace on ${host}: ${wsPath}`);
    }

    // Check if newly created (test for a marker file)
    const testResult = await runSshCommand(
      host,
      `test -f ${shellEscape(`${wsPath}/.forge-initialized`)} && echo exists`,
      sshOpts,
    );
    const isNew = !testResult.stdout.includes("exists");

    if (isNew) {
      // Mark as initialized
      await runSshCommand(host, `touch ${shellEscape(`${wsPath}/.forge-initialized`)}`, sshOpts);
      // Run after_create hook remotely
      if (this.config.hooks.after_create) {
        await this.runRemoteHook(host, "after_create", wsPath, {});
      }
    }

    return wsPath;
  }

  /**
   * Run a named lifecycle hook on a remote host.
   * after_create and before_run failures are fatal (throw).
   * Other hook failures are swallowed.
   */
  async runRemoteHook(
    host: string,
    hookName: string,
    workspacePath: string,
    env: Record<string, string>,
  ): Promise<void> {
    const script = this.config.hooks[hookName as keyof typeof this.config.hooks];
    if (!script || typeof script !== "string") return;

    const timeout = this.config.hookTimeoutMs ?? 300_000;

    const envPrefix = Object.entries(env)
      .map(([k, v]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          throw new Error(`Invalid environment variable name: ${k}`);
        }
        return `export ${k}=${shellEscape(v)}`;
      })
      .join("; ");

    const fullCommand = envPrefix
      ? `${envPrefix}; cd ${shellEscape(workspacePath)} && ${script}`
      : `cd ${shellEscape(workspacePath)} && ${script}`;

    const result = await runSshCommand(host, fullCommand, {
      timeoutMs: timeout,
      sshConfigPath: this.config.sshConfigPath,
    });

    // after_create and before_run failures are fatal
    if (result.exitCode !== 0 && (hookName === "after_create" || hookName === "before_run")) {
      throw new Error(
        `Remote hook ${hookName} failed on ${host} with exit code ${result.exitCode}`,
      );
    }
  }

  /**
   * Remove a workspace directory on a remote host.
   * Runs before_remove hook first (failure is logged and ignored).
   */
  async removeRemoteWorkspace(host: string, path: string): Promise<void> {
    this.validateRemotePath(path);
    if (this.config.hooks.before_remove) {
      try {
        await this.runRemoteHook(host, "before_remove", path, {});
      } catch {
        // before_remove failure is ignored
      }
    }
    await runSshCommand(host, `rm -rf ${shellEscape(path)}`, {
      sshConfigPath: this.config.sshConfigPath,
    });
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
      throw new Error(`Workspace path cannot be the root directory: ${canonicalWorkspace}`);
    }

    if (!canonicalWorkspace.startsWith(`${canonicalRoot}/`)) {
      throw new Error(
        `Workspace path escapes root: ${canonicalWorkspace} is not under ${canonicalRoot}`,
      );
    }

    // Check for symlink escape if the path exists
    if (existsSync(workspacePath)) {
      const realPath = this.resolveSymlinks(workspacePath);
      const realRoot = this.resolveSymlinks(this.config.root);

      if (!realPath.startsWith(`${realRoot}/`) && realPath !== realRoot) {
        throw new Error(
          `Symlink escape detected: ${workspacePath} resolves to ${realPath} which is outside ${realRoot}`,
        );
      }
    }
  }

  /**
   * Validate that a remote workspace path is under the configured root.
   * String-based only (no symlink check — filesystem is remote).
   */
  private validateRemotePath(remotePath: string): void {
    const root = this.config.root.replace(/\/+$/, "");
    const normalized = posix.normalize(remotePath);
    if (normalized === root) {
      throw new Error(`Remote workspace path cannot be the root directory: ${normalized}`);
    }
    if (!normalized.startsWith(`${root}/`)) {
      throw new Error(`Remote workspace path escapes root: ${normalized} is not under ${root}`);
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
