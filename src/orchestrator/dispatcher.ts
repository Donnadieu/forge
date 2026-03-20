import type { NormalizedIssue } from "../tracker/types.js";
import type { OrchestratorState } from "./types.js";

/**
 * Sort issues for dispatch: priority ASC (0=urgent first), then createdAt ASC (oldest first).
 */
export function sortIssuesForDispatch(issues: NormalizedIssue[]): NormalizedIssue[] {
  return [...issues].sort((a, b) => {
    const aPri = a.priority ?? Infinity;
    const bPri = b.priority ?? Infinity;
    if (aPri !== bPri) return aPri - bPri;
    const dateComp = a.createdAt.localeCompare(b.createdAt);
    if (dateComp !== 0) return dateComp;
    return a.identifier.localeCompare(b.identifier);
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
    max_concurrent_agents_by_state?: Record<string, number>;
  },
): boolean {
  // Already running
  if (state.running.has(issue.id)) return false;

  // Already claimed (being prepared)
  if (state.claimed.has(issue.id)) return false;

  // Pending retry
  if (state.retryAttempts.has(issue.id)) return false;

  // Not in active state
  if (!config.active_states.includes(issue.state)) return false;

  // Check if blocked by non-terminal issues (only for Todo issues, per Symphony)
  if (hasNonTerminalBlockers(issue, config.terminal_states, issue.state)) return false;

  // Check concurrency limit
  if (state.running.size >= config.max_concurrent_agents) return false;

  // Check per-state concurrency limit
  const perStateLimit = config.max_concurrent_agents_by_state?.[issue.state];
  if (perStateLimit !== undefined) {
    let countInState = 0;
    for (const [, entry] of state.running) {
      if (entry.issue.state === issue.state) countInState++;
    }
    if (countInState >= perStateLimit) return false;
  }

  return true;
}

/**
 * Check if any blocker is still in a non-terminal state.
 */
function hasNonTerminalBlockers(
  issue: NormalizedIssue,
  terminalStates: string[],
  issueState: string,
): boolean {
  // Symphony only blocks Todo issues; non-Todo issues with blockers are allowed to proceed
  if (issueState.trim().toLowerCase() !== "todo") return false;
  return issue.blockedBy.some(
    (b) => b.state != null && b.state !== "" && !terminalStates.includes(b.state),
  );
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
    max_concurrent_agents_by_state?: Record<string, number>;
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
