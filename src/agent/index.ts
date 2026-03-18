export type {
  AgentAdapter,
  AgentEvent,
  SessionHandle,
  StartSessionParams,
} from "./types.js";
export { ClaudeCodeAdapter } from "./claude.js";

import type { AgentAdapter } from "./types.js";
import { ClaudeCodeAdapter } from "./claude.js";

export function createAgent(kind: string, options?: { command?: string }): AgentAdapter {
  switch (kind) {
    case "claude":
      return new ClaudeCodeAdapter(options);
    default:
      throw new Error(`Unknown agent kind: ${kind}`);
  }
}
