# Forge

Model-agnostic agent orchestration platform. Turns issue trackers into autonomous code factories.

Built on the architecture of [OpenAI Symphony](https://github.com/openai/symphony) (Apache 2.0), extended to support multiple AI coding agents and multiple issue trackers through a clean adapter pattern.

## Status

Phase 0 — Foundation. Not production-ready.

## Stack

- TypeScript / Node.js
- Vitest for testing
- Zod for schema validation
- Pino for structured logging
- Commander.js for CLI

## Architecture

Forge polls an issue tracker, claims eligible tickets, creates isolated per-issue workspaces, dispatches an AI coding agent to implement the work, manages multi-turn sessions with retry logic, and requires proof-of-work (CI pass, PR created) before code lands.

The agent and tracker are pluggable via adapter interfaces:

- **Agent Adapters**: Claude Code CLI (primary), Codex app-server (planned), custom SDK (extensible)
- **Tracker Adapters**: Linear (primary), GitHub Issues (planned), Jira (planned)

## License

Apache 2.0
