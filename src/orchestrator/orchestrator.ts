import type { AgentAdapter } from "../agent/types.js";
import type { TrackerAdapter, TrackerConfig, NormalizedIssue } from "../tracker/types.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { StateSnapshot, RunningSessionSnapshot } from "../observability/types.js";
import { runWorker, type WorkerConfig, type WorkerResult } from "../worker/runner.js";
import { type OrchestratorState, type RunningEntry, createInitialState } from "./types.js";
import { selectIssuesToDispatch } from "./dispatcher.js";
import { reconcileRunningIssues } from "./reconciler.js";
import { scheduleRetry, cancelRetry, cancelAllRetries } from "./retry-queue.js";
import { buildStateSnapshot, buildIssueSnapshot } from "./snapshot.js";

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
  onEvent?: (issueId: string, event: import("../agent/types.js").AgentEvent) => void;
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
  private tickRunning = false;
  private pollRequested = false;

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

  start(): void {
    this.stopped = false;
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.state.tickTimerId) {
      clearTimeout(this.state.tickTimerId);
      this.state.tickTimerId = null;
    }
    cancelAllRetries(this.state);
    for (const [, entry] of this.state.running) entry.abortController.abort();
    const promises = Array.from(this.state.running.values()).map((e) =>
      e.workerPromise.catch(() => {}),
    );
    await Promise.allSettled(promises);
    this.state.running.clear();
  }

  getState(): Readonly<OrchestratorState> {
    return this.state;
  }

  getSnapshot(): StateSnapshot {
    return buildStateSnapshot(this.state);
  }

  getIssueSnapshot(identifier: string): RunningSessionSnapshot | null {
    return buildIssueSnapshot(this.state, identifier);
  }

  triggerPoll(): void {
    if (this.stopped) return;
    if (this.tickRunning) {
      this.pollRequested = true;
      return;
    }
    if (this.state.tickTimerId) {
      clearTimeout(this.state.tickTimerId);
      this.state.tickTimerId = null;
    }
    this.scheduleTick(0);
  }

  updateConfig(config: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    this.state.tickTimerId = setTimeout(() => this.onTick(), delayMs);
  }

  private async onTick(): Promise<void> {
    if (this.stopped) return;
    this.tickRunning = true;
    this.pollRequested = false;

    try {
      await this.pollCycle();
    } catch (error) {
      // Report error but don't crash the loop
      const err = error instanceof Error ? error : new Error(String(error));
      this.callbacks.onPollError?.(err);
    }

    this.tickRunning = false;

    // If a poll was requested while we were running, do it immediately
    if (this.pollRequested) {
      this.pollRequested = false;
      this.scheduleTick(0);
    } else {
      this.scheduleTick(this.config.pollIntervalMs);
    }
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
      if (
        currentState !== undefined &&
        !this.config.trackerConfig.active_states.includes(currentState)
      ) {
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
      signal: abortController.signal,
      onEvent: (issueId, event) => {
        const entry = this.state.running.get(issueId);
        if (entry) {
          entry.lastActivityAt = performance.now();
          entry.lastEvent = event.type;
          if (event.type === "usage") {
            entry.tokens.input += event.inputTokens;
            entry.tokens.output += event.outputTokens;
            this.state.totalTokens.input += event.inputTokens;
            this.state.totalTokens.output += event.outputTokens;
          } else if (event.type === "text") {
            entry.lastMessage = event.content.slice(0, 200);
          } else if (event.type === "tool_use") {
            entry.lastMessage = event.tool;
          }
        }
        this.callbacks.onEvent?.(issueId, event);
      },
      onTurnStart: (issueId, turn) => {
        const entry = this.state.running.get(issueId);
        if (entry) {
          entry.turnCount = turn;
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
      sessionId: null,
      turnCount: 0,
      lastEvent: "",
      lastMessage: "",
      host: null,
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
    if (entry) {
      this.state.secondsRunning += (performance.now() - entry.startedAt) / 1000;
    }
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
              (_retryId) => {
                this.dispatchIssue(issue, attempt + 1).catch((err) => {
                  const e = err instanceof Error ? err : new Error(String(err));
                  this.callbacks.onError?.(issueId, e);
                });
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
    const errorEntry = this.state.running.get(issueId);
    if (errorEntry) {
      this.state.secondsRunning += (performance.now() - errorEntry.startedAt) / 1000;
    }
    this.state.running.delete(issueId);
    const errorMsg = error instanceof Error ? error.message : String(error);
    this.callbacks.onError?.(issueId, error instanceof Error ? error : new Error(errorMsg));

    if (attempt < this.config.maxRetryAttempts) {
      scheduleRetry(
        this.state,
        issueId,
        identifier,
        attempt + 1,
        "failure",
        errorMsg,
        this.config.maxRetryDelayMs,
        (retryIssueId) => this.refetchAndDispatch(retryIssueId, attempt + 1, true),
        this.config.retryBaseDelayMs,
      );
    }
  }

  private killWorker(issueId: string): void {
    const entry = this.state.running.get(issueId);
    if (entry) {
      this.state.secondsRunning += (performance.now() - entry.startedAt) / 1000;
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
    const { attempt, identifier } = entry;
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
        (retryIssueId) => this.refetchAndDispatch(retryIssueId, attempt + 1, false),
        this.config.retryBaseDelayMs,
      );
    }
  }

  /** Re-fetch an issue from the tracker and dispatch it for retry. */
  private refetchAndDispatch(issueId: string, attempt: number, checkState: boolean): void {
    const go = async () => {
      if (checkState) {
        const states = await this.tracker.fetchIssueStatesByIds([issueId]);
        const state = states.get(issueId);
        if (!state || !this.config.trackerConfig.active_states.includes(state)) return;
        if (this.state.running.has(issueId)) return;
      }
      const candidates = await this.tracker.fetchCandidates(this.config.trackerConfig);
      const issue = candidates.find((c) => c.id === issueId);
      if (issue) await this.dispatchIssue(issue, attempt);
    };
    go().catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      this.callbacks.onError?.(issueId, e);
    });
  }
}
