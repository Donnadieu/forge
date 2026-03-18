import type { AgentAdapter, AgentEvent } from "../agent/types.js";
import type { TrackerAdapter, TrackerConfig, NormalizedIssue } from "../tracker/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { renderPrompt, buildPromptContext } from "./prompt-renderer.js";

export interface WorkerConfig {
  maxTurns: number;
  promptTemplate: string;
  trackerConfig: TrackerConfig;
  mcpServers?: Record<string, unknown>;
}

export interface WorkerResult {
  issueId: string;
  turns: number;
  tokens: { input: number; output: number };
  success: boolean;
  error?: string;
}

export interface WorkerCallbacks {
  onEvent?: (issueId: string, event: AgentEvent) => void;
  onTurnStart?: (issueId: string, turn: number) => void;
  onTurnEnd?: (issueId: string, turn: number) => void;
}

export async function runWorker(
  issue: NormalizedIssue,
  config: WorkerConfig,
  agent: AgentAdapter,
  tracker: TrackerAdapter,
  workspace: WorkspaceManager,
  callbacks?: WorkerCallbacks,
): Promise<WorkerResult> {
  const totalTokens = { input: 0, output: 0 };
  let turnNumber = 0;
  let sessionId: string | undefined;

  // 1. Create/reuse workspace
  const workspacePath = await workspace.ensureWorkspace(issue);

  // 2. Write MCP config if needed
  let mcpConfigPath: string | undefined;
  if (config.mcpServers) {
    mcpConfigPath = await workspace.writeMcpConfig(workspacePath, config.mcpServers);
  }

  // 3. Run before_run hook
  await workspace.runHook("before_run", workspacePath);

  try {
    // 4. Multi-turn loop
    while (turnNumber < config.maxTurns) {
      turnNumber++;
      callbacks?.onTurnStart?.(issue.id, turnNumber);

      // Build prompt
      const prompt =
        turnNumber === 1
          ? renderPrompt(config.promptTemplate, buildPromptContext(issue, 1))
          : `Continue working on ${issue.identifier}. This is turn ${turnNumber} of ${config.maxTurns}.`;

      // Spawn agent turn
      const handle = await agent.startSession({
        prompt,
        workspacePath,
        mcpConfigPath,
        sessionId,
      });

      sessionId = handle.id;

      // Stream events
      let turnSuccess = true;
      for await (const event of agent.streamEvents(handle)) {
        callbacks?.onEvent?.(issue.id, event);

        if (event.type === "usage") {
          totalTokens.input += event.inputTokens;
          totalTokens.output += event.outputTokens;
        }

        if (event.type === "error") {
          turnSuccess = false;
          break;
        }

        if (event.type === "done") {
          turnSuccess = event.success;
          break;
        }
      }

      callbacks?.onTurnEnd?.(issue.id, turnNumber);

      if (!turnSuccess) {
        break;
      }

      // Check if ticket is still in active state
      const currentStates = await tracker.fetchIssueStatesByIds([issue.id]);
      const currentState = currentStates.get(issue.id);

      if (!currentState || !config.trackerConfig.active_states.includes(currentState)) {
        // Ticket moved out of active state
        break;
      }
    }
  } finally {
    // 5. Run after_run hook
    await workspace.runHook("after_run", workspacePath);
  }

  return {
    issueId: issue.id,
    turns: turnNumber,
    tokens: totalTokens,
    success: true,
  };
}
