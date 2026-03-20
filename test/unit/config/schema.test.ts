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
      "Canceled",
      "Duplicate",
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
    expect(config.polling.interval_ms).toBe(30_000);
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

  it("applies default hooks timeout_ms", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
        active_states: ["Todo"],
      },
    });
    expect(config.workspace.hooks.timeout_ms).toBe(60000);
  });

  it("accepts custom hooks timeout_ms", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
        active_states: ["Todo"],
      },
      workspace: {
        hooks: { timeout_ms: 120000 },
      },
    });
    expect(config.workspace.hooks.timeout_ms).toBe(120000);
  });

  it("applies default max_concurrent_agents_by_state as empty object", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
        active_states: ["Todo"],
      },
    });
    expect(config.agent.max_concurrent_agents_by_state).toEqual({});
  });

  it("accepts max_concurrent_agents_by_state limits", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
        active_states: ["Todo"],
      },
      agent: {
        max_concurrent_agents_by_state: { Todo: 3, "In Progress": 5 },
      },
    });
    expect(config.agent.max_concurrent_agents_by_state).toEqual({
      Todo: 3,
      "In Progress": 5,
    });
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

  it("defaults active_states to Todo and In Progress when not provided", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
      },
    });
    expect(config.tracker.active_states).toEqual(["Todo", "In Progress", "Rework"]);
  });

  it("accepts turn_timeout_ms and read_timeout_ms in agent config", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
      },
      agent: {
        turn_timeout_ms: 1_800_000,
        read_timeout_ms: 10_000,
      },
    });
    expect(config.agent.turn_timeout_ms).toBe(1_800_000);
    expect(config.agent.read_timeout_ms).toBe(10_000);
  });

  it("accepts endpoint and api_key in tracker config", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
        endpoint: "https://api.linear.app/graphql",
        api_key: "lin_api_test123",
      },
    });
    expect(config.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(config.tracker.api_key).toBe("lin_api_test123");
  });

  it("applies default polling.interval_ms", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
      },
    });
    expect(config.polling.interval_ms).toBe(30_000);
  });

  it("accepts custom polling.interval_ms", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
      },
      polling: { interval_ms: 5_000 },
    });
    expect(config.polling.interval_ms).toBe(5_000);
  });

  it("accepts agent.command as optional string", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
      },
      agent: { command: "custom-claude" },
    });
    expect(config.agent.command).toBe("custom-claude");
  });

  it("agent.command defaults to undefined", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
      },
    });
    expect(config.agent.command).toBeUndefined();
  });

  it("applies default agent.max_retry_backoff_ms", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
      },
    });
    expect(config.agent.max_retry_backoff_ms).toBe(300_000);
  });

  it("accepts custom agent.max_retry_backoff_ms", () => {
    const config = WorkflowConfigSchema.parse({
      tracker: {
        kind: "linear",
        project_slug: "test",
      },
      agent: { max_retry_backoff_ms: 600_000 },
    });
    expect(config.agent.max_retry_backoff_ms).toBe(600_000);
  });
});
