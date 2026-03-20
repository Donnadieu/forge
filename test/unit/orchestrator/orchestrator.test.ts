import { describe, it, expect, vi, afterEach } from "vitest";
import { Orchestrator } from "../../../src/orchestrator/orchestrator.js";
import { selectIssuesToDispatch } from "../../../src/orchestrator/dispatcher.js";
import { createInitialState } from "../../../src/orchestrator/types.js";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { AgentAdapter, AgentEvent } from "../../../src/agent/types.js";
import type { WorkspaceManager } from "../../../src/workspace/manager.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";

function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    id: "id-1",
    identifier: "MT-1",
    title: "Test",
    description: "Test desc",
    state: "Todo",
    priority: 2,
    labels: [],
    blockedBy: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function createMockAgent(): AgentAdapter {
  return {
    name: "mock",
    async startSession() {
      return { id: "s-1", abortController: new AbortController() };
    },
    async *streamEvents(): AsyncIterable<AgentEvent> {
      yield { type: "done", success: true };
    },
    async stopSession() {},
  };
}

function createMockWorkspace(): WorkspaceManager {
  return {
    ensureWorkspace: vi.fn().mockResolvedValue("/tmp/ws"),
    removeWorkspace: vi.fn().mockResolvedValue(undefined),
    runHook: vi.fn().mockResolvedValue(undefined),
    writeMcpConfig: vi.fn().mockResolvedValue("/tmp/ws/.forge/mcp.json"),
    toSafeId: vi.fn((id: string) => id),
  } as unknown as WorkspaceManager;
}

describe("Orchestrator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches eligible issues on tick", async () => {
    vi.useFakeTimers();
    const tracker = new MemoryTracker([makeIssue()]);
    const agent = createMockAgent();
    const workspace = createMockWorkspace();
    const dispatched: string[] = [];

    const orchestrator = new Orchestrator(
      tracker,
      agent,
      workspace,
      {
        pollIntervalMs: 1000,
        maxConcurrentAgents: 5,
        maxTurns: 1,
        stallTimeoutSeconds: 300,
        maxRetryAttempts: 3,
        maxRetryDelayMs: 300_000,
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
        promptTemplate: "Fix {{ issue.identifier }}",
      },
      {
        onDispatch: (issue) => dispatched.push(issue.id),
      },
    );

    orchestrator.start();

    // Advance past first tick (immediate)
    await vi.advanceTimersByTimeAsync(50);

    expect(dispatched).toContain("id-1");

    await orchestrator.stop();
  });

  it("respects concurrency limits", () => {
    // Test dispatcher directly to verify concurrency enforcement
    // without timing issues from async workers
    const state = createInitialState();
    // Simulate 2 already-running workers
    state.running.set("running-1", {} as any);
    state.running.set("running-2", {} as any);

    const issues = [
      makeIssue({ id: "3", identifier: "MT-3" }),
      makeIssue({ id: "4", identifier: "MT-4" }),
    ];

    const selected = selectIssuesToDispatch(issues, state, {
      active_states: ["Todo"],
      terminal_states: ["Done"],
      max_concurrent_agents: 2, // Limit is 2, already running 2
    });

    // Should not dispatch any since we're at capacity
    expect(selected).toHaveLength(0);

    // With capacity for 1 more
    const selected2 = selectIssuesToDispatch(issues, state, {
      active_states: ["Todo"],
      terminal_states: ["Done"],
      max_concurrent_agents: 3, // Limit is 3, running 2 => room for 1
    });

    expect(selected2).toHaveLength(1);
  });

  it("skips dispatch when issue state changed between fetch and dispatch", async () => {
    vi.useFakeTimers();
    const issue = makeIssue({ state: "Todo" });
    const tracker = new MemoryTracker([issue]);

    const origFetchCandidates = tracker.fetchCandidates.bind(tracker);
    tracker.fetchCandidates = async (config) => {
      const candidates = await origFetchCandidates(config);
      // Simulate race: issue moves to Done after candidates fetched
      await tracker.updateIssueState("id-1", "Done");
      return candidates;
    };

    const agent = createMockAgent();
    const workspace = createMockWorkspace();
    const dispatched: string[] = [];

    const orchestrator = new Orchestrator(
      tracker,
      agent,
      workspace,
      {
        pollIntervalMs: 100_000,
        maxConcurrentAgents: 5,
        maxTurns: 1,
        stallTimeoutSeconds: 300,
        maxRetryAttempts: 3,
        maxRetryDelayMs: 300_000,
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
        promptTemplate: "Fix it",
      },
      {
        onDispatch: (issue) => dispatched.push(issue.id),
      },
    );

    orchestrator.start();
    await vi.advanceTimersByTimeAsync(50);

    expect(dispatched).toHaveLength(0);

    await orchestrator.stop();
  });

  it("schedules continuation retry after successful completion", async () => {
    vi.useFakeTimers();
    const issue = makeIssue({ state: "Todo" });
    const tracker = new MemoryTracker([issue]);
    const agent = createMockAgent();
    const workspace = createMockWorkspace();
    const completed: string[] = [];
    const dispatched: string[] = [];

    const orchestrator = new Orchestrator(
      tracker,
      agent,
      workspace,
      {
        pollIntervalMs: 100_000,
        maxConcurrentAgents: 5,
        maxTurns: 1,
        stallTimeoutSeconds: 300,
        maxRetryAttempts: 3,
        maxRetryDelayMs: 300_000,
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: ["Todo"],
          terminal_states: ["Done"],
        },
        promptTemplate: "Fix it",
      },
      {
        onDispatch: (issue) => dispatched.push(issue.id),
        onComplete: (id) => completed.push(id),
      },
    );

    orchestrator.start();
    // First tick dispatches the issue, mock agent completes immediately
    await vi.advanceTimersByTimeAsync(50);

    expect(dispatched).toContain("id-1");
    expect(completed).toContain("id-1");

    // Continuation delay is 1000ms; advance past it + allow async resolution
    await vi.advanceTimersByTimeAsync(1100);
    expect(dispatched.filter((id) => id === "id-1").length).toBeGreaterThanOrEqual(2);

    await orchestrator.stop();
  });

  it("stops cleanly", async () => {
    const tracker = new MemoryTracker();
    const agent = createMockAgent();
    const workspace = createMockWorkspace();

    const orchestrator = new Orchestrator(tracker, agent, workspace, {
      pollIntervalMs: 1000,
      maxConcurrentAgents: 5,
      maxTurns: 1,
      stallTimeoutSeconds: 300,
      maxRetryAttempts: 3,
      maxRetryDelayMs: 300_000,
      trackerConfig: {
        kind: "memory",
        project_slug: "test",
        active_states: ["Todo"],
        terminal_states: ["Done"],
      },
      promptTemplate: "Fix it",
    });

    orchestrator.start();
    await orchestrator.stop();

    const state = orchestrator.getState();
    expect(state.running.size).toBe(0);
    expect(state.tickTimerId).toBeNull();
  });
});
