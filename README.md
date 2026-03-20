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

# Start the orchestrator (--accept-risk acknowledges unguarded agent execution)
forge --accept-risk
```

## Commands

### `forge [workflow] [options]`

Start the orchestrator. Polls the issue tracker, dispatches agents for eligible issues, and manages their lifecycle.

```bash
forge                          # Uses ./WORKFLOW.md
forge path/to/WORKFLOW.md      # Explicit workflow path
```

| Flag | Description |
|------|-------------|
| `--accept-risk` | Required. Acknowledges unguarded agent execution |
| `--dry-run` | Preview candidates without spawning agents |
| `--port <number>` | HTTP server port (overrides config) |
| `--logs-root <path>` | Directory for log files (overrides config) |
| `--log-level <level>` | `debug`, `info`, `warn`, or `error` (default: `info`) |
| `--version` | Show version |

### `forge validate [workflow]`

Parse and validate a WORKFLOW.md file without connecting to any tracker. Exits 0 if valid, 1 if not.

```bash
forge validate
forge validate path/to/WORKFLOW.md
```

## Features

### Multi-turn agent workers
Each issue gets its own agent session. Forge renders a Liquid prompt template with issue context, spawns the agent, streams events, and checks tracker state between turns. Configurable turn limits, timeouts, and stall detection.

### Concurrency and retry management
Global and per-state concurrency limits prevent overloading. Failed issues enter a retry queue with exponential backoff (configurable max attempts and delays).

### Workspace isolation
Every issue gets its own workspace directory (local or remote via SSH). Lifecycle hooks run at each stage:
- `after_create` — clone repo, install dependencies
- `before_run` — fetch latest, checkout branch
- `after_run` — cleanup after agent finishes

### Skills system
Reusable Markdown skill files are copied into each workspace. Built-in skills: `commit`, `push`, `pull`, `land`, `linear`, `debug`.

### MCP servers
Agents get tool access through Model Context Protocol servers. The Linear tracker automatically provides a `forge-linear` MCP server for GraphQL queries and mutations.

### TUI dashboard
Real-time terminal dashboard showing running sessions, retry queue, token usage, and timing. Enabled by default; logs redirect to file to avoid conflicts.

### HTTP API and web dashboard
Optional HTTP server with REST endpoints and a browser-viewable dashboard:
- `GET /api/v1/state` — full orchestrator snapshot
- `GET /api/v1/{id}` — single issue snapshot
- `POST /api/v1/refresh` — trigger immediate poll

### Hot-reload configuration
WORKFLOW.md is watched for changes and reloaded automatically.

### Structured logging
Pino-based logging with JSON file output and optional pretty-printed console output. Contextual fields include issue IDs, session IDs, and token counts.

### Graceful shutdown
Handles `SIGINT`/`SIGTERM` — stops the dashboard, closes the HTTP server, and drains running workers.

## Configuration

WORKFLOW.md uses YAML front matter for configuration and a Liquid template body for the agent prompt. Key sections:

| Section | Purpose |
|---------|---------|
| `tracker` | Issue tracker kind, project slug, active/terminal states |
| `workspace` | Root directory, lifecycle hooks, skills directory, `ssh_config_path` for remote workers |
| `agent` | Agent kind, concurrency limits, turn limits, timeouts, approval policy |
| `polling` | Poll interval (default: 30s) |
| `retry` | Max attempts, backoff delays |
| `server` | HTTP API server: `port`, `host` (default: `127.0.0.1`) |
| `observability` | TUI dashboard: `dashboard_enabled`, `refresh_ms` |

### Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `LINEAR_API_KEY` | When tracker is `linear` | Linear API authentication |

Hooks can reference any env var via `$VAR` or `${VAR}`. Forge injects `WORKSPACE_PATH`, `ISSUE_ID`, `ISSUE_IDENTIFIER`, `ISSUE_TITLE`, `ISSUE_STATE`, and `ISSUE_BRANCH` automatically.

See [examples/WORKFLOW.md](examples/WORKFLOW.md) for a complete working example.

## Architecture

Forge uses a layered, pluggable architecture with strict dependency boundaries enforced by tests.

- **Config** — Parses `WORKFLOW.md` (YAML front matter + Liquid template body), validates with Zod, resolves environment variables, watches for hot-reload.
- **Tracker** — Polls issue trackers for candidate tickets. Linear adapter included; GitHub Issues and Jira planned.
- **Orchestrator** — Tick loop that reconciles running workers, fetches candidates, checks eligibility (priority, blockers, concurrency limits), dispatches workers, and manages retries with exponential backoff.
- **Worker** — Per-issue multi-turn agent runner. Renders prompt template, spawns agent sessions, streams events, checks tracker state between turns.
- **Workspace** — Creates isolated per-issue directories (local or remote via SSH), runs lifecycle hooks (`after_create`, `before_run`, `after_run`), copies skills, writes MCP config.
- **Agent** — Spawns AI coding agents. Claude Code CLI adapter included (local or SSH); Codex and custom adapters planned.
- **MCP** — Standalone MCP servers that give agents tool access (e.g., Linear GraphQL queries/mutations).
- **Observability** — Pino structured logging with dual transport (console + file), in-memory metrics for tokens, durations, retries. Optional TUI dashboard for real-time session monitoring.
- **Server** — Optional HTTP API with an HTML dashboard for browser-based monitoring.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full layer diagram, dependency rules, and extension points.

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
