import { statSync } from "node:fs";
import { parseWorkflowFile } from "./loader.js";
import { resolveConfig } from "./resolver.js";
import type { WorkflowConfig } from "./schema.js";

interface FileStamp {
  mtimeMs: number;
  size: number;
}

export class WorkflowStore {
  private filePath: string;
  private cachedConfig: WorkflowConfig | null = null;
  private cachedPromptTemplate: string = "";
  private lastStamp: FileStamp | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  current(): { config: WorkflowConfig; promptTemplate: string } {
    const stamp = this.getStamp();
    if (
      this.cachedConfig &&
      this.lastStamp &&
      stamp.mtimeMs === this.lastStamp.mtimeMs &&
      stamp.size === this.lastStamp.size
    ) {
      return {
        config: this.cachedConfig,
        promptTemplate: this.cachedPromptTemplate,
      };
    }
    return this.forceReload();
  }

  forceReload(): { config: WorkflowConfig; promptTemplate: string } {
    const parsed = parseWorkflowFile(this.filePath);
    this.cachedConfig = resolveConfig(parsed.config);
    this.cachedPromptTemplate = parsed.promptTemplate;
    this.lastStamp = this.getStamp();
    return {
      config: this.cachedConfig,
      promptTemplate: this.cachedPromptTemplate,
    };
  }

  private getStamp(): FileStamp {
    const stat = statSync(this.filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  }
}
