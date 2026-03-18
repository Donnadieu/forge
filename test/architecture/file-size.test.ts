import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "../../src");
const MAX_LINES = 400;

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

describe("file size limits", () => {
  it(`no source file exceeds ${MAX_LINES} lines`, () => {
    const violations: string[] = [];

    for (const file of collectTsFiles(SRC)) {
      const lines = readFileSync(file, "utf-8").split("\n").length;
      if (lines > MAX_LINES) {
        violations.push(
          `${relative(SRC, file)}: ${lines} lines (max ${MAX_LINES}). ` +
            `FIX: Extract logic into a separate file within the same module.`,
        );
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
