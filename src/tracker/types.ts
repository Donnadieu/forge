export interface NormalizedIssue {
  id: string;
  identifier: string; // human-readable, e.g. "MT-123"
  title: string;
  description: string;
  state: string;
  priority: number | null; // 0 = urgent, 4 = none, null = unset
  assignee?: string;
  labels: string[];
  branchName?: string;
  url?: string;
  blockedBy: Array<{ id?: string; identifier?: string; state?: string }>;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

export interface TrackerConfig {
  kind: string;
  project_slug: string;
  active_states: string[];
  terminal_states: string[];
  api_key?: string;
  endpoint?: string;
  assignee?: string;
}

export interface TrackerAdapter {
  readonly kind: string;
  fetchCandidates(config: TrackerConfig): Promise<NormalizedIssue[]>;
  fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>>;
  fetchTerminalIssues(config: TrackerConfig): Promise<NormalizedIssue[]>;
  /** Transition an issue to a named workflow state. Optional — not all trackers support writes. */
  updateIssueState?(issueId: string, stateName: string): Promise<void>;
  /** Create a comment on an issue. Returns the comment ID. Optional. */
  createComment?(issueId: string, body: string): Promise<string>;
}
