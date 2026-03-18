import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentAdapter, AgentEvent, SessionHandle, StartSessionParams } from "./types.js";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude";
  private processes = new Map<string, ChildProcess>();

  async startSession(params: StartSessionParams): Promise<SessionHandle> {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];

    if (params.mcpConfigPath) {
      args.push("--mcp-config", params.mcpConfigPath);
    }

    if (params.sessionId) {
      args.push("--resume", params.sessionId);
    }

    if (params.approvalPolicy === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    }

    const abortController = new AbortController();

    const child = spawn("claude", args, {
      cwd: params.workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      signal: abortController.signal,
    });

    // CRITICAL: Pipe prompt via stdin, never as positional arg (avoids ENAMETOOLONG)
    child.stdin.write(params.prompt);
    child.stdin.end();

    const id = params.sessionId || `session-${child.pid}-${Date.now()}`;
    this.processes.set(id, child);

    return { id, pid: child.pid, abortController };
  }

  async *streamEvents(handle: SessionHandle): AsyncIterable<AgentEvent> {
    const child = this.processes.get(handle.id);
    if (!child?.stdout) {
      yield { type: "error", message: "No child process found for session" };
      return;
    }

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line);
          const mapped = this.mapEvent(raw);
          if (mapped) yield mapped;
        } catch {
          // Skip non-JSON lines (e.g. startup messages)
        }
      }
    } finally {
      rl.close();
    }

    // Yield final done event based on exit code
    const exitCode = await this.waitForExit(child);
    yield { type: "done", success: exitCode === 0 };
  }

  async stopSession(handle: SessionHandle): Promise<void> {
    handle.abortController.abort();
    const child = this.processes.get(handle.id);
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    this.processes.delete(handle.id);
  }

  private mapEvent(raw: Record<string, unknown>): AgentEvent | null {
    // Claude stream-json event types:
    // { type: "assistant", subtype: "text", text: "..." }
    // { type: "assistant", subtype: "tool_use", tool: { name, id }, input: {...} }
    // { type: "tool_result", content: [...] }
    // { type: "result", result: "...", is_error: bool, session_id: "..." }
    // { type: "system", subtype: "usage", ... usage fields }
    // { type: "error", error: { message: "..." } }

    const type = raw.type as string;

    if (type === "assistant") {
      const subtype = raw.subtype as string;
      if (subtype === "text") {
        return { type: "text", content: (raw.text as string) || "" };
      }
      if (subtype === "tool_use") {
        const tool = raw.tool as { name: string } | undefined;
        return {
          type: "tool_use",
          tool: tool?.name || "unknown",
          input: raw.input,
        };
      }
    }

    if (type === "tool_result") {
      return { type: "tool_result", output: raw.content };
    }

    if (type === "result") {
      return { type: "done", success: !raw.is_error };
    }

    if (type === "system" && (raw as Record<string, unknown>).subtype === "usage") {
      return {
        type: "usage",
        inputTokens: ((raw as Record<string, unknown>).input_tokens as number) || 0,
        outputTokens: ((raw as Record<string, unknown>).output_tokens as number) || 0,
      };
    }

    if (type === "error") {
      const error = raw.error as { message?: string } | undefined;
      return { type: "error", message: error?.message || "Unknown error" };
    }

    return null;
  }

  private waitForExit(child: ChildProcess): Promise<number | null> {
    return new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode);
      } else {
        child.on("exit", (code) => resolve(code));
      }
    });
  }
}
