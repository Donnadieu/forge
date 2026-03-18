import matter from "gray-matter";
import { readFileSync } from "node:fs";

export interface ParsedWorkflow {
  config: Record<string, unknown>;
  promptTemplate: string;
}

export function parseWorkflowFile(filePath: string): ParsedWorkflow {
  const content = readFileSync(filePath, "utf-8");
  return parseWorkflowContent(content);
}

export function parseWorkflowContent(content: string): ParsedWorkflow {
  const { data, content: body } = matter(content);
  return {
    config: data as Record<string, unknown>,
    promptTemplate: body.trim(),
  };
}
