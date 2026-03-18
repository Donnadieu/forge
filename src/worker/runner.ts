import type { AgentAdapter, AgentEvent } from "../agent/types.js";
import type { TrackerAdapter, TrackerConfig, NormalizedIssue } from "../tracker/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { renderPrompt, buildPromptContext } from "./prompt-renderer.js";

export interface WorkerConfig {
  maxTurns: number;
  turnTimeoutMs?: number;
  readTimeoutMs?: number;
  approvalPolicy?: string;
  promptTemplate: string;
  trackerConfig: TrackerConfig;
  mcpServers?: Record<string, unknown>;
  skillsManifest?: string;
}

export interface WorkerResult {
  issueId: string;
  turns: number;
  tokens: { input: number; output: number };
  success: boolean;
  error?: string;
  workspacePath?: string;
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

  let lastTurnSuccess = true;

  try {
    // 4. Multi-turn loop
    while (turnNumber < config.maxTurns) {
      turnNumber++;
      callbacks?.onTurnStart?.(issue.id, turnNumber);

      // Turn timeout
      let turnTimedOut = false;
      let turnTimer: ReturnType<typeof setTimeout> | undefined;
      if (config.turnTimeoutMs) {
        turnTimer = setTimeout(() => {
          turnTimedOut = true;
        }, config.turnTimeoutMs);
      }

      // Build prompt
      const prompt =
        turnNumber === 1
          ? renderPrompt(config.promptTemplate, buildPromptContext(issue, 1, config.skillsManifest))
          : `Continue working on ${issue.identifier}. This is turn ${turnNumber} of ${config.maxTurns}.`;

      // Spawn agent turn
      const handle = await agent.startSession({
        prompt,
        workspacePath,
        mcpConfigPath,
        sessionId,
        approvalPolicy: config.approvalPolicy,
      });

      sessionId = handle.id;

      // Stream events with optional read timeout
      let turnSuccess = true;
      let readTimer: ReturnType<typeof setTimeout> | undefined;
      let readTimedOut = false;

      const resetReadTimer = () => {
        if (readTimer) clearTimeout(readTimer);
        if (config.readTimeoutMs) {
          readTimer = setTimeout(() => {
            readTimedOut = true;
            handle.abortController.abort();
          }, config.readTimeoutMs);
        }
      };

      resetReadTimer();

      for await (const event of agent.streamEvents(handle)) {
        resetReadTimer();
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

      if (readTimer) clearTimeout(readTimer);

      if (turnTimer) clearTimeout(turnTimer);
      if (turnTimedOut || readTimedOut) {
        await agent.stopSession(handle);
        lastTurnSuccess = false;
        break;
      }

      callbacks?.onTurnEnd?.(issue.id, turnNumber);

      if (!turnSuccess) {
        lastTurnSuccess = false;
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
    success: lastTurnSuccess,
    workspacePath: workspacePath,
  };
}
