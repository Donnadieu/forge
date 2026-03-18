import type {
  StateSnapshot,
  RunningSessionSnapshot,
  RetrySnapshot,
} from "../observability/types.js";
import type { OrchestratorState, RunningEntry, RetryEntry } from "./types.js";

function buildRunningSnapshot(entry: RunningEntry, now: number): RunningSessionSnapshot {
  const elapsedMs = now - entry.startedAt;
  const lastActivityMs = now - entry.lastActivityAt;
  return {
    issueId: entry.issueId,
    identifier: entry.identifier,
    state: entry.issue.state,
    sessionId: entry.sessionId,
    turnCount: entry.turnCount,
    lastEvent: entry.lastEvent,
    lastMessage: entry.lastMessage,
    startedAt: new Date(Date.now() - elapsedMs).toISOString(),
    lastEventAt: new Date(Date.now() - lastActivityMs).toISOString(),
    tokens: {
      input: entry.tokens.input,
      output: entry.tokens.output,
      total: entry.tokens.input + entry.tokens.output,
    },
    workspacePath: entry.workspacePath,
    attempt: entry.attempt,
    host: entry.host,
  };
}

function buildRetrySnapshot(entry: RetryEntry, now: number): RetrySnapshot {
  const dueInMs = entry.dueAtMs - now;
  return {
    issueId: entry.issueId,
    identifier: entry.identifier,
    attempt: entry.attempt,
    dueAt: new Date(Date.now() + Math.max(dueInMs, 0)).toISOString(),
    error: entry.error,
  };
}

export function buildStateSnapshot(state: OrchestratorState): StateSnapshot {
  const now = performance.now();

  const running: RunningSessionSnapshot[] = [];
  for (const entry of state.running.values()) {
    running.push(buildRunningSnapshot(entry, now));
  }

  const retrying: RetrySnapshot[] = [];
  for (const entry of state.retryAttempts.values()) {
    retrying.push(buildRetrySnapshot(entry, now));
  }

  let activeSeconds = 0;
  for (const entry of state.running.values()) {
    activeSeconds += (now - entry.startedAt) / 1000;
  }

  return {
    generatedAt: new Date().toISOString(),
    counts: { running: state.running.size, retrying: state.retryAttempts.size },
    running,
    retrying,
    codexTotals: {
      inputTokens: state.totalTokens.input,
      outputTokens: state.totalTokens.output,
      totalTokens: state.totalTokens.input + state.totalTokens.output,
      secondsRunning: state.secondsRunning + activeSeconds,
    },
    rateLimits: null,
  };
}

export function buildIssueSnapshot(
  state: OrchestratorState,
  identifier: string,
): RunningSessionSnapshot | null {
  for (const entry of state.running.values()) {
    if (entry.identifier === identifier) {
      return buildRunningSnapshot(entry, performance.now());
    }
  }
  return null;
}
