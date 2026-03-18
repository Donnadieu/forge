import { describe, it, expect, vi, afterEach } from "vitest";
import {
  calculateRetryDelay,
  scheduleRetry,
  cancelRetry,
  cancelAllRetries,
} from "../../../src/orchestrator/retry-queue.js";
import { createInitialState } from "../../../src/orchestrator/types.js";

describe("calculateRetryDelay", () => {
  it("returns 1s for continuation retries", () => {
    expect(calculateRetryDelay(1, "continuation", 300_000)).toBe(1_000);
    expect(calculateRetryDelay(5, "continuation", 300_000)).toBe(1_000);
  });

  it("returns exponential backoff for failure retries", () => {
    expect(calculateRetryDelay(1, "failure", 300_000)).toBe(10_000);
    expect(calculateRetryDelay(2, "failure", 300_000)).toBe(20_000);
    expect(calculateRetryDelay(3, "failure", 300_000)).toBe(40_000);
    expect(calculateRetryDelay(4, "failure", 300_000)).toBe(80_000);
  });

  it("caps at max delay", () => {
    expect(calculateRetryDelay(10, "failure", 300_000)).toBe(300_000);
  });

  it("uses custom base delay when provided", () => {
    expect(calculateRetryDelay(1, "failure", 300_000, 5_000)).toBe(5_000);
    expect(calculateRetryDelay(2, "failure", 300_000, 5_000)).toBe(10_000);
    expect(calculateRetryDelay(3, "failure", 300_000, 5_000)).toBe(20_000);
  });

  it("uses default base delay when not provided", () => {
    // Default is 10_000
    expect(calculateRetryDelay(1, "failure", 300_000)).toBe(10_000);
    expect(calculateRetryDelay(1, "failure", 300_000, undefined)).toBe(10_000);
  });
});

describe("scheduleRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules a retry and calls callback", async () => {
    vi.useFakeTimers();
    const state = createInitialState();
    const onRetry = vi.fn();

    scheduleRetry(state, "id-1", "MT-1", 1, "continuation", null, 300_000, onRetry);

    expect(state.retryAttempts.has("id-1")).toBe(true);
    expect(state.retryAttempts.get("id-1")?.attempt).toBe(1);

    vi.advanceTimersByTime(1_500);
    expect(onRetry).toHaveBeenCalledWith("id-1");
    expect(state.retryAttempts.has("id-1")).toBe(false);
  });

  it("cancels previous retry when scheduling new one", () => {
    vi.useFakeTimers();
    const state = createInitialState();
    const onRetry = vi.fn();

    scheduleRetry(state, "id-1", "MT-1", 1, "failure", null, 300_000, onRetry);

    scheduleRetry(state, "id-1", "MT-1", 2, "failure", null, 300_000, onRetry);

    // First timer should be cleared
    vi.advanceTimersByTime(15_000); // Past first delay
    expect(onRetry).not.toHaveBeenCalled(); // First was cancelled

    vi.advanceTimersByTime(25_000); // Past second delay (20s)
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("cancelRetry", () => {
  it("removes retry entry and clears timer", () => {
    vi.useFakeTimers();
    const state = createInitialState();
    scheduleRetry(state, "id-1", "MT-1", 1, "failure", null, 300_000, vi.fn());

    expect(state.retryAttempts.has("id-1")).toBe(true);
    cancelRetry(state, "id-1");
    expect(state.retryAttempts.has("id-1")).toBe(false);
    vi.useRealTimers();
  });
});

describe("cancelAllRetries", () => {
  it("cancels all pending retries", () => {
    vi.useFakeTimers();
    const state = createInitialState();
    scheduleRetry(state, "id-1", "MT-1", 1, "failure", null, 300_000, vi.fn());
    scheduleRetry(state, "id-2", "MT-2", 1, "failure", null, 300_000, vi.fn());

    expect(state.retryAttempts.size).toBe(2);
    cancelAllRetries(state);
    expect(state.retryAttempts.size).toBe(0);
    vi.useRealTimers();
  });
});
