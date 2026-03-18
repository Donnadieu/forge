import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "../../src");

/**
 * Allowed cross-module dependencies, matching ARCHITECTURE.md layers.
 *
 * Layer 0 (Foundation): config, observability, agent (types only), tracker (types only)
 * Layer 1 (Infrastructure): workspace, agent (impls), tracker (impls)
 * Layer 2 (Execution): worker
 * Layer 3 (Coordination): orchestrator
 * Layer 4 (Entry): index.ts
 */
const ALLOWED_DEPS: Record<string, string[]> = {
  config: [],
  observability: [],
  agent: [], // agent/types is leaf; impls import only agent/types (intra-module)
  tracker: [], // tracker/types is leaf; impls import only tracker/types (intra-module)
  workspace: ["tracker"],
  worker: ["agent", "tracker", "workspace"],
  orchestrator: ["agent", "tracker", "workspace", "worker"],
  mcp: [], // standalone MCP server, no cross-module deps
};

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

function getModule(filePath: string): string | null {
  const rel = relative(SRC, filePath);
  const parts = rel.split("/");
  // Top-level files like index.ts are the CLI entry — skip them
  if (parts.length === 1) return null;
  return parts[0];
}

function extractCrossModuleImports(content: string, sourceModule: string): string[] {
  const importRegex = /from\s+["']\.\.\/([^/"']+)\//g;
  const imports: string[] = [];
  for (const match of content.matchAll(importRegex)) {
    const target = match[1];
    if (target !== sourceModule) {
      imports.push(target);
    }
  }
  return [...new Set(imports)];
}

describe("module dependency boundaries", () => {
  const files = collectTsFiles(SRC);

  it("all cross-module imports respect the allowed dependency map", () => {
    const violations: string[] = [];

    for (const file of files) {
      const mod = getModule(file);
      if (mod === null) continue; // skip top-level entry files

      const allowed = ALLOWED_DEPS[mod];
      if (allowed === undefined) {
        violations.push(
          `UNKNOWN MODULE: ${relative(SRC, file)} belongs to module "${mod}" which is not in ALLOWED_DEPS. ` +
            `FIX: Add "${mod}" to the ALLOWED_DEPS map in this test and update ARCHITECTURE.md.`,
        );
        continue;
      }

      const content = readFileSync(file, "utf-8");
      const imports = extractCrossModuleImports(content, mod);

      for (const dep of imports) {
        if (!allowed.includes(dep)) {
          violations.push(
            `VIOLATION: ${relative(SRC, file)} imports from "${dep}" but ${mod} only allows: [${allowed.join(", ")}]. ` +
              `FIX: Move the shared type to a common module, or restructure to respect layer boundaries in ARCHITECTURE.md.`,
          );
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("no circular dependencies exist between modules", () => {
    const depGraph = new Map<string, Set<string>>();

    for (const file of files) {
      const mod = getModule(file);
      if (mod === null) continue;

      const content = readFileSync(file, "utf-8");
      const imports = extractCrossModuleImports(content, mod);

      if (!depGraph.has(mod)) depGraph.set(mod, new Set());
      for (const dep of imports) {
        depGraph.get(mod)?.add(dep);
      }
    }

    const cycles: string[] = [];
    for (const [mod, deps] of depGraph) {
      for (const dep of deps) {
        const reverseDeps = depGraph.get(dep);
        if (reverseDeps?.has(mod)) {
          cycles.push(
            `CYCLE: ${mod} ↔ ${dep}. FIX: Break the cycle by extracting shared types into a common module.`,
          );
        }
      }
    }

    expect(cycles, cycles.join("\n")).toEqual([]);
  });
});
