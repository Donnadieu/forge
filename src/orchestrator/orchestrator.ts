import type { AgentAdapter } from "../agent/types.js";
import type { TrackerAdapter, TrackerConfig, NormalizedIssue } from "../tracker/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { runWorker, type WorkerConfig, type WorkerResult } from "../worker/runner.js";
import { type OrchestratorState, type RunningEntry, createInitialState } from "./types.js";
import { selectIssuesToDispatch } from "./dispatcher.js";
import { reconcileRunningIssues } from "./reconciler.js";
import { scheduleRetry, cancelRetry, cancelAllRetries } from "./retry-queue.js";

export interface OrchestratorConfig {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  maxTurns: number;
  turnTimeoutMs?: number;
  readTimeoutMs?: number;
  approvalPolicy?: string;
  stallTimeoutSeconds: number;
  maxRetryAttempts: number;
  maxRetryDelayMs: number;
  retryBaseDelayMs?: number;
  trackerConfig: TrackerConfig;
  promptTemplate: string;
  mcpServers?: Record<string, unknown>;
  skillsManifest?: string;
}

export interface OrchestratorCallbacks {
  onDispatch?: (issue: NormalizedIssue) => void;
  onComplete?: (issueId: string, result: WorkerResult) => void;
  onError?: (issueId: string, error: Error) => void;
  onReconcile?: (toKill: string[], toRetry: string[]) => void;
  onPollError?: (error: Error) => void;
}

export class Orchestrator {
  private state: OrchestratorState;
  private tracker: TrackerAdapter;
  private agent: AgentAdapter;
  private workspace: WorkspaceManager;
  private config: OrchestratorConfig;
  private callbacks: OrchestratorCallbacks;
  private stopped = false;

  constructor(
    tracker: TrackerAdapter,
    agent: AgentAdapter,
    workspace: WorkspaceManager,
    config: OrchestratorConfig,
    callbacks: OrchestratorCallbacks = {},
  ) {
    this.state = createInitialState();
    this.tracker = tracker;
    this.agent = agent;
    this.workspace = workspace;
    this.config = config;
    this.callbacks = callbacks;
  }

  /**
   * Start the orchestrator tick loop.
   */
  start(): void {
    this.stopped = false;
    this.scheduleTick(0);
  }

  /**
   * Stop the orchestrator, terminating all running workers.
   */
  async stop(): Promise<void> {
    this.stopped = true;

    // Cancel tick timer
    if (this.state.tickTimerId) {
      clearTimeout(this.state.tickTimerId);
      this.state.tickTimerId = null;
    }

    // Cancel all retries
    cancelAllRetries(this.state);

    // Abort all running workers
    for (const [, entry] of this.state.running) {
      entry.abortController.abort();
    }

    // Wait for all workers to finish
    const promises = Array.from(this.state.running.values()).map((e) =>
      e.workerPromise.catch(() => {}),
    );
    await Promise.allSettled(promises);

    this.state.running.clear();
  }

  /**
   * Get current orchestrator state (for observability).
   */
  getState(): Readonly<OrchestratorState> {
    return this.state;
  }

  /**
   * Update config (for hot-reload).
   */
  updateConfig(config: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    this.state.tickTimerId = setTimeout(() => this.onTick(), delayMs);
  }

  private async onTick(): Promise<void> {
    if (this.stopped) return;

    try {
      await this.pollCycle();
    } catch (error) {
      // Report error but don't crash the loop
      const err = error instanceof Error ? error : new Error(String(error));
      this.callbacks.onPollError?.(err);
    }

    // Schedule next tick
    this.scheduleTick(this.config.pollIntervalMs);
  }

  private async pollCycle(): Promise<void> {
    // 1. Reconcile running issues
    const reconcileResult = await reconcileRunningIssues(this.state, this.tracker, {
      active_states: this.config.trackerConfig.active_states,
      terminal_states: this.config.trackerConfig.terminal_states,
      stall_timeout_seconds: this.config.stallTimeoutSeconds,
    });

    // Handle reconciliation results
    for (const issueId of reconcileResult.toKill) {
      this.killWorker(issueId);
    }
    for (const issueId of reconcileResult.toRetry) {
      this.killAndRetry(issueId, "failure", "Stalled");
    }

    this.callbacks.onReconcile?.(reconcileResult.toKill, reconcileResult.toRetry);

    // 2. Fetch candidates
    const candidates = await this.tracker.fetchCandidates(this.config.trackerConfig);

    // 3. Select and dispatch
    const toDispatch = selectIssuesToDispatch(candidates, this.state, {
      active_states: this.config.trackerConfig.active_states,
      terminal_states: this.config.trackerConfig.terminal_states,
      max_concurrent_agents: this.config.maxConcurrentAgents,
    });

    for (const issue of toDispatch) {
      await this.dispatchIssue(issue);
    }
  }

  private async dispatchIssue(issue: NormalizedIssue, attempt = 1): Promise<void> {
    if (this.stopped) return;

    // Re-validate state to catch races between fetchCandidates and dispatch
    try {
      const states = await this.tracker.fetchIssueStatesByIds([issue.id]);
      const currentState = states.get(issue.id);
      if (currentState !== undefined &&
          !this.config.trackerConfig.active_states.includes(currentState)) {
        return;
      }
    } catch {
      // Re-validation failed; proceed with dispatch (fail-open)
    }

    this.state.claimed.add(issue.id);
    this.callbacks.onDispatch?.(issue);

    const abortController = new AbortController();
    const workerConfig: WorkerConfig = {
      maxTurns: this.config.maxTurns,
      turnTimeoutMs: this.config.turnTimeoutMs,
      readTimeoutMs: this.config.readTimeoutMs,
      approvalPolicy: this.config.approvalPolicy,
      promptTemplate: this.config.promptTemplate,
      trackerConfig: this.config.trackerConfig,
      mcpServers: this.config.mcpServers,
      skillsManifest: this.config.skillsManifest,
    };

    const workerPromise = runWorker(issue, workerConfig, this.agent, this.tracker, this.workspace, {
      onEvent: (issueId, event) => {
        const entry = this.state.running.get(issueId);
        if (entry) {
          entry.lastActivityAt = performance.now();
          if (event.type === "usage") {
            entry.tokens.input += event.inputTokens;
            entry.tokens.output += event.outputTokens;
            this.state.totalTokens.input += event.inputTokens;
            this.state.totalTokens.output += event.outputTokens;
          }
        }
      },
    })
      .then((result) => {
        this.handleWorkerComplete(issue.id, result, attempt);
      })
      .catch((error) => {
        this.handleWorkerError(issue.id, issue.identifier, error, attempt);
      });

    const now = performance.now();
    const entry: RunningEntry = {
      issueId: issue.id,
      identifier: issue.identifier,
      issue,
      startedAt: now,
      lastActivityAt: now,
      tokens: { input: 0, output: 0 },
      workspacePath: null,
      attempt,
      abortController,
      workerPromise,
    };

    this.state.running.set(issue.id, entry);
    this.state.claimed.delete(issue.id);
  }

  private async handleWorkerComplete(
    issueId: string,
    result: WorkerResult,
    attempt: number,
  ): Promise<void> {
    const entry = this.state.running.get(issueId);
    this.state.running.delete(issueId);
    this.callbacks.onComplete?.(issueId, result);

    if (result.success) {
      // Check if ticket is still active — if so, schedule continuation
      try {
        const states = await this.tracker.fetchIssueStatesByIds([issueId]);
        const currentState = states.get(issueId);
        if (currentState && this.config.trackerConfig.active_states.includes(currentState)) {
          const identifier = entry?.identifier ?? "";
          const issue = entry?.issue;
          if (issue) {
            scheduleRetry(
              this.state,
              issueId,
              identifier,
              attempt + 1,
              "continuation",
              null,
              this.config.maxRetryDelayMs,
              (retryId) => {
                this.dispatchIssue(issue, attempt + 1);
              },
              this.config.retryBaseDelayMs,
            );
            return;
          }
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.callbacks.onError?.(issueId, err);
      }
    }
    this.state.completed.add(issueId);
  }

  private handleWorkerError(
    issueId: string,
    identifier: string,
    error: unknown,
    attempt: number,
  ): void {
    this.state.running.delete(issueId);
    const errorMsg = error instanceof Error ? error.message : String(error);
    this.callbacks.onError?.(issueId, error instanceof Error ? error : new Error(errorMsg));

    // Schedule retry if under max attempts
    if (attempt < this.config.maxRetryAttempts) {
      scheduleRetry(
        this.state,
        issueId,
        identifier,
        attempt + 1,
        "failure",
        errorMsg,
        this.config.maxRetryDelayMs,
        (retryIssueId) => {
          // Re-fetch issue for retry
          this.tracker
            .fetchIssueStatesByIds([retryIssueId])
            .then((states) => {
              const state = states.get(retryIssueId);
              if (state && this.config.trackerConfig.active_states.includes(state)) {
                // Find the issue in our state or re-fetch
                const entry = this.state.running.get(retryIssueId);
                if (!entry) {
                  // Re-dispatch with incremented attempt
                  this.tracker.fetchCandidates(this.config.trackerConfig).then((candidates) => {
                    const issue = candidates.find((c) => c.id === retryIssueId);
                    if (issue) {
                      this.dispatchIssue(issue, attempt + 1);
                    }
                  });
                }
              }
            })
            .catch(() => {
              // Retry failed, give up
            });
        },
        this.config.retryBaseDelayMs,
      );
    }
  }

  private killWorker(issueId: string): void {
    const entry = this.state.running.get(issueId);
    if (entry) {
      entry.abortController.abort();
      if (entry.workspacePath) {
        this.workspace.removeWorkspace(entry.workspacePath).catch(() => {});
      }
      this.state.running.delete(issueId);
    }
    cancelRetry(this.state, issueId);
  }

  private killAndRetry(
    issueId: string,
    delayType: "continuation" | "failure",
    error: string,
  ): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    const attempt = entry.attempt;
    const identifier = entry.identifier;

    this.killWorker(issueId);

    if (attempt < this.config.maxRetryAttempts) {
      scheduleRetry(
        this.state,
        issueId,
        identifier,
        attempt + 1,
        delayType,
        error,
        this.config.maxRetryDelayMs,
        (retryIssueId) => {
          this.tracker
            .fetchCandidates(this.config.trackerConfig)
            .then((candidates) => {
              const issue = candidates.find((c) => c.id === retryIssueId);
              if (issue) this.dispatchIssue(issue, attempt + 1);
            })
            .catch(() => {});
        },
        this.config.retryBaseDelayMs,
      );
    }
  }
}
