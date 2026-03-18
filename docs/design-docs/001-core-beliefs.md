# 001: Core Beliefs

Guiding principles for Forge development. These are opinionated, mechanical rules that keep the codebase legible and consistent for both human and agent developers.

## Principles

### 1. Spec-first

`SPEC.md` is the source of truth for Symphony's behavior. The TypeScript implementation may be a superset of the spec but must not conflict with it. When implementation changes alter intended behavior, update the spec in the same change.

### 2. Adapter pattern for all external boundaries

Every external system (issue trackers, coding agents) is behind an interface defined in `types.ts`. Implementations are swappable. New integrations follow the factory pattern in `index.ts`. This keeps the orchestrator testable and agent-legible.

### 3. Workspace isolation is non-negotiable

Agents never run in the source repository. Every issue gets an isolated workspace directory under the configured root. Hook scripts manage setup and teardown. This is a safety invariant, not a convenience.

### 4. types.ts is the public API contract

Each module's `types.ts` file defines the interfaces that other modules import. Implementation files are internal. This boundary is enforced by `test/architecture/boundaries.test.ts`.

### 5. Config flows through Zod

All configuration is validated at the boundary via the Zod schema in `config/schema.ts`. No ad-hoc `process.env` reads in library code. Config resolution happens once at startup and is passed down explicitly.

### 6. Fail loudly, retry gracefully

Errors include structured context (issue ID, session ID, operation). Transient failures get exponential backoff through the retry queue. Permanent failures surface immediately. Never silently swallow errors.

### 7. Observability by default

Every state transition — dispatch, completion, retry, error — is logged with issue context via Pino structured logging. Follow `docs/logging.md` for field naming and scope guidance.

### 8. Agent-first documentation

Documentation is optimized for progressive disclosure. Agents start at `AGENTS.md` (the table of contents), which points to `ARCHITECTURE.md` for structure, `docs/` for depth, and `SPEC.md` for the full specification. Keep each layer concise and self-contained.
