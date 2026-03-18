import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { MemoryTracker } from "../../src/tracker/memory.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import type { NormalizedIssue } from "../../src/tracker/types.js";
import type { WorkerResult } from "../../src/worker/runner.js";
import type {
  AgentAdapter,
  AgentEvent,
  SessionHandle,
  StartSessionParams,
} from "../../src/agent/types.js";
import { createMockAgent, createTestIssue } from "../support/fixtures.js";
import { createTempDir, cleanupDir, waitFor } from "../support/test-helpers.js";

describe("Forge E2E", () => {
  let tempDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tempDir = createTempDir("forge-e2e");
    workspaceRoot = `${tempDir}/workspaces`;
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  function createOrchestrator(options: {
    issues: NormalizedIssue[];
    agent?: AgentAdapter;
    maxTurns?: number;
    maxConcurrent?: number;
    pollIntervalMs?: number;
    activeStates?: string[];
    terminalStates?: string[];
    callbacks?: {
      onDispatch?: (issue: NormalizedIssue) => void;
      onComplete?: (issueId: string, result: WorkerResult) => void;
      onError?: (issueId: string, error: Error) => void;
    };
  }) {
    const tracker = new MemoryTracker(options.issues);
    const agent = options.agent || createMockAgent();
    const workspace = new WorkspaceManager({
      root: workspaceRoot,
      hooks: {},
    });

    const activeStates = options.activeStates ?? ["Todo", "In Progress"];
    const terminalStates = options.terminalStates ?? ["Done", "Closed"];

    const orchestrator = new Orchestrator(
      tracker,
      agent,
      workspace,
      {
        pollIntervalMs: options.pollIntervalMs ?? 100,
        maxConcurrentAgents: options.maxConcurrent ?? 5,
        maxTurns: options.maxTurns ?? 1,
        stallTimeoutSeconds: 60,
        maxRetryAttempts: 3,
        maxRetryDelayMs: 10_000,
        trackerConfig: {
          kind: "memory",
          project_slug: "test",
          active_states: activeStates,
          terminal_states: terminalStates,
        },
        promptTemplate: "Fix {{ issue.identifier }}: {{ issue.title }}",
      },
      options.callbacks || {},
    );

    return { orchestrator, tracker, workspace };
  }

  it("processes an issue through the full lifecycle", async () => {
    const issue = createTestIssue({ id: "e2e-1", identifier: "MT-100", state: "Todo" });
    const dispatched: string[] = [];
    const completed: string[] = [];

    const { orchestrator, tracker } = createOrchestrator({
      issues: [issue],
      maxTurns: 2,
      callbacks: {
        onDispatch: (i) => dispatched.push(i.id),
        onComplete: (id) => completed.push(id),
      },
    });

    orchestrator.start();

    // Wait for the issue to be dispatched
    await waitFor(() => dispatched.length > 0, 3000);
    expect(dispatched).toContain("e2e-1");

    // The worker checks issue state after each turn. Move to Done so it exits cleanly.
    tracker.updateIssueState("e2e-1", "Done");

    // Wait for completion
    await waitFor(() => completed.length > 0, 5000);
    expect(completed).toContain("e2e-1");

    await orchestrator.stop();
  });

  it("dispatches multiple issues respecting priority", async () => {
    const issues = [
      createTestIssue({ id: "low", identifier: "MT-3", priority: 4, state: "Todo" }),
      createTestIssue({ id: "urgent", identifier: "MT-1", priority: 0, state: "Todo" }),
      createTestIssue({ id: "high", identifier: "MT-2", priority: 1, state: "Todo" }),
    ];
    const dispatched: string[] = [];

    // Issues stay in "Todo" (active state) so fetchCandidates returns them.
    // maxTurns=1 ensures the worker completes after a single turn.
    const { orchestrator } = createOrchestrator({
      issues,
      maxTurns: 1,
      callbacks: {
        onDispatch: (i) => dispatched.push(i.id),
      },
    });

    orchestrator.start();
    await waitFor(() => dispatched.length >= 3, 3000);

    // Urgent (priority 0) should be dispatched first
    expect(dispatched[0]).toBe("urgent");

    await orchestrator.stop();
  });

  it("stops worker when issue moves to terminal state between turns", async () => {
    const issue = createTestIssue({ id: "terminal-1", identifier: "MT-50", state: "In Progress" });
    const dispatched: string[] = [];
    const completedResults: WorkerResult[] = [];

    // Agent that introduces a small delay so we can observe the running state,
    // and supports multiple turns.
    const agent: AgentAdapter = {
      name: "slow-mock",
      async startSession(_params: StartSessionParams): Promise<SessionHandle> {
        return { id: `slow-${Date.now()}`, abortController: new AbortController() };
      },
      async *streamEvents(_handle: SessionHandle): AsyncIterable<AgentEvent> {
        // Small delay to simulate work
        await new Promise((r) => setTimeout(r, 50));
        yield { type: "text", content: "Working..." };
        yield { type: "done", success: true };
      },
      async stopSession(): Promise<void> {},
    };

    const { orchestrator, tracker } = createOrchestrator({
      issues: [issue],
      agent,
      maxTurns: 10,
      callbacks: {
        onDispatch: (i) => dispatched.push(i.id),
        onComplete: (_id, result) => {
          completedResults.push(result);
        },
      },
    });

    orchestrator.start();

    // Wait for the worker to be dispatched
    await waitFor(() => dispatched.length > 0, 3000);

    // Move to terminal state so the worker stops after the current turn
    tracker.updateIssueState("terminal-1", "Done");

    await waitFor(() => completedResults.length > 0, 5000);

    // Worker should have completed before exhausting all 10 turns
    expect(completedResults[0].turns).toBeLessThan(10);

    await orchestrator.stop();
  });

  it("does not dispatch issues with active blockers", async () => {
    const blocker = createTestIssue({
      id: "blocker-1",
      identifier: "MT-10",
      state: "In Progress",
    });
    const blocked = createTestIssue({
      id: "blocked-1",
      identifier: "MT-11",
      state: "Todo",
      blockers: [blocker],
    });

    const dispatched: string[] = [];

    const { orchestrator, tracker } = createOrchestrator({
      issues: [blocker, blocked],
      maxTurns: 1,
      callbacks: {
        onDispatch: (i) => dispatched.push(i.id),
      },
    });

    orchestrator.start();

    // Wait for at least the blocker to be dispatched
    await waitFor(() => dispatched.includes("blocker-1"), 3000);

    // Wait a couple more poll cycles to confirm blocked issue is NOT dispatched
    await new Promise((r) => setTimeout(r, 300));

    // The blocker should be dispatched, but not the blocked issue
    // (blocker is "In Progress" which is an active state, so blocked issue has active blockers)
    expect(dispatched).toContain("blocker-1");
    expect(dispatched).not.toContain("blocked-1");

    // Clean up: move blocker to Done so the worker finishes
    tracker.updateIssueState("blocker-1", "Done");

    await orchestrator.stop();
  });

  it("handles concurrent issue processing", async () => {
    const issues = Array.from({ length: 5 }, (_, i) =>
      createTestIssue({ id: `concurrent-${i}`, identifier: `MT-${i}`, state: "Todo" }),
    );

    const completed: string[] = [];

    // Issues stay in "Todo" (active). With maxTurns=1, workers complete after 1 turn.
    const { orchestrator } = createOrchestrator({
      issues,
      maxTurns: 1,
      maxConcurrent: 3, // Limit to 3 at a time
      callbacks: {
        onComplete: (id) => completed.push(id),
      },
    });

    orchestrator.start();

    // Should eventually process all 5 (3 in first batch, then 2 more)
    await waitFor(() => completed.length >= 5, 10_000);

    await orchestrator.stop();

    expect(completed).toHaveLength(5);
  });

  it("accumulates token usage", async () => {
    const issue = createTestIssue({ id: "tokens-1", identifier: "MT-99", state: "Todo" });

    const agent = createMockAgent({
      events: [
        [
          { type: "usage", inputTokens: 500, outputTokens: 200 },
          { type: "text", content: "Done" },
          { type: "done", success: true },
        ],
      ],
    });

    const completedResults: WorkerResult[] = [];

    // Issue stays in "Todo" (active) so it gets fetched and dispatched.
    // maxTurns=1 ensures the worker completes after a single turn.
    const { orchestrator } = createOrchestrator({
      issues: [issue],
      agent,
      maxTurns: 1,
      callbacks: {
        onComplete: (_id, result) => completedResults.push(result),
      },
    });

    orchestrator.start();
    await waitFor(() => completedResults.length > 0, 5000);
    await orchestrator.stop();

    expect(completedResults[0].tokens.input).toBe(500);
    expect(completedResults[0].tokens.output).toBe(200);
  });
});
