import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WorkspaceManager } from "../../../src/workspace/manager.js";
import {
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("WorkspaceManager", () => {
  let testRoot: string;
  let manager: WorkspaceManager;

  beforeEach(() => {
    testRoot = join(tmpdir(), `forge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testRoot, { recursive: true });
    manager = new WorkspaceManager({
      root: testRoot,
      hooks: {},
    });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  describe("toSafeId", () => {
    it("replaces special characters with underscore", () => {
      expect(manager.toSafeId("MT-123")).toBe("MT-123");
      expect(manager.toSafeId("PROJ/issue#1")).toBe("PROJ_issue_1");
      expect(manager.toSafeId("a b c")).toBe("a_b_c");
    });

    it("preserves alphanumeric, dots, hyphens, underscores", () => {
      expect(manager.toSafeId("my-issue_v1.0")).toBe("my-issue_v1.0");
    });
  });

  describe("ensureWorkspace", () => {
    it("creates a new workspace directory", async () => {
      const path = await manager.ensureWorkspace("MT-123");
      expect(existsSync(path)).toBe(true);
      expect(path).toBe(join(testRoot, "MT-123"));
    });

    it("reuses existing workspace directory", async () => {
      const path1 = await manager.ensureWorkspace("MT-123");
      writeFileSync(join(path1, "test.txt"), "hello");
      const path2 = await manager.ensureWorkspace("MT-123");
      expect(path1).toBe(path2);
      expect(readFileSync(join(path2, "test.txt"), "utf-8")).toBe("hello");
    });

    it("creates deterministic path from issue identifier", async () => {
      const path = await manager.ensureWorkspace({
        id: "uuid-1",
        identifier: "PROJ-42",
        title: "Test",
        description: "desc",
        state: "Todo",
        priority: 1,
        labels: [],
        blockedBy: [],
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });
      expect(path).toBe(join(testRoot, "PROJ-42"));
    });

    it("replaces non-directory file at workspace path", async () => {
      const wsPath = join(testRoot, "MT-123");
      writeFileSync(wsPath, "stale file");
      const path = await manager.ensureWorkspace("MT-123");
      expect(existsSync(path)).toBe(true);
      // Should be a directory now, not a file
      const stat = statSync(path);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe("hooks", () => {
    it("runs after_create hook on first creation", async () => {
      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          after_create: "touch created.marker",
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-100");
      expect(existsSync(join(path, "created.marker"))).toBe(true);
    });

    it("does not run after_create on existing workspace", async () => {
      const hookRoot = join(testRoot, "hook-test");
      mkdirSync(hookRoot, { recursive: true });

      const managerWithHook = new WorkspaceManager({
        root: hookRoot,
        hooks: {
          after_create: "echo created >> hook.log",
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-200");
      // Run again -- should NOT run after_create
      await managerWithHook.ensureWorkspace("MT-200");

      const log = readFileSync(join(path, "hook.log"), "utf-8");
      // Should only have one "created" entry
      expect(log.trim().split("\n")).toHaveLength(1);
    });

    it("runs before_run and after_run hooks", async () => {
      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          before_run: "touch before.marker",
          after_run: "touch after.marker",
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-300");
      await managerWithHook.runHook("before_run", path);
      await managerWithHook.runHook("after_run", path);

      expect(existsSync(join(path, "before.marker"))).toBe(true);
      expect(existsSync(join(path, "after.marker"))).toBe(true);
    });

    it("throws on hook failure", async () => {
      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          before_run: "exit 1",
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-400");
      await expect(managerWithHook.runHook("before_run", path)).rejects.toThrow(
        /Hook 'before_run' failed/,
      );
    });

    it("skips hooks that are not configured", async () => {
      const path = await manager.ensureWorkspace("MT-500");
      // Should not throw
      await manager.runHook("before_run", path);
      await manager.runHook("after_run", path);
    });
  });

  describe("removeWorkspace", () => {
    it("removes workspace directory", async () => {
      const path = await manager.ensureWorkspace("MT-600");
      expect(existsSync(path)).toBe(true);
      await manager.removeWorkspace(path);
      expect(existsSync(path)).toBe(false);
    });

    it("runs before_remove hook", async () => {
      // Create a marker outside the workspace to verify hook ran
      const markerPath = join(testRoot, "remove-marker");
      const managerWithHook = new WorkspaceManager({
        root: testRoot,
        hooks: {
          before_remove: `touch ${markerPath}`,
        },
      });

      const path = await managerWithHook.ensureWorkspace("MT-700");
      await managerWithHook.removeWorkspace(path);
      expect(existsSync(markerPath)).toBe(true);
    });
  });

  describe("writeMcpConfig", () => {
    it("writes MCP config to .forge/mcp.json", async () => {
      const path = await manager.ensureWorkspace("MT-800");
      const configPath = await manager.writeMcpConfig(path, {
        "forge-linear": {
          command: "node",
          args: ["linear-server.js"],
          env: { LINEAR_API_KEY: "test" },
        },
      });

      expect(configPath).toBe(join(path, ".forge", "mcp.json"));
      const content = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(content.mcpServers["forge-linear"].command).toBe("node");
    });
  });

  describe("skills injection", () => {
    it("copies skill files into workspace .forge/skills/", async () => {
      // Create a skills directory with test skills
      const skillsDir = join(testRoot, "_skills_source");
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(skillsDir, "commit.md"),
        "---\nname: commit\ndescription: Git commit skill\n---\n# Commit\nSteps...",
      );
      writeFileSync(
        join(skillsDir, "push.md"),
        "---\nname: push\ndescription: Git push skill\n---\n# Push\nSteps...",
      );
      // Non-.md file should be ignored
      writeFileSync(join(skillsDir, "notes.txt"), "not a skill");

      const skillsManager = new WorkspaceManager({
        root: testRoot,
        hooks: {},
        skillsDir,
      });

      const path = await skillsManager.ensureWorkspace("MT-500");
      const copiedCommit = join(path, ".forge", "skills", "commit.md");
      const copiedPush = join(path, ".forge", "skills", "push.md");
      const copiedTxt = join(path, ".forge", "skills", "notes.txt");

      expect(existsSync(copiedCommit)).toBe(true);
      expect(existsSync(copiedPush)).toBe(true);
      expect(existsSync(copiedTxt)).toBe(false);
      expect(readFileSync(copiedCommit, "utf-8")).toContain("# Commit");
    });

    it("handles missing skills directory gracefully", async () => {
      const skillsManager = new WorkspaceManager({
        root: testRoot,
        hooks: {},
        skillsDir: join(testRoot, "_nonexistent_skills"),
      });

      // Should not throw
      const path = await skillsManager.ensureWorkspace("MT-501");
      expect(existsSync(path)).toBe(true);
    });
  });

  describe("path safety", () => {
    it("rejects path that equals root", async () => {
      const badManager = new WorkspaceManager({
        root: testRoot,
        hooks: {},
      });
      // Trying to use empty identifier would resolve to root
      await expect(badManager.ensureWorkspace("")).rejects.toThrow();
    });

    it("rejects path traversal attempts", async () => {
      await expect(manager.ensureWorkspace("../../etc")).rejects.toThrow(/escapes root/);
    });

    it("rejects symlink escapes", async () => {
      // Create a symlink inside root that points outside
      const outsideDir = join(tmpdir(), `forge-outside-${Date.now()}`);
      mkdirSync(outsideDir, { recursive: true });

      const linkPath = join(testRoot, "escape-link");
      symlinkSync(outsideDir, linkPath);

      await expect(manager.removeWorkspace(linkPath)).rejects.toThrow(/Symlink escape/);

      // Cleanup
      rmSync(outsideDir, { recursive: true, force: true });
    });
  });
});
