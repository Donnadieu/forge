import type { NormalizedIssue, TrackerAdapter, TrackerConfig } from "./types.js";

export class MemoryTracker implements TrackerAdapter {
  readonly kind = "memory";
  private issues: NormalizedIssue[] = [];

  constructor(issues?: NormalizedIssue[]) {
    if (issues) this.issues = [...issues];
  }

  addIssue(issue: NormalizedIssue): void {
    this.issues.push(issue);
  }

  updateIssueState(id: string, state: string): void {
    const issue = this.issues.find((i) => i.id === id);
    if (issue) issue.state = state;
  }

  getIssue(id: string): NormalizedIssue | undefined {
    return this.issues.find((i) => i.id === id);
  }

  async fetchCandidates(config: TrackerConfig): Promise<NormalizedIssue[]> {
    return this.issues.filter((i) => config.active_states.includes(i.state));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const id of ids) {
      const issue = this.issues.find((i) => i.id === id);
      if (issue) result.set(id, issue.state);
    }
    return result;
  }

  async fetchTerminalIssues(config: TrackerConfig): Promise<NormalizedIssue[]> {
    return this.issues.filter((i) => config.terminal_states.includes(i.state));
  }
}
