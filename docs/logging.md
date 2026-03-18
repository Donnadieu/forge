# Logging Conventions

Structured logging conventions for Forge, using Pino.

## Goals

- Make logs searchable by issue and session.
- Capture enough execution context to identify root cause without reruns.
- Keep messages stable so dashboards and alerts are reliable.

## Required Context Fields

When logging issue-related work, include both identifiers:

- `issueId`: tracker internal UUID (stable foreign key).
- `identifier`: human ticket key (e.g., `MT-620`).

Use `issueLogger(logger, issueId, identifier)` from `observability/logger.ts`.

When logging agent execution lifecycle events, include:

- `sessionId`: agent session identifier.

Use `sessionLogger(logger, sessionId, workspace)` from `observability/logger.ts`.

## Message Design

- Use Pino's structured object-first API: `logger.info({ issueId, turns }, "Worker completed")`.
- Prefer deterministic wording for recurring lifecycle events.
- Include the action outcome (`completed`, `failed`, `retrying`) and the reason when available.
- Avoid logging large payloads unless required for debugging.

## Scope Guidance

- **Orchestrator**: dispatch, retry, terminal/non-active transitions, worker exits with issue context.
- **Worker**: start/completion/failure with issue context, plus sessionId when known.
- **Agent adapters**: session start/completion/error with issue context and sessionId.

## Anti-Patterns

- No `console.log`, `console.error`, or `console.warn` in library code — enforced by `test/architecture/conventions.test.ts`.
- No string interpolation in the first Pino argument — use structured fields.
- No sensitive data (API keys, tokens) in log messages.

## Checklist for New Logs

- Is this event tied to an issue? Include `issueId` and `identifier`.
- Is this event tied to an agent session? Include `sessionId`.
- Is the failure reason present and concise?
- Is the message format consistent with existing lifecycle logs?
