import type { NormalizedIssue } from "../tracker/types.js";
import type { OrchestratorState } from "./types.js";

/**
 * Sort issues for dispatch: priority ASC (0=urgent first), then createdAt ASC (oldest first).
 */
export function sortIssuesForDispatch(issues: NormalizedIssue[]): NormalizedIssue[] {
  return [...issues].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * Check if an issue should be dispatched.
 */
export function shouldDispatchIssue(
  issue: NormalizedIssue,
  state: OrchestratorState,
  config: {
    active_states: string[];
    terminal_states: string[];
    max_concurrent_agents: number;
  },
): boolean {
  // Already running
  if (state.running.has(issue.id)) return false;

  // Already claimed (being prepared)
  if (state.claimed.has(issue.id)) return false;

  // Already completed
  if (state.completed.has(issue.id)) return false;

  // Pending retry
  if (state.retryAttempts.has(issue.id)) return false;

  // Not in active state
  if (!config.active_states.includes(issue.state)) return false;

  // Check if blocked by active issues
  if (hasActiveBlockers(issue, config.active_states)) return false;

  // Check concurrency limit
  if (state.running.size >= config.max_concurrent_agents) return false;

  return true;
}

/**
 * Check if any blocker is still in an active (non-terminal) state.
 */
function hasActiveBlockers(issue: NormalizedIssue, activeStates: string[]): boolean {
  return issue.blockers.some((b) => activeStates.includes(b.state));
}

/**
 * Select issues to dispatch from candidates.
 */
export function selectIssuesToDispatch(
  candidates: NormalizedIssue[],
  state: OrchestratorState,
  config: {
    active_states: string[];
    terminal_states: string[];
    max_concurrent_agents: number;
  },
): NormalizedIssue[] {
  const sorted = sortIssuesForDispatch(candidates);
  const selected: NormalizedIssue[] = [];

  for (const issue of sorted) {
    if (state.running.size + selected.length >= config.max_concurrent_agents) break;
    if (shouldDispatchIssue(issue, state, config)) {
      selected.push(issue);
    }
  }

  return selected;
}
