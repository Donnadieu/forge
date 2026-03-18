import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { ClaudeCodeAdapter } from "../../src/agent/claude.js";
import type { AgentEvent, SessionHandle } from "../../src/agent/types.js";

function claudeAvailable(): boolean {
  try {
    execSync("which claude", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!claudeAvailable())("ClaudeCodeAdapter (smoke)", () => {
  let adapter: ClaudeCodeAdapter;
  let handle: SessionHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await adapter.stopSession(handle);
      handle = undefined;
    }
  });

  it("spawns a real session and receives events including done", async () => {
    adapter = new ClaudeCodeAdapter();

    handle = await adapter.startSession({
      prompt: "Respond with exactly: hello",
      workspacePath: "/tmp",
    });

    expect(handle.id).toBeTruthy();
    expect(handle.pid).toBeGreaterThan(0);

    const events: AgentEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) {
      events.push(event);
    }

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents.length).toBeGreaterThanOrEqual(1);

    handle = undefined;
  }, 60_000);
});
