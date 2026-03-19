/**
 * Snapshot types consumed by the TUI dashboard and HTTP server.
 * Layer 0 — no cross-module imports.
 */

export interface RunningSessionSnapshot {
  issueId: string;
  identifier: string;
  state: string;
  sessionId: string | null;
  turnCount: number;
  lastEvent: string;
  lastMessage: string;
  startedAt: string;
  lastEventAt: string;
  tokens: { input: number; output: number; total: number };
  workspacePath: string | null;
  attempt: number;
  host: string | null;
}

export interface RetrySnapshot {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAt: string;
  error: string | null;
}

export interface StateSnapshot {
  generatedAt: string;
  counts: { running: number; retrying: number };
  running: RunningSessionSnapshot[];
  retrying: RetrySnapshot[];
  codexTotals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    secondsRunning: number;
  };
  rateLimits: unknown;
}
