import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeCodeAdapter } from "../../../src/agent/claude.js";
import type { AgentEvent } from "../../../src/agent/types.js";
import { EventEmitter, Readable, Writable } from "node:stream";
import * as child_process from "node:child_process";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

function createMockProcess(events: string[]): any {
  const stdout = new Readable({
    read() {
      for (const event of events) {
        this.push(`${event}\n`);
      }
      this.push(null);
    },
  });

  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new Readable({
      read() {
        this.push(null);
      },
    }),
    stdin,
    pid: 12345,
    exitCode: null as number | null,
    killed: false,
    kill: vi.fn(() => {
      (proc as any).killed = true;
      proc.emit("exit", 0);
    }),
  });

  // Simulate exit after stdout ends
  setTimeout(() => {
    (proc as any).exitCode = 0;
    proc.emit("exit", 0);
  }, 50);

  return proc;
}

describe("ClaudeCodeAdapter", () => {
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();
    vi.clearAllMocks();
  });

  it("starts a session with correct args", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Fix the bug",
      workspacePath: "/tmp/workspace",
    });

    expect(child_process.spawn).toHaveBeenCalledWith(
      "claude",
      ["-p", "--output-format", "stream-json", "--verbose"],
      expect.objectContaining({
        cwd: "/tmp/workspace",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(handle.pid).toBe(12345);
  });

  it("pipes prompt via stdin, not as positional arg", async () => {
    const writtenChunks: string[] = [];
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        writtenChunks.push(chunk.toString());
        callback();
      },
    });

    const mockProc = createMockProcess([]);
    (mockProc as any).stdin = stdin;
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Fix the bug",
      workspacePath: "/tmp/workspace",
    });

    expect(writtenChunks.join("")).toBe("Fix the bug");
    // Verify prompt is NOT in the spawn args
    const spawnArgs = vi.mocked(child_process.spawn).mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain("Fix the bug");
  });

  it("includes --mcp-config when provided", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Fix it",
      workspacePath: "/tmp/ws",
      mcpConfigPath: "/tmp/ws/.forge/mcp.json",
    });

    expect(child_process.spawn).toHaveBeenCalledWith(
      "claude",
      [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--mcp-config",
        "/tmp/ws/.forge/mcp.json",
      ],
      expect.anything(),
    );
  });

  it("includes --resume when sessionId provided", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Continue",
      workspacePath: "/tmp/ws",
      sessionId: "prev-session-123",
    });

    expect(child_process.spawn).toHaveBeenCalledWith(
      "claude",
      ["-p", "--output-format", "stream-json", "--verbose", "--resume", "prev-session-123"],
      expect.anything(),
    );
  });

  it("uses sessionId as handle id when provided", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Continue",
      workspacePath: "/tmp/ws",
      sessionId: "prev-session-123",
    });

    expect(handle.id).toBe("prev-session-123");
  });

  it("includes --dangerously-skip-permissions for bypassPermissions policy", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Do it",
      workspacePath: "/tmp/ws",
      approvalPolicy: "bypassPermissions",
    });

    expect(vi.mocked(child_process.spawn).mock.calls[0][1]).toContain(
      "--dangerously-skip-permissions",
    );
  });

  it("does not include --dangerously-skip-permissions for other policies", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Do it",
      workspacePath: "/tmp/ws",
      approvalPolicy: "manual",
    });

    expect(vi.mocked(child_process.spawn).mock.calls[0][1]).not.toContain(
      "--dangerously-skip-permissions",
    );
  });

  it("streams and maps text events", async () => {
    const events = [JSON.stringify({ type: "assistant", subtype: "text", text: "Hello world" })];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Hi",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toContainEqual({ type: "text", content: "Hello world" });
    expect(collected).toContainEqual({ type: "done", success: true });
  });

  it("streams and maps tool_use events", async () => {
    const events = [
      JSON.stringify({
        type: "assistant",
        subtype: "tool_use",
        tool: { name: "Read", id: "tool-1" },
        input: { file_path: "/src/main.ts" },
      }),
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Read file",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toContainEqual({
      type: "tool_use",
      tool: "Read",
      input: { file_path: "/src/main.ts" },
    });
  });

  it("streams tool_result events", async () => {
    const events = [
      JSON.stringify({
        type: "tool_result",
        content: [{ type: "text", text: "file contents here" }],
      }),
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Read file",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toContainEqual({
      type: "tool_result",
      output: [{ type: "text", text: "file contents here" }],
    });
  });

  it("streams usage events", async () => {
    const events = [
      JSON.stringify({
        type: "system",
        subtype: "usage",
        input_tokens: 100,
        output_tokens: 50,
      }),
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Count tokens",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toContainEqual({
      type: "usage",
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it("streams error events", async () => {
    const events = [
      JSON.stringify({
        type: "error",
        error: { message: "Something went wrong" },
      }),
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Fail",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toContainEqual({
      type: "error",
      message: "Something went wrong",
    });
  });

  it("maps result events to done events", async () => {
    const events = [
      JSON.stringify({
        type: "result",
        result: "Task complete",
        is_error: false,
        session_id: "abc-123",
      }),
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Do something",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toContainEqual({ type: "done", success: true });
  });

  it("skips non-JSON lines gracefully", async () => {
    const events = [
      "Starting claude...",
      JSON.stringify({ type: "assistant", subtype: "text", text: "Hi" }),
      "some debug output",
    ];
    const mockProc = createMockProcess(events);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Hi",
      workspacePath: "/tmp/ws",
    });

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    // Should only contain the text event and the done event, not crash on non-JSON
    const textEvents = collected.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toEqual({ type: "text", content: "Hi" });
  });

  it("yields error when no child process found", async () => {
    const handle = {
      id: "nonexistent-session",
      abortController: new AbortController(),
    };

    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toEqual([{ type: "error", message: "No child process found for session" }]);
  });

  it("stops a session by killing the process", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Long task",
      workspacePath: "/tmp/ws",
    });

    await adapter.stopSession(handle);
    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("cleans up process reference after stop", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Long task",
      workspacePath: "/tmp/ws",
    });

    await adapter.stopSession(handle);

    // After stop, streamEvents should yield an error (no process found)
    const collected: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      collected.push(event);
    }

    expect(collected).toEqual([{ type: "error", message: "No child process found for session" }]);
  });

  it("uses custom command when provided", async () => {
    const customAdapter = new ClaudeCodeAdapter({ command: "my-custom-agent" });
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await customAdapter.startSession({
      prompt: "Do it",
      workspacePath: "/tmp/ws",
    });

    expect(child_process.spawn).toHaveBeenCalledWith(
      "my-custom-agent",
      expect.any(Array),
      expect.anything(),
    );
  });

  it("does not pass signal option to spawn", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await adapter.startSession({
      prompt: "Test",
      workspacePath: "/tmp/ws",
    });

    const spawnOptions = vi.mocked(child_process.spawn).mock.calls[0][2] as Record<string, unknown>;
    expect(spawnOptions).not.toHaveProperty("signal");
  });

  it("kills process on abort instead of throwing", async () => {
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    const handle = await adapter.startSession({
      prompt: "Test",
      workspacePath: "/tmp/ws",
    });

    // Aborting should kill the process, not throw
    handle.abortController.abort();
    expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("defaults to 'claude' command when no option provided", async () => {
    const defaultAdapter = new ClaudeCodeAdapter();
    const mockProc = createMockProcess([]);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);

    await defaultAdapter.startSession({
      prompt: "Do it",
      workspacePath: "/tmp/ws",
    });

    expect(child_process.spawn).toHaveBeenCalledWith(
      "claude",
      expect.any(Array),
      expect.anything(),
    );
  });
});
