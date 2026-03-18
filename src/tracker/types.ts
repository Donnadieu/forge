export interface NormalizedIssue {
  id: string;
  identifier: string; // human-readable, e.g. "MT-123"
  title: string;
  description: string;
  state: string;
  priority: number; // 0 = urgent, 4 = none
  assignee?: string;
  labels: string[];
  blockers: NormalizedIssue[];
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
}
