import { describe, it, expect } from "vitest";
import { MemoryTracker } from "../../../src/tracker/memory.js";
import type { NormalizedIssue, TrackerConfig } from "../../../src/tracker/types.js";

function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    id: "id-1",
    identifier: "MT-1",
    title: "Test issue",
    description: "A test issue",
    state: "Todo",
    priority: 2,
    labels: [],
    blockedBy: [],
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    kind: "memory",
    project_slug: "test-project",
    active_states: ["Todo", "In Progress"],
    terminal_states: ["Done", "Cancelled"],
    ...overrides,
  };
}

describe("MemoryTracker", () => {
  it("has kind set to 'memory'", () => {
    const tracker = new MemoryTracker();
    expect(tracker.kind).toBe("memory");
  });

  describe("constructor", () => {
    it("starts empty when no issues provided", async () => {
      const tracker = new MemoryTracker();
      const result = await tracker.fetchCandidates(makeConfig());
      expect(result).toEqual([]);
    });

    it("accepts initial issues", async () => {
      const issue = makeIssue({ id: "a", state: "Todo" });
      const tracker = new MemoryTracker([issue]);
      const result = await tracker.fetchCandidates(makeConfig());
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("a");
    });

    it("does not share references with the input array", () => {
      const issues = [makeIssue({ id: "a" })];
      const tracker = new MemoryTracker(issues);
      issues.push(makeIssue({ id: "b" }));
      // The tracker should not see the newly pushed issue
      expect(tracker.getIssue("b")).toBeUndefined();
    });
  });

  describe("addIssue", () => {
    it("adds an issue that can be retrieved", () => {
      const tracker = new MemoryTracker();
      const issue = makeIssue({ id: "x" });
      tracker.addIssue(issue);
      expect(tracker.getIssue("x")).toEqual(issue);
    });
  });

  describe("fetchCandidates", () => {
    it("returns issues whose state is in active_states", async () => {
      const tracker = new MemoryTracker([
        makeIssue({ id: "1", state: "Todo" }),
        makeIssue({ id: "2", state: "In Progress" }),
        makeIssue({ id: "3", state: "Done" }),
        makeIssue({ id: "4", state: "Cancelled" }),
      ]);

      const config = makeConfig({
        active_states: ["Todo", "In Progress"],
      });
      const result = await tracker.fetchCandidates(config);

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["1", "2"]);
    });

    it("returns empty array when no issues match active states", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "1", state: "Done" })]);
      const config = makeConfig({ active_states: ["Todo"] });
      const result = await tracker.fetchCandidates(config);
      expect(result).toEqual([]);
    });
  });

  describe("fetchIssueStatesByIds", () => {
    it("returns a map of id to state for existing issues", async () => {
      const tracker = new MemoryTracker([
        makeIssue({ id: "a", state: "Todo" }),
        makeIssue({ id: "b", state: "In Progress" }),
        makeIssue({ id: "c", state: "Done" }),
      ]);

      const result = await tracker.fetchIssueStatesByIds(["a", "c"]);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(2);
      expect(result.get("a")).toBe("Todo");
      expect(result.get("c")).toBe("Done");
    });

    it("omits ids that do not exist", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "a", state: "Todo" })]);

      const result = await tracker.fetchIssueStatesByIds(["a", "missing"]);
      expect(result.size).toBe(1);
      expect(result.has("missing")).toBe(false);
    });

    it("returns empty map for empty ids array", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "a", state: "Todo" })]);
      const result = await tracker.fetchIssueStatesByIds([]);
      expect(result.size).toBe(0);
    });
  });

  describe("fetchTerminalIssues", () => {
    it("returns issues whose state is in terminal_states", async () => {
      const tracker = new MemoryTracker([
        makeIssue({ id: "1", state: "Todo" }),
        makeIssue({ id: "2", state: "Done" }),
        makeIssue({ id: "3", state: "Cancelled" }),
      ]);

      const config = makeConfig({
        terminal_states: ["Done", "Cancelled"],
      });
      const result = await tracker.fetchTerminalIssues(config);

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.id).sort()).toEqual(["2", "3"]);
    });

    it("returns empty array when no issues match terminal states", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "1", state: "Todo" })]);
      const config = makeConfig({ terminal_states: ["Done"] });
      const result = await tracker.fetchTerminalIssues(config);
      expect(result).toEqual([]);
    });
  });

  describe("updateIssueState", () => {
    it("changes the state of an existing issue", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "1", state: "Todo" })]);

      tracker.updateIssueState("1", "Done");

      const issue = tracker.getIssue("1");
      expect(issue?.state).toBe("Done");
    });

    it("does nothing for a non-existent issue", () => {
      const tracker = new MemoryTracker();
      // Should not throw
      tracker.updateIssueState("missing", "Done");
    });

    it("reflects state change in fetchCandidates", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "1", state: "Todo" })]);
      const config = makeConfig({ active_states: ["Todo"] });

      expect(await tracker.fetchCandidates(config)).toHaveLength(1);

      tracker.updateIssueState("1", "Done");

      expect(await tracker.fetchCandidates(config)).toHaveLength(0);
    });

    it("reflects state change in fetchIssueStatesByIds", async () => {
      const tracker = new MemoryTracker([makeIssue({ id: "1", state: "Todo" })]);

      tracker.updateIssueState("1", "In Progress");

      const result = await tracker.fetchIssueStatesByIds(["1"]);
      expect(result.get("1")).toBe("In Progress");
    });
  });

  describe("getIssue", () => {
    it("returns the issue if it exists", () => {
      const issue = makeIssue({ id: "x" });
      const tracker = new MemoryTracker([issue]);
      expect(tracker.getIssue("x")).toEqual(issue);
    });

    it("returns undefined for non-existent issue", () => {
      const tracker = new MemoryTracker();
      expect(tracker.getIssue("nope")).toBeUndefined();
    });
  });
});
