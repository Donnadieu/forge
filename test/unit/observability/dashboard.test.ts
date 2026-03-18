import { describe, it, expect, vi, afterEach } from "vitest";
import { Dashboard } from "../../../src/observability/dashboard.js";
import type { StateSnapshot } from "../../../src/observability/types.js";

/** Collects all writes into a string buffer. */
function createMockOutput(): { stream: NodeJS.WritableStream; output: () => string } {
  let buf = "";
  const stream = {
    write(chunk: string | Buffer) {
      buf += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    },
  } as NodeJS.WritableStream;
  return { stream, output: () => buf };
}

function makeSnapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    counts: { running: 0, retrying: 0 },
    running: [],
    retrying: [],
    codexTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
    },
    rateLimits: null,
    ...overrides,
  };
}

describe("Dashboard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders empty snapshot with expected sections", () => {
    const { stream, output } = createMockOutput();
    const dashboard = new Dashboard({ output: stream });

    dashboard.render(makeSnapshot());

    const rendered = output();
    expect(rendered).toContain("Forge v0.1.0");
    expect(rendered).toContain("0 running");
    expect(rendered).toContain("0 retrying");
    expect(rendered).toContain("No running sessions");
    expect(rendered).toContain("Totals");
    expect(rendered).toContain("Updated:");
  });

  it("renders running sessions with issue identifier", () => {
    const { stream, output } = createMockOutput();
    const dashboard = new Dashboard({ output: stream });

    const snapshot = makeSnapshot({
      counts: { running: 1, retrying: 0 },
      running: [
        {
          issueId: "id-1",
          identifier: "MT-42",
          state: "working",
          sessionId: "sess-1",
          turnCount: 3,
          lastEvent: "tool_use",
          lastMessage: "Running tests",
          startedAt: new Date(Date.now() - 120_000).toISOString(),
          lastEventAt: new Date().toISOString(),
          tokens: { input: 15000, output: 3200, total: 18200 },
          workspacePath: "/tmp/ws",
          attempt: 1,
          host: null,
        },
      ],
    });

    dashboard.render(snapshot);

    const rendered = output();
    expect(rendered).toContain("Running Sessions");
    expect(rendered).toContain("MT-42");
    expect(rendered).toContain("working");
    expect(rendered).toContain("1 running");
    expect(rendered).toContain("15.0k");
    expect(rendered).toContain("3.2k");
  });

  it("renders retry queue", () => {
    const { stream, output } = createMockOutput();
    const dashboard = new Dashboard({ output: stream });

    const snapshot = makeSnapshot({
      counts: { running: 0, retrying: 1 },
      retrying: [
        {
          issueId: "id-2",
          identifier: "MT-99",
          attempt: 2,
          dueAt: new Date(Date.now() + 30_000).toISOString(),
          error: "Rate limited by provider",
        },
      ],
    });

    dashboard.render(snapshot);

    const rendered = output();
    expect(rendered).toContain("Retry Queue");
    expect(rendered).toContain("MT-99");
    expect(rendered).toContain("Rate limited by provider");
  });

  it("renders token totals with formatting", () => {
    const { stream, output } = createMockOutput();
    const dashboard = new Dashboard({ output: stream });

    const snapshot = makeSnapshot({
      codexTotals: {
        inputTokens: 1_500_000,
        outputTokens: 250_000,
        totalTokens: 1_750_000,
        secondsRunning: 3661,
      },
    });

    dashboard.render(snapshot);

    const rendered = output();
    expect(rendered).toContain("1.5M");
    expect(rendered).toContain("250.0k");
    expect(rendered).toContain("1.8M");
    expect(rendered).toContain("1h1m");
  });

  it("renders httpPort when provided", () => {
    const { stream, output } = createMockOutput();
    const dashboard = new Dashboard({ output: stream });

    dashboard.render(makeSnapshot(), 8080);

    const rendered = output();
    expect(rendered).toContain("http://127.0.0.1:8080/");
  });

  it("renders log file path when provided", () => {
    const { stream, output } = createMockOutput();
    const dashboard = new Dashboard({ output: stream });

    dashboard.render(makeSnapshot(), undefined, "/tmp/forge.log");

    const rendered = output();
    expect(rendered).toContain("Logs: /tmp/forge.log");
  });

  it("start() renders immediately and stop() clears interval", () => {
    vi.useFakeTimers();
    const { stream, output } = createMockOutput();
    const dashboard = new Dashboard({ output: stream });
    const snapshotFn = vi.fn(() => makeSnapshot());

    dashboard.start(1000, snapshotFn);

    // Should have called snapshotFn once immediately
    expect(snapshotFn).toHaveBeenCalledTimes(1);
    expect(output()).toContain("Forge v0.1.0");

    // Advance timer — should render again
    vi.advanceTimersByTime(1000);
    expect(snapshotFn).toHaveBeenCalledTimes(2);

    // Advance again
    vi.advanceTimersByTime(1000);
    expect(snapshotFn).toHaveBeenCalledTimes(3);

    // Stop should prevent further renders
    dashboard.stop();
    vi.advanceTimersByTime(5000);
    expect(snapshotFn).toHaveBeenCalledTimes(3);
  });

  it("stop() is idempotent when not started", () => {
    const { stream } = createMockOutput();
    const dashboard = new Dashboard({ output: stream });
    // Should not throw
    dashboard.stop();
    dashboard.stop();
  });
});
