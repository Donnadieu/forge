import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentAdapter, AgentEvent, SessionHandle, StartSessionParams } from "./types.js";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude";
  private processes = new Map<string, ChildProcess>();
  private command: string;

  constructor(options?: { command?: string }) {
    this.command = options?.command || "claude";
  }

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

    let child: ChildProcess;

    if (params.sshHost) {
      const sshSpawn = this.buildSshSpawn(
        params.sshHost,
        params.workspacePath,
        this.command,
        args,
        params.sshConfigPath,
      );
      child = spawn(sshSpawn.command, sshSpawn.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      child = spawn(this.command, args, {
        cwd: params.workspacePath,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    // Handle abort by killing the process instead of using signal option
    // (signal option throws unhandled AbortError)
    abortController.signal.addEventListener("abort", () => {
      if (!child.killed) child.kill("SIGTERM");
    });

    // Suppress unhandled error events from the child process
    child.on("error", () => {});

    // CRITICAL: Pipe prompt via stdin, never as positional arg (avoids ENAMETOOLONG)
    child.stdin?.write(params.prompt);
    child.stdin?.end();

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
          if (mapped) {
            if (Array.isArray(mapped)) {
              for (const event of mapped) yield event;
            } else {
              yield mapped;
            }
          }
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

  /**
   * Build the command and args to spawn an SSH process that runs the agent remotely.
   * Inlined here to avoid cross-module imports (agent has no cross-module deps).
   */
  private buildSshSpawn(
    host: string,
    workspacePath: string,
    command: string,
    args: string[],
    sshConfigPath?: string,
  ): { command: string; args: string[] } {
    const sshArgs = ["-T"];

    if (sshConfigPath) sshArgs.push("-F", sshConfigPath);

    const colonIdx = host.lastIndexOf(":");
    if (colonIdx > 0 && /^\d+$/.test(host.slice(colonIdx + 1))) {
      sshArgs.push("-p", host.slice(colonIdx + 1));
      sshArgs.push(host.slice(0, colonIdx));
    } else {
      sshArgs.push(host);
    }

    const esc = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const escapedArgs = [command, ...args].map(esc).join(" ");
    sshArgs.push(`bash -lc ${esc(`cd ${esc(workspacePath)} && ${escapedArgs}`)}`);

    return { command: "ssh", args: sshArgs };
  }

  private mapEvent(raw: Record<string, unknown>): AgentEvent | AgentEvent[] | null {
    const type = raw.type as string;
    const subtype = raw.subtype as string | undefined;

    if (type === "assistant") {
      // Per-event streaming format: { type: "assistant", subtype: "text", text: "..." }
      if (subtype === "text" && typeof raw.text === "string") {
        return { type: "text", content: raw.text };
      }

      // Per-event streaming format: { type: "assistant", subtype: "tool_use", tool: {...}, input: {...} }
      if (subtype === "tool_use") {
        const tool = raw.tool as Record<string, unknown> | undefined;
        return {
          type: "tool_use",
          tool: (tool?.name as string) || "unknown",
          input: raw.input,
        };
      }

      // Batch format: { type: "assistant", message: { content: [...], usage: {...} } }
      const message = raw.message as Record<string, unknown> | undefined;
      if (message) {
        const events: AgentEvent[] = [];

        const content = message.content as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const item of content) {
            if (item.type === "text" && item.text) {
              events.push({ type: "text", content: item.text as string });
            }
            if (item.type === "tool_use") {
              events.push({
                type: "tool_use",
                tool: (item.name as string) || "unknown",
                input: item.input,
              });
            }
          }
        }

        // Skip assistant.message.usage — system usage events are canonical
        return events.length > 0 ? events : null;
      }
    }

    // Tool result events: { type: "tool_result", content: [...] }
    if (type === "tool_result") {
      return {
        type: "tool_result",
        output: raw.content,
      };
    }

    // System usage events: { type: "system", subtype: "usage", input_tokens: N, output_tokens: N }
    if (type === "system" && subtype === "usage") {
      return {
        type: "usage",
        inputTokens: (raw.input_tokens as number) || 0,
        outputTokens: (raw.output_tokens as number) || 0,
      };
    }

    if (type === "result") {
      // Don't emit usage from result — system usage events are canonical
      return { type: "done", success: !raw.is_error };
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
