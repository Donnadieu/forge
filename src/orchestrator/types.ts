import type { NormalizedIssue } from "../tracker/types.js";

export interface RunningEntry {
  issueId: string;
  identifier: string;
  issue: NormalizedIssue;
  startedAt: number; // performance.now() monotonic
  lastActivityAt: number; // performance.now() monotonic
  tokens: { input: number; output: number };
  workspacePath: string | null;
  attempt: number;
  abortController: AbortController;
  workerPromise: Promise<void>;
  sessionId: string | null;
  turnCount: number;
  lastEvent: string;
  lastMessage: string;
  host: string | null;
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number; // performance.now() monotonic
  delayType: "continuation" | "failure";
  error: string | null;
  timerId: ReturnType<typeof setTimeout>;
}

export interface OrchestratorState {
  running: Map<string, RunningEntry>;
  completed: Set<string>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  totalTokens: { input: number; output: number };
  tickTimerId: ReturnType<typeof setTimeout> | null;
  secondsRunning: number;
}

export function createInitialState(): OrchestratorState {
  return {
    running: new Map(),
    completed: new Set(),
    claimed: new Set(),
    retryAttempts: new Map(),
    totalTokens: { input: 0, output: 0 },
    tickTimerId: null,
    secondsRunning: 0,
  };
}
