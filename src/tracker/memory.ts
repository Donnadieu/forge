import type { NormalizedIssue, TrackerAdapter, TrackerConfig } from "./types.js";

export class MemoryTracker implements TrackerAdapter {
  readonly kind = "memory";
  private issues: NormalizedIssue[] = [];
  private comments = new Map<string, Array<{ id: string; body: string }>>();
  private commentCounter = 0;

  constructor(issues?: NormalizedIssue[]) {
    if (issues) this.issues = [...issues];
  }

  addIssue(issue: NormalizedIssue): void {
    this.issues.push(issue);
  }

  async updateIssueState(id: string, state: string): Promise<void> {
    const issue = this.issues.find((i) => i.id === id);
    if (issue) issue.state = state;
  }

  async createComment(issueId: string, body: string): Promise<string> {
    const commentId = `comment-${++this.commentCounter}`;
    const existing = this.comments.get(issueId) ?? [];
    existing.push({ id: commentId, body });
    this.comments.set(issueId, existing);
    return commentId;
  }

  getComments(issueId: string): Array<{ id: string; body: string }> {
    return this.comments.get(issueId) ?? [];
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
