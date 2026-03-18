import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "../../src");

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("console usage", () => {
  it("no console.log/error/warn in library code (only CLI entry allowed)", () => {
    const violations: string[] = [];
    const consolePattern = /\bconsole\.(log|error|warn|info|debug)\b/g;

    for (const file of collectTsFiles(SRC)) {
      const rel = relative(SRC, file);
      // CLI entry (index.ts) is allowed to use console.error for fatal errors
      if (rel === "index.ts") continue;

      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        // Skip comments
        const trimmed = lines[i].trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

        if (consolePattern.test(lines[i])) {
          violations.push(
            `${rel}:${i + 1}: uses console directly. ` +
              `FIX: Use the Pino logger from observability/logger.ts instead.`,
          );
        }
        consolePattern.lastIndex = 0;
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});

describe("barrel exports", () => {
  it("index.ts files contain only exports, imports, and factory functions", () => {
    const violations: string[] = [];
    // Patterns that indicate business logic (not just re-exports or simple factories)
    const logicPatterns = [
      /\bif\s*\(/,
      /\bfor\s*\(/,
      /\bwhile\s*\(/,
      /\btry\s*\{/,
      /\bawait\b/,
      /\.then\(/,
    ];

    for (const file of collectTsFiles(SRC)) {
      const rel = relative(SRC, file);
      if (!rel.endsWith("index.ts") || rel === "index.ts") continue;

      const content = readFileSync(file, "utf-8");
      // Allow switch statements in factory functions (e.g., createAgent, createTracker)
      // but flag async operations, loops, try/catch, and promise chains
      for (const pattern of logicPatterns) {
        if (pattern.test(content)) {
          violations.push(
            `${rel}: contains business logic (matched ${pattern}). ` +
              `FIX: Move logic to a dedicated file and keep index.ts as a barrel export.`,
          );
          break;
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
