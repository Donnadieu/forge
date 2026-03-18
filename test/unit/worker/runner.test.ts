import { describe, it, expect, vi } from "vitest";
import { runWorker } from "../../../src/worker/runner.js";
import type { AgentAdapter, AgentEvent, SessionHandle } from "../../../src/agent/types.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";

const testIssue: NormalizedIssue = {
  id: "issue-1",
  identifier: "MT-42",
  title: "Test issue",
  description: "Test description",
  state: "Todo",
  priority: 1,
  labels: [],
  blockedBy: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

function createMockAgent(events: AgentEvent[][]): AgentAdapter {
  let turnIndex = 0;
  return {
    name: "mock",
    async startSession(_params) {
      return {
        id: `session-${turnIndex}`,
        abortController: new AbortController(),
      };
    },
    async *streamEvents(_handle: SessionHandle) {
      const turnEvents = events[turnIndex] || [{ type: "done" as const, success: true }];
      turnIndex++;
      for (const event of turnEvents) {
        yield event;
      }
    },
    async stopSession() {},
  };
}

function createMockWorkspace(): WorkspaceManager {
  return {
    ensureWorkspace: vi.fn().mockResolvedValue("/tmp/test-workspace"),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    runHook: vi.fn().mockResolvedValue(undefined),
    writeMcpConfig: vi.fn().mockResolvedValue("/tmp/test-workspace/.forge/mcp.json"),
    toSafeId: vi.fn((id: string) => id),
  } as unknown as WorkspaceManager;
}

describe("runWorker", () => {
  it("runs a single turn and completes", async () => {
    const agent = createMockAgent([
      [
        { type: "text", content: "Working on it" },
        { type: "done", success: true },
      ],
    ]);

    const tracker = new MemoryTracker([testIssue]);
    // Move to terminal so worker stops after first turn
    tracker.updateIssueState("issue-1", "Done");

    const workspace = createMockWorkspace();

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 5,
        promptTemplate: "Fix {{ issue.identifier }}",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo", "In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
    );

    expect(result.issueId).toBe("issue-1");
    expect(result.turns).toBe(1);
    expect(result.success).toBe(true);
    expect(result.workspacePath).toBeDefined();
    expect(workspace.ensureWorkspace).toHaveBeenCalledWith(testIssue);
    expect(workspace.runHook).toHaveBeenCalledWith("before_run", "/tmp/test-workspace");
    expect(workspace.runHook).toHaveBeenCalledWith("after_run", "/tmp/test-workspace");
  });

  it("runs multiple turns while issue stays active", async () => {
    const agent = createMockAgent([
      [{ type: "done", success: true }],
      [{ type: "done", success: true }],
      [{ type: "done", success: true }],
    ]);

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);

    const workspace = createMockWorkspace();
    const turns: number[] = [];

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 3,
        promptTemplate: "Fix {{ issue.identifier }}",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo", "In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
      {
        onTurnStart: (_id, turn) => turns.push(turn),
      },
    );

    expect(result.turns).toBe(3);
    expect(turns).toEqual([1, 2, 3]);
  });

  it("stops when issue moves to terminal state between turns", async () => {
    let turnCount = 0;
    const agent: AgentAdapter = {
      name: "mock",
      async startSession() {
        return {
          id: `s-${turnCount}`,
          abortController: new AbortController(),
        };
      },
      async *streamEvents() {
        turnCount++;
        yield { type: "done" as const, success: true };
      },
      async stopSession() {},
    };

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);

    // After first turn, move issue to Done
    const origFetch = tracker.fetchIssueStatesByIds.bind(tracker);
    let fetchCount = 0;
    tracker.fetchIssueStatesByIds = async (ids: string[]) => {
      fetchCount++;
      if (fetchCount >= 1) {
        tracker.updateIssueState("issue-1", "Done");
      }
      return origFetch(ids);
    };

    const workspace = createMockWorkspace();

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 10,
        promptTemplate: "Work on it",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
    );

    expect(result.turns).toBe(1);
  });

  it("accumulates token usage across turns", async () => {
    const agent = createMockAgent([
      [
        { type: "usage", inputTokens: 100, outputTokens: 50 },
        { type: "done", success: true },
      ],
      [
        { type: "usage", inputTokens: 200, outputTokens: 100 },
        { type: "done", success: true },
      ],
    ]);

    const tracker = new MemoryTracker([{ ...testIssue, state: "In Progress" }]);
    // Move to done after second turn
    let fetchCount = 0;
    const origFetch = tracker.fetchIssueStatesByIds.bind(tracker);
    tracker.fetchIssueStatesByIds = async (ids: string[]) => {
      fetchCount++;
      if (fetchCount >= 2) tracker.updateIssueState("issue-1", "Done");
      return origFetch(ids);
    };

    const workspace = createMockWorkspace();

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 10,
        promptTemplate: "Work",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["In Progress"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
    );

    expect(result.tokens.input).toBe(300);
    expect(result.tokens.output).toBe(150);
  });

  it("stops on agent error", async () => {
    const agent = createMockAgent([[{ type: "error", message: "Agent crashed" }]]);

    const tracker = new MemoryTracker([testIssue]);
    const workspace = createMockWorkspace();

    const result = await runWorker(
      testIssue,
      {
        maxTurns: 5,
        promptTemplate: "Fix it",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
      },
      agent,
      tracker,
      workspace,
    );

    // Should still have run after_run hook
    expect(workspace.runHook).toHaveBeenCalledWith("after_run", "/tmp/test-workspace");
    expect(result.turns).toBe(1);
    expect(result.success).toBe(false);
  });

  it("writes MCP config when mcpServers provided", async () => {
    const agent = createMockAgent([[{ type: "done", success: true }]]);
    const tracker = new MemoryTracker([testIssue]);
    tracker.updateIssueState("issue-1", "Done");
    const workspace = createMockWorkspace();

    await runWorker(
      testIssue,
      {
        maxTurns: 1,
        promptTemplate: "Fix it",
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
        mcpServers: { "forge-linear": { command: "node" } },
      },
      agent,
      tracker,
      workspace,
    );

    expect(workspace.writeMcpConfig).toHaveBeenCalledWith("/tmp/test-workspace", {
      "forge-linear": { command: "node" },
    });
  });
});
