import type { NormalizedIssue, TrackerAdapter, TrackerConfig } from "./types.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger({ level: "warn", pretty: false });

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

// Raw Linear GraphQL response types
interface RawLinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  branchName: string | null;
  url: string | null;
  state: { name: string } | null;
  assignee: { id: string; displayName: string } | null;
  labels: { nodes: Array<{ name: string }> } | null;
  createdAt: string | null;
  updatedAt: string | null;
  inverseRelations: {
    nodes: Array<{
      type: string;
      issue: {
        id: string;
        identifier: string;
        state: { name: string } | null;
      };
    }>;
  } | null;
}

export class LinearTracker implements TrackerAdapter {
  readonly kind = "linear";
  private endpoint: string;
  private apiKey: string;

  constructor(endpoint?: string, apiKey?: string) {
    this.endpoint = endpoint || "https://api.linear.app/graphql";
    this.apiKey = apiKey || "";
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (!this.apiKey) {
      throw new Error("Linear API key is required");
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as GraphQLResponse<T>;
    if (json.errors?.length) {
      throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join(", ")}`);
    }
    if (!json.data) {
      throw new Error("Linear API returned no data");
    }
    return json.data;
  }

  async fetchCandidates(config: TrackerConfig): Promise<NormalizedIssue[]> {
    if (!config.project_slug) {
      throw new Error("Linear project slug is required");
    }

    try {
      const allIssues: NormalizedIssue[] = [];
      let cursor: string | null = null;
      let hasMore = true;

      while (hasMore) {
        const variables: Record<string, unknown> = {
          slug: config.project_slug,
          states: config.active_states,
          first: 50,
        };
        if (cursor) variables.after = cursor;

        // PITFALL #3: Use project: { slugId: { eq: $slug } } for project filtering
        const query = `
          query FetchCandidates($slug: String!, $states: [String!]!, $first: Int!, $after: String) {
            issues(
              filter: {
                project: { slugId: { eq: $slug } }
                state: { name: { in: $states } }
              }
              first: $first
              after: $after
            ) {
              nodes {
                id
                identifier
                title
                description
                priority
                branchName
                url
                state { name }
                assignee { id displayName }
                labels { nodes { name } }
                createdAt
                updatedAt
                inverseRelations {
                  nodes {
                    type
                    issue {
                      id
                      identifier
                      state { name }
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `;

        const data = await this.graphql<{
          issues: {
            nodes: RawLinearIssue[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        }>(query, variables);

        for (const node of data.issues.nodes) {
          allIssues.push(this.normalizeIssue(node));
        }

        hasMore = data.issues.pageInfo.hasNextPage;
        cursor = data.issues.pageInfo.endCursor;
      }

      // Apply assignee filter if configured
      if (config.assignee) {
        return allIssues.filter((i) => i.assignee === config.assignee);
      }

      return allIssues;
    } catch (error) {
      log.warn({ err: error }, "Linear fetchCandidates failed");
      return [];
    }
  }

  // PITFALL #1: Use issues(filter: { id: { in: $ids } }), NOT nodes(ids: [...])
  async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();

    try {
      const query = `
        query FetchIssueStates($ids: [ID!]!, $first: Int!) {
          issues(filter: { id: { in: $ids } }, first: $first) {
            nodes {
              id
              state { name }
            }
          }
        }
      `;

      const data = await this.graphql<{
        issues: { nodes: Array<{ id: string; state: { name: string } }> };
      }>(query, { ids, first: ids.length });

      const result = new Map<string, string>();
      for (const node of data.issues.nodes) {
        result.set(node.id, node.state.name);
      }
      return result;
    } catch (error) {
      log.warn({ err: error }, "Linear fetchIssueStatesByIds failed");
      return new Map();
    }
  }

  async fetchTerminalIssues(config: TrackerConfig): Promise<NormalizedIssue[]> {
    if (!config.project_slug) {
      throw new Error("Linear project slug is required");
    }

    try {
      const query = `
        query FetchTerminalIssues($slug: String!, $states: [String!]!, $first: Int!) {
          issues(
            filter: {
              project: { slugId: { eq: $slug } }
              state: { name: { in: $states } }
            }
            first: $first
          ) {
            nodes {
              id
              identifier
              title
              description
              priority
              branchName
              url
              state { name }
              assignee { id displayName }
              labels { nodes { name } }
              createdAt
              updatedAt
              inverseRelations {
                nodes {
                  type
                  issue {
                    id
                    identifier
                    state { name }
                  }
                }
              }
            }
          }
        }
      `;

      const data = await this.graphql<{
        issues: { nodes: RawLinearIssue[] };
      }>(query, {
        slug: config.project_slug,
        states: config.terminal_states,
        first: 50,
      });

      return data.issues.nodes.map((n) => this.normalizeIssue(n));
    } catch (error) {
      log.warn({ err: error }, "Linear fetchTerminalIssues failed");
      return [];
    }
  }

  // PITFALL #2: Filter inverseRelations client-side by type, NOT via API arg
  private normalizeIssue(raw: RawLinearIssue): NormalizedIssue {
    const blockedBy = (raw.inverseRelations?.nodes || [])
      .filter((r) => r.type === "blocks")
      .map((r) => ({
        id: r.issue.id,
        identifier: r.issue.identifier,
        state: r.issue.state?.name || "",
      }));

    return {
      id: raw.id,
      identifier: raw.identifier,
      title: raw.title,
      description: raw.description || "",
      state: raw.state?.name || "",
      priority: raw.priority ?? null,
      assignee: raw.assignee?.id,
      labels: (raw.labels?.nodes || []).map((l) => l.name.toLowerCase()),
      branchName: raw.branchName || undefined,
      url: raw.url || undefined,
      blockedBy,
      createdAt: raw.createdAt || "",
      updatedAt: raw.updatedAt || "",
    };
  }
}
