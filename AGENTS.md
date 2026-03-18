# Forge (TypeScript)

Forge is the TypeScript implementation of the Symphony agent orchestration platform. It polls issue trackers (Linear, GitHub, Jira), creates isolated per-issue workspaces, and runs coding agents (Claude, Codex) autonomously with bounded concurrency, retries, and reconciliation.

## Environment

- Node.js >= 20
- TypeScript 5.7+
- Test runner: Vitest
- Package manager: npm

## Quick Commands

```bash
npm test                # Run all tests (unit + integration + architecture)
npm run build           # Type-check and compile (tsc)
npm run test:coverage   # Tests with coverage report
npm run fmt             # Auto-format with Biome
npm run fmt:check       # Check formatting (CI)
npm run lint            # Lint with Biome (CI)
make all                # Full quality gate: build + fmt + lint + test
```

## Codebase Conventions

- Keep implementation aligned with [`SPEC.md`](SPEC.md) where practical.
  - The implementation may be a superset of the spec.
  - The implementation must not conflict with the spec.
  - If changes alter intended behavior, update the spec in the same change.
- Use the **adapter/factory pattern** for new tracker or agent kinds. See `src/tracker/index.ts` and `src/agent/index.ts`.
- Use **Zod** for all runtime validation. Config flows through `src/config/schema.ts`.
- Prefer config access through the `WorkflowStore` / `resolveConfig` path over ad-hoc env reads.
- **Workspace isolation is non-negotiable**: agents never run in the source repo. Workspaces must stay under the configured root.
- See [`ARCHITECTURE.md`](ARCHITECTURE.md) for module layers and dependency rules.
- See [`docs/logging.md`](docs/logging.md) for structured logging conventions.
- See [`docs/design-docs/001-core-beliefs.md`](docs/design-docs/001-core-beliefs.md) for guiding principles.

## Required Rules

- `types.ts` files define the public API contract for each module.
- Barrel `index.ts` files contain only re-exports and factory functions — no business logic.
- No `console.log`, `console.error`, or `console.warn` in library code (use Pino logger).
- Keep changes narrowly scoped; avoid unrelated refactors.
- Follow existing module and naming patterns in `src/`.

## Tests and Validation

Run targeted tests while iterating, then the full gate before handoff:

```bash
make all
```

Architecture tests in `test/architecture/` enforce:
- Module dependency boundaries (no upward imports)
- File size limits (400 lines max)
- Console usage and barrel export conventions

## Docs Update Policy

If behavior or config changes, update docs in the same PR:

- [`README.md`](README.md) — project concept and goals.
- [`SPEC.md`](SPEC.md) — language-agnostic specification.
- [`docs/`](docs/) — logging, design docs, quality score.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — if module boundaries change.
