import { describe, it, expect } from "vitest";
import { WorkflowConfigSchema } from "../../../src/config/schema.js";

describe("WorkflowConfigSchema", () => {
  it("parses a valid full config", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "forge-dev",
        active_states: ["Todo", "In Progress"],
      },
      workspace: { root: "/tmp/workspaces" },
      agent: { kind: "claude", max_turns: 10 },
    });
    expect(config.tracker.kind).toBe("linear");
    expect(config.tracker.terminal_states).toEqual([
      "Done",
      "Closed",
      "Cancelled",
    ]);
    expect(config.agent.max_concurrent_agents).toBe(10);
    expect(config.retry.max_attempts).toBe(5);
  });

  it("applies defaults for optional fields", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
        active_states: ["Todo"],
      },
    });
    expect(config.workspace.root).toBe("~/forge-workspaces");
    expect(config.agent.kind).toBe("claude");
    expect(config.agent.poll_interval_seconds).toBe(30);
    expect(config.retry.base_delay_seconds).toBe(10);
  });

  it("rejects invalid tracker kind", () => {
    expect(() =>
      WorkflowConfigSchema.parse({
        tracker: {
          kind: "invalid",
          project_slug: "x",
          active_states: ["Todo"],
        },
      }),
    ).toThrow();
  });

  it("rejects missing required tracker fields", () => {
    expect(() =>
      WorkflowConfigSchema.parse({
        tracker: { kind: "linear" },
      }),
    ).toThrow();
  });

  it("accepts optional skills_dir in workspace config", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
        active_states: ["Todo"],
      },
      workspace: {
        root: "/tmp/workspaces",
        skills_dir: "./skills",
      },
    });
    expect(config.workspace.skills_dir).toBe("./skills");
  });

  it("skills_dir defaults to undefined", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
        active_states: ["Todo"],
      },
    });
    expect(config.workspace.skills_dir).toBeUndefined();
  });
});
