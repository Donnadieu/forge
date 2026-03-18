import { Liquid } from "liquidjs";
import type { NormalizedIssue } from "../tracker/types.js";

const engine = new Liquid({ strictVariables: false, strictFilters: false });

export interface PromptContext {
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string;
    state: string;
    priority: number;
    labels: string[];
    assignee?: string;
    blockers: Array<{ id: string; identifier: string; state: string }>;
  };
  attempt?: number;
}

export function renderPrompt(template: string, context: PromptContext): string {
  return engine.parseAndRenderSync(template, context);
}

export function buildPromptContext(
  issue: NormalizedIssue,
  attempt?: number,
): PromptContext {
  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      state: issue.state,
      priority: issue.priority,
      labels: issue.labels,
      assignee: issue.assignee,
      blockers: issue.blockers.map((b) => ({
        id: b.id,
        identifier: b.identifier,
        state: b.state,
      })),
    },
    attempt,
  };
}
