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
    blockers: [],
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

  it("rejects completed issue", () => {
    const state = createInitialState();
    state.completed.add("id-1");
    expect(shouldDispatchIssue(makeIssue(), state, config)).toBe(false);
  });

  it("rejects issue with pending retry", () => {
    const state = createInitialState();
    state.retryAttempts.set("id-1", {} as any);
    expect(shouldDispatchIssue(makeIssue(), state, config)).toBe(false);
  });

  it("rejects issue not in active state", () => {
    const state = createInitialState();
    expect(
      shouldDispatchIssue(makeIssue({ state: "Done" }), state, config),
    ).toBe(false);
  });

  it("rejects issue with active blockers", () => {
    const state = createInitialState();
    const issue = makeIssue({
      blockers: [makeIssue({ id: "blocker", state: "In Progress" })],
    });
    expect(shouldDispatchIssue(issue, state, config)).toBe(false);
  });

  it("allows issue with completed blockers", () => {
    const state = createInitialState();
    const issue = makeIssue({
      blockers: [makeIssue({ id: "blocker", state: "Done" })],
    });
    expect(shouldDispatchIssue(issue, state, config)).toBe(true);
  });

  it("rejects when at concurrency limit", () => {
    const state = createInitialState();
    for (let i = 0; i < 5; i++) {
      state.running.set(`running-${i}`, {} as any);
    }
    expect(shouldDispatchIssue(makeIssue(), state, config)).toBe(false);
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
