# Forge

Model-agnostic agent orchestration platform. Turns issue trackers into autonomous code factories.

Built on the architecture of [OpenAI Symphony](https://github.com/openai/symphony) (Apache 2.0), extended to support multiple AI coding agents and multiple issue trackers through a clean adapter pattern.

## Getting Started

### Prerequisites

- Node.js >= 20
- pnpm
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [GitHub CLI](https://cli.github.com/) installed and authenticated (for push/land skills)

### Install

```bash
pnpm install
pnpm build
```

### Configure

1. Copy the example workflow and customize it:
   ```bash
   cp examples/WORKFLOW.md ./WORKFLOW.md
   ```

2. Edit `WORKFLOW.md` — set your `project_slug`, repo clone URL in hooks, and adjust agent settings.

3. Set your Linear API key:
   ```bash
   export LINEAR_API_KEY="lin_api_..."
   ```

### Run

```bash
# Validate config (parse + schema check, no tracker credentials needed)
forge validate

# Preview what would be dispatched (requires tracker credentials)
forge --dry-run

# Start the orchestrator
forge
```

## Architecture

Forge uses a layered, pluggable architecture with strict dependency boundaries enforced by tests.

- **Config** — Parses `WORKFLOW.md` (YAML front matter + Liquid template body), validates with Zod, resolves environment variables, watches for hot-reload.
- **Tracker** — Polls issue trackers for candidate tickets. Linear adapter included; GitHub Issues and Jira planned.
- **Orchestrator** — Tick loop that reconciles running workers, fetches candidates, checks eligibility (priority, blockers, concurrency limits), dispatches workers, and manages retries with exponential backoff.
- **Worker** — Per-issue multi-turn agent runner. Renders prompt template, spawns agent sessions, streams events, checks tracker state between turns.
- **Workspace** — Creates isolated per-issue directories, runs lifecycle hooks (`after_create`, `before_run`, `after_run`), copies skills, writes MCP config.
- **Agent** — Spawns AI coding agents. Claude Code CLI adapter included; Codex and custom adapters planned.
- **MCP** — Standalone MCP servers that give agents tool access (e.g., Linear GraphQL queries/mutations).
- **Observability** — Pino structured logging with dual transport (console + file), in-memory metrics for tokens, durations, retries.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full layer diagram, dependency rules, and extension points.

## Configuration

WORKFLOW.md uses YAML front matter for configuration and a Liquid template body for the agent prompt. Key sections:

| Section | Purpose |
|---------|---------|
| `tracker` | Issue tracker kind, project slug, active/terminal states |
| `workspace` | Root directory, lifecycle hooks, skills directory |
| `agent` | Agent kind, concurrency limits, turn limits, polling interval |
| `retry` | Max attempts, backoff delays |

See [examples/WORKFLOW.md](examples/WORKFLOW.md) for a complete working example.

## Extending Forge

### New tracker adapter

Implement the `TrackerAdapter` interface and register in the factory. See [ARCHITECTURE.md](ARCHITECTURE.md#adding-a-new-tracker-kind).

### New agent adapter

Implement the `AgentAdapter` interface and register in the factory. See [ARCHITECTURE.md](ARCHITECTURE.md#adding-a-new-agent-kind).

### New MCP server

Create a standalone stdio MCP server in `src/mcp/`. See [ARCHITECTURE.md](ARCHITECTURE.md#adding-a-new-mcp-server).

## Status

Phase 1 — Core complete. Not yet production-hardened.

## Links

- [SPEC.md](SPEC.md) — Full language-agnostic specification
- [ARCHITECTURE.md](ARCHITECTURE.md) — Layer diagram and dependency rules
- [CONTRIBUTING.md](CONTRIBUTING.md) — Development guide

## License

Apache 2.0
