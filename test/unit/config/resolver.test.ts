import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveConfig, resolvePath } from "../../../src/config/resolver.js";
import { homedir } from "node:os";
import { resolve } from "node:path";

describe("resolveConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TEST_API_KEY = "lin_api_test123";
    process.env.TEST_PROJECT = "forge-dev";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves $ENV_VAR references", () => {
    const config = resolveConfig({
      tracker: {
        kind: "linear",
        project_slug: "$TEST_PROJECT",
        active_states: ["Todo"],
      },
    });
    expect(config.tracker.project_slug).toBe("forge-dev");
  });

  it("resolves ${ENV_VAR} references", () => {
    const config = resolveConfig({
      tracker: {
        kind: "linear",
        project_slug: "${TEST_PROJECT}",
        active_states: ["Todo"],
      },
    });
    expect(config.tracker.project_slug).toBe("forge-dev");
  });

  it("throws on missing env var", () => {
    expect(() =>
      resolveConfig({
        tracker: {
          kind: "linear",
          project_slug: "$NONEXISTENT_VAR",
          active_states: ["Todo"],
        },
      }),
    ).toThrow("Environment variable NONEXISTENT_VAR is not set");
  });

  it("resolves ~ in workspace root", () => {
    const config = resolveConfig({
      tracker: {
        kind: "linear",
        project_slug: "test",
        active_states: ["Todo"],
      },
      workspace: { root: "~/forge-workspaces" },
    });
    expect(config.workspace.root).toBe(resolve(homedir(), "forge-workspaces"));
  });
});

describe("resolvePath", () => {
  it("expands ~ to home directory", () => {
    expect(resolvePath("~/foo/bar")).toBe(resolve(homedir(), "foo/bar"));
  });

  it("resolves relative paths", () => {
    expect(resolvePath("./foo")).toBe(resolve("./foo"));
  });

  it("leaves absolute paths unchanged", () => {
    expect(resolvePath("/tmp/forge")).toBe("/tmp/forge");
  });
});
