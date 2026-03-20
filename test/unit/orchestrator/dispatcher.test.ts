import { describe, it, expect } from "vitest";
import {
  sortIssuesForDispatch,
  shouldDispatchIssue,
  selectIssuesToDispatch,
} from "../../../src/orchestrator/dispatcher.js";
import { createInitialState } from "../../../src/orchestrator/types.js";
import type { NormalizedIssue } from "../../../src/tracker/types.js";

function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    id: "id-1",
    identifier: "MT-1",
    title: "Test",
    description: "",
    state: "Todo",
    priority: 2,
    labels: [],
    blockedBy: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("sortIssuesForDispatch", () => {
  it("sorts by priority ascending (urgent first)", () => {
    const issues = [
      makeIssue({ id: "low", priority: 4 }),
      makeIssue({ id: "urgent", priority: 0 }),
      makeIssue({ id: "high", priority: 1 }),
    ];
    const sorted = sortIssuesForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual(["urgent", "high", "low"]);
  });

  it("sorts by createdAt for same priority", () => {
    const issues = [
      makeIssue({ id: "new", priority: 2, createdAt: "2024-06-01T00:00:00Z" }),
      makeIssue({ id: "old", priority: 2, createdAt: "2024-01-01T00:00:00Z" }),
    ];
    const sorted = sortIssuesForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual(["old", "new"]);
  });

  it("sorts null priority after numeric priorities", () => {
    const issues = [
      makeIssue({ id: "a", priority: null, createdAt: "2024-01-01T00:00:00Z" }),
      makeIssue({ id: "b", priority: 1, createdAt: "2024-01-01T00:00:00Z" }),
      makeIssue({ id: "c", identifier: "MT-0", priority: 0, createdAt: "2024-01-01T00:00:00Z" }),
    ];
    const sorted = sortIssuesForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual(["c", "b", "a"]);
  });

  it("uses identifier as tiebreaker when priority and createdAt are equal", () => {
    const issues = [
      makeIssue({ id: "a", identifier: "MT-2", priority: 1, createdAt: "2024-01-01T00:00:00Z" }),
      makeIssue({ id: "b", identifier: "MT-1", priority: 1, createdAt: "2024-01-01T00:00:00Z" }),
    ];
    const sorted = sortIssuesForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual(["b", "a"]);
  });
});

describe("shouldDispatchIssue", () => {
  const config = {
    active_states: ["Todo", "In Progress"],
    terminal_states: ["Done"],
    max_concurrent_agents: 5,
  };

  it("allows dispatch for eligible issue", () => {
    const state = createInitialState();
    const issue = makeIssue();
    expect(shouldDispatchIssue(issue, state, config)).toBe(true);
  });

  it("rejects already running issue", () => {
    const state = createInitialState();
    state.running.set("id-1", {} as any);
    expect(shouldDispatchIssue(makeIssue(), state, config)).toBe(false);
  });

  it("rejects claimed issue", () => {
    const state = createInitialState();
    state.claimed.add("id-1");
    expect(shouldDispatchIssue(makeIssue(), state, config)).toBe(false);
  });

  it("allows dispatch for completed issue (observability only)", () => {
    const state = createInitialState();
    state.completed.add("id-1");
    expect(shouldDispatchIssue(makeIssue(), state, config)).toBe(true);
  });

  it("rejects issue with pending retry", () => {
    const state = createInitialState();
    state.retryAttempts.set("id-1", {} as any);
    expect(shouldDispatchIssue(makeIssue(), state, config)).toBe(false);
  });

  it("rejects issue not in active state", () => {
    const state = createInitialState();
    expect(shouldDispatchIssue(makeIssue({ state: "Done" }), state, config)).toBe(false);
  });

  it("rejects issue with active blockers", () => {
    const state = createInitialState();
    const issue = makeIssue({
      blockedBy: [{ id: "blocker", state: "In Progress" }],
    });
    expect(shouldDispatchIssue(issue, state, config)).toBe(false);
  });

  it("allows issue with completed blockers", () => {
    const state = createInitialState();
    const issue = makeIssue({
      blockedBy: [{ id: "blocker", state: "Done" }],
    });
    expect(shouldDispatchIssue(issue, state, config)).toBe(true);
  });

  it("rejects issue with non-terminal blockers even in non-active state", () => {
    const state = createInitialState();
    const issue = makeIssue({
      blockedBy: [{ id: "blocker", state: "Review" }],
    });
    // "Review" is not in terminal_states, so it should block
    expect(shouldDispatchIssue(issue, state, config)).toBe(false);
  });

  it("rejects when at concurrency limit", () => {
    const state = createInitialState();
    for (let i = 0; i < 5; i++) {
      state.running.set(`running-${i}`, {} as any);
    }
    expect(shouldDispatchIssue(makeIssue(), state, config)).toBe(false);
  });

  it("rejects when per-state concurrency limit reached", () => {
    const state = createInitialState();
    state.running.set("running-1", {
      issue: makeIssue({ id: "running-1", state: "Todo" }),
    } as any);
    state.running.set("running-2", {
      issue: makeIssue({ id: "running-2", state: "Todo" }),
    } as any);
    const perStateConfig = {
      ...config,
      max_concurrent_agents_by_state: { Todo: 2 },
    };
    expect(
      shouldDispatchIssue(makeIssue({ id: "new-1", state: "Todo" }), state, perStateConfig),
    ).toBe(false);
  });

  it("allows dispatch when per-state limit not reached", () => {
    const state = createInitialState();
    state.running.set("running-1", {
      issue: makeIssue({ id: "running-1", state: "In Progress" }),
    } as any);
    const perStateConfig = {
      ...config,
      max_concurrent_agents_by_state: { Todo: 2 },
    };
    expect(
      shouldDispatchIssue(makeIssue({ id: "new-1", state: "Todo" }), state, perStateConfig),
    ).toBe(true);
  });

  it("ignores per-state limit when not configured for that state", () => {
    const state = createInitialState();
    state.running.set("running-1", {
      issue: makeIssue({ id: "running-1", state: "Todo" }),
    } as any);
    const perStateConfig = {
      ...config,
      max_concurrent_agents_by_state: { "In Progress": 1 },
    };
    expect(
      shouldDispatchIssue(makeIssue({ id: "new-1", state: "Todo" }), state, perStateConfig),
    ).toBe(true);
  });
});

describe("selectIssuesToDispatch", () => {
  it("selects issues up to concurrency limit", () => {
    const state = createInitialState();
    const issues = [
      makeIssue({ id: "1", identifier: "MT-1" }),
      makeIssue({ id: "2", identifier: "MT-2" }),
      makeIssue({ id: "3", identifier: "MT-3" }),
    ];
    const selected = selectIssuesToDispatch(issues, state, {
      active_states: ["Todo"],
      terminal_states: ["Done"],
      max_concurrent_agents: 2,
    });
    expect(selected).toHaveLength(2);
  });

  it("respects priority ordering", () => {
    const state = createInitialState();
    const issues = [
      makeIssue({ id: "low", priority: 4 }),
      makeIssue({ id: "urgent", priority: 0 }),
    ];
    const selected = selectIssuesToDispatch(issues, state, {
      active_states: ["Todo"],
      terminal_states: ["Done"],
      max_concurrent_agents: 10,
    });
    expect(selected[0].id).toBe("urgent");
  });
});
