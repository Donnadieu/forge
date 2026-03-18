import { Liquid } from "liquidjs";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
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
  skills_manifest?: string;
}

export function renderPrompt(template: string, context: PromptContext): string {
  return engine.parseAndRenderSync(template, context);
}

export function buildPromptContext(
  issue: NormalizedIssue,
  attempt?: number,
  skillsManifest?: string,
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
    skills_manifest: skillsManifest,
  };
}

/**
 * Load a skills manifest from a directory of skill markdown files.
 * Returns a compact index listing each skill's name and description.
 */
export function loadSkillsManifest(skillsDir: string): string | undefined {
  if (!existsSync(skillsDir)) return undefined;

  const files = readdirSync(skillsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (files.length === 0) return undefined;

  const entries: string[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(skillsDir, file), "utf-8");
      const { data } = matter(content);
      const name = (data.name as string) || file.replace(/\.md$/, "");
      const desc = (data.description as string) || "";
      entries.push(`- ${name}: ${desc}`);
    } catch {
      // Skip files that can't be parsed
    }
  }

  if (entries.length === 0) return undefined;

  return [
    "Available workflow skills (read .forge/skills/<name>.md for full instructions):",
    ...entries,
  ].join("\n");
}
