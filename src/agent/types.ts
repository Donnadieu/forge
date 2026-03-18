export interface AgentAdapter {
  readonly name: string;

  startSession(params: StartSessionParams): Promise<SessionHandle>;
  streamEvents(handle: SessionHandle): AsyncIterable<AgentEvent>;
  stopSession(handle: SessionHandle): Promise<void>;
}

export interface StartSessionParams {
  prompt: string;
  workspacePath: string;
  mcpConfigPath?: string;
  sessionId?: string; // for resume/continuation
  maxTurns?: number;
  approvalPolicy?: string;
  sshHost?: string; // for remote execution via SSH
  sshConfigPath?: string; // path to SSH config file
}

export interface SessionHandle {
  id: string;
  pid?: number;
  abortController: AbortController;
}

export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: unknown }
  | { type: "tool_result"; output: unknown }
  | { type: "error"; message: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; success: boolean };
