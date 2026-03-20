import { describe, it, expect, afterEach } from "vitest";
import { validateRequiredEnv } from "../../../src/config/env-validator.js";
import type { WorkflowConfig } from "../../../src/config/schema.js";

function makeConfig(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    tracker: {
      kind: "linear",
      project_slug: "test",
      active_states: ["Todo"],
      terminal_states: ["Done"],
      ...overrides.tracker,
    },
    workspace: {
      root: "/tmp/forge",
      hooks: { timeout_ms: 60000 },
      ...overrides.workspace,
    },
    agent: {
      kind: "claude",
      max_concurrent_agents: 1,
      max_concurrent_agents_by_state: {},
      max_turns: 1,
      turn_timeout_ms: 60000,
      read_timeout_ms: 60000,
      stall_timeout_seconds: 300,
      approval_policy: "on-request",
      max_retry_backoff_ms: 300000,
      ...overrides.agent,
    },
    polling: { interval_ms: 30000 },
    retry: { max_attempts: 5, base_delay_seconds: 10, max_delay_seconds: 300 },
    server: { host: "127.0.0.1" },
    observability: { dashboard_enabled: false, refresh_ms: 1000 },
  } as WorkflowConfig;
}

describe("validateRequiredEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws when LINEAR_API_KEY is missing for linear tracker", () => {
    delete process.env.LINEAR_API_KEY;
    const config = makeConfig();
    expect(() => validateRequiredEnv(config)).toThrow("LINEAR_API_KEY");
  });

  it("passes when LINEAR_API_KEY is set for linear tracker", () => {
    process.env.LINEAR_API_KEY = "lin_test_key";
    const config = makeConfig();
    expect(() => validateRequiredEnv(config)).not.toThrow();
  });

  it("does not require LINEAR_API_KEY for non-linear trackers", () => {
    delete process.env.LINEAR_API_KEY;
    const config = makeConfig({
      tracker: {
        kind: "github" as "linear",
        project_slug: "test",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
    });
    expect(() => validateRequiredEnv(config)).not.toThrow();
  });

  it("throws when hook references a missing env var", () => {
    process.env.LINEAR_API_KEY = "lin_test_key";
    delete process.env.REPO_URL;
    const config = makeConfig({
      workspace: {
        root: "/tmp/forge",
        hooks: {
          after_create: "git clone $REPO_URL .",
          timeout_ms: 60000,
        },
      },
    });
    expect(() => validateRequiredEnv(config)).toThrow(
      "REPO_URL (referenced in hook: after_create)",
    );
  });

  it("passes when hook env vars are set", () => {
    process.env.LINEAR_API_KEY = "lin_test_key";
    process.env.REPO_URL = "https://github.com/test/repo.git";
    const config = makeConfig({
      workspace: {
        root: "/tmp/forge",
        hooks: {
          after_create: "git clone $REPO_URL .",
          timeout_ms: 60000,
        },
      },
    });
    expect(() => validateRequiredEnv(config)).not.toThrow();
  });

  it("ignores system-provided vars like ISSUE_BRANCH in hooks", () => {
    process.env.LINEAR_API_KEY = "lin_test_key";
    const config = makeConfig({
      workspace: {
        root: "/tmp/forge",
        hooks: {
          before_run: 'git checkout -b "$ISSUE_BRANCH" origin/main',
          timeout_ms: 60000,
        },
      },
    });
    expect(() => validateRequiredEnv(config)).not.toThrow();
  });

  it("lists all missing vars in a single error", () => {
    delete process.env.LINEAR_API_KEY;
    delete process.env.REPO_URL;
    const config = makeConfig({
      workspace: {
        root: "/tmp/forge",
        hooks: {
          after_create: "git clone $REPO_URL .",
          timeout_ms: 60000,
        },
      },
    });
    expect(() => validateRequiredEnv(config)).toThrow(/LINEAR_API_KEY.*REPO_URL/s);
  });
});
