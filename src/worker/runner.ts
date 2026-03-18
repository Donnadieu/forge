import type { AgentAdapter, AgentEvent, SessionHandle } from "../agent/types.js";
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
  signal?: AbortSignal;
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
  let currentHandle: SessionHandle | null = null;
  let aborted = false;

  if (callbacks?.signal?.aborted) {
    return { issueId: issue.id, turns: 0, tokens: totalTokens, success: false, error: "Aborted" };
  }
  callbacks?.signal?.addEventListener(
    "abort",
    () => {
      aborted = true;
      if (currentHandle) currentHandle.abortController.abort();
    },
    { once: true },
  );

  // 1. Create/reuse workspace
  const workspacePath = await workspace.ensureWorkspace(issue);

  // 2. Write MCP config if needed
  let mcpConfigPath: string | undefined;
  if (config.mcpServers) {
    mcpConfigPath = await workspace.writeMcpConfig(workspacePath, config.mcpServers);
  }

  // 3. Run before_run hook with issue env vars
  const issueEnv: Record<string, string> = {
    ISSUE_ID: issue.id,
    ISSUE_IDENTIFIER: issue.identifier,
    ISSUE_TITLE: issue.title,
    ISSUE_STATE: issue.state,
    ISSUE_BRANCH: issue.branchName ?? `forge/${issue.identifier}`,
  };
  await workspace.runHook("before_run", workspacePath, issueEnv);

  let lastTurnSuccess = true;

  try {
    // 4. Multi-turn loop
    while (turnNumber < config.maxTurns && !aborted) {
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

      currentHandle = handle;
      sessionId = handle.id;

      if (aborted) {
        handle.abortController.abort();
        lastTurnSuccess = false;
        break;
      }

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
      try {
        const currentStates = await tracker.fetchIssueStatesByIds([issue.id]);
        const currentState = currentStates.get(issue.id);

        // Only break on confirmed non-active state.
        // If the map has no entry (e.g. transient API failure), continue working.
        if (
          currentState !== undefined &&
          !config.trackerConfig.active_states.includes(currentState)
        ) {
          break;
        }
      } catch {
        // State check failed — continue working.
        // The reconciler will catch persistent state changes on the next tick.
      }
    }
  } finally {
    // 5. Run after_run hook — catch to avoid masking the worker result
    try {
      await workspace.runHook("after_run", workspacePath, issueEnv);
    } catch {
      // after_run hook failure should not mask the worker result
    }
  }

  return {
    issueId: issue.id,
    turns: turnNumber,
    tokens: totalTokens,
    success: lastTurnSuccess,
    workspacePath: workspacePath,
  };
}
