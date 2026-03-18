# Architecture

Forge uses a layered, pluggable architecture where each module has strictly defined dependency directions. Layer N may only import from layers 0 through N-1. No circular dependencies are allowed.

See [`SPEC.md`](SPEC.md) Section 3 (System Overview) for the language-agnostic design rationale.

## Layer Diagram

```
┌─────────────────────────────────────────────────────────┐
│  Layer 4: Entry                                         │
│  src/index.ts (CLI) — wires all modules together        │
├─────────────────────────────────────────────────────────┤
│  Standalone: MCP Servers                                │
│  mcp/ — per-tracker MCP servers for agent tool access   │
├─────────────────────────────────────────────────────────┤
│  Layer 3: Coordination + Presentation                   │
│  orchestrator/ — polling, dispatch, reconciliation,     │
│                  retries, state management               │
│  server/ — HTTP REST API + HTML dashboard (optional)    │
├─────────────────────────────────────────────────────────┤
│  Layer 2: Execution                                     │
│  worker/ — per-issue agent runner, prompt rendering     │
├─────────────────────────────────────────────────────────┤
│  Layer 1: Infrastructure                                │
│  workspace/ — directory lifecycle, hooks                │
│  agent/ (impls) — ClaudeCodeAdapter                     │
│  tracker/ (impls) — LinearTracker, MemoryTracker        │
├─────────────────────────────────────────────────────────┤
│  Layer 0: Foundation                                    │
│  config/ — schema, loader, resolver, watcher            │
│  observability/ — logger, TUI dashboard, snapshot types │
│  agent/types — AgentAdapter, SessionHandle interfaces   │
│  tracker/types — TrackerAdapter, NormalizedIssue ifaces │
└─────────────────────────────────────────────────────────┘
```

## Module Inventory

| Module | Layer | Responsibility | Allowed Dependencies |
|--------|-------|---------------|---------------------|
| `config/` | 0 | YAML parsing, Zod validation, env resolution | (none) |
| `observability/` | 0 | Pino logger, TUI dashboard, snapshot types | (none) |
| `agent/types.ts` | 0 | AgentAdapter, SessionHandle, AgentEvent interfaces | (none) |
| `tracker/types.ts` | 0 | TrackerAdapter, NormalizedIssue, TrackerConfig interfaces | (none) |
| `workspace/` | 1 | Directory creation, hooks, cleanup, SSH remote ops | `tracker/types` |
| `agent/` (impls) | 1 | ClaudeCodeAdapter | `agent/types` |
| `tracker/` (impls) | 1 | LinearTracker, MemoryTracker | `tracker/types` |
| `worker/` | 2 | Per-issue execution loop, prompt rendering | `agent/types`, `tracker/types`, `workspace` |
| `orchestrator/` | 3 | Polling, dispatch, reconciliation, retries | `agent/types`, `tracker/types`, `workspace`, `worker`, `observability` |
| `server/` | 3 | HTTP REST API, HTML dashboard (SPEC 13.7) | `orchestrator`, `observability` |
| `mcp/` | standalone | MCP servers for agent tool access (Linear GraphQL) | (none) |
| `index.ts` | 4 | CLI entry, wiring | all modules |

## Dependency Rules

1. **Layer direction**: A module at layer N may only import from layers 0..N-1.
2. **No circular imports**: If module A imports from B, B must not import from A.
3. **types.ts as contract**: Cross-module imports should target `types.ts`, not implementation files.
4. **Intra-module freedom**: Files within a module may import freely from siblings (e.g., `orchestrator/dispatcher.ts` → `orchestrator/types.ts`).
5. **Standalone modules**: MCP servers are self-contained entry points with no cross-module imports. They are spawned as child processes by the workspace layer.

These rules are enforced by `test/architecture/boundaries.test.ts`.

## Extension Points

### Adding a new tracker kind

1. Create `src/tracker/<kind>.ts` implementing `TrackerAdapter` from `types.ts`.
2. Add a case to the factory in `src/tracker/index.ts`.
3. Add the kind to `TrackerKindSchema` in `src/config/schema.ts`.
4. Write tests in `test/unit/tracker/<kind>.test.ts`.

### Adding a new agent kind

1. Create `src/agent/<kind>.ts` implementing `AgentAdapter` from `types.ts`.
2. Add a case to the factory in `src/agent/index.ts`.
3. Add the kind to `AgentKindSchema` in `src/config/schema.ts`.
4. Write tests in `test/unit/agent/<kind>.test.ts`.

### Adding a new MCP server

1. Create `src/mcp/<name>-server.ts` as a standalone stdio MCP server.
2. Add `mcp` to `ALLOWED_DEPS` in `test/architecture/boundaries.test.ts` (already done — `mcp: []`).
3. Wire the server path into `src/index.ts` where MCP config is built.
4. Write tests in `test/unit/mcp/<name>.test.ts`.

### Adding a new module

1. Determine its layer based on what it needs to import.
2. Create `src/<module>/types.ts` for public interfaces.
3. Create `src/<module>/index.ts` as barrel export.
4. Add the module and its allowed dependencies to the `ALLOWED_DEPS` map in `test/architecture/boundaries.test.ts`.
5. Update this file.
