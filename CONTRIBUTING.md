# Contributing to Forge

## Development Setup

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run the full quality gate
make all
```

## Running Tests

```bash
# Run all tests
pnpm test

# Watch mode (re-runs on file changes)
pnpm test:watch

# With coverage report
pnpm test:coverage
```

## Code Style

- **TypeScript** with strict mode enabled
- **Biome** for formatting and linting (100-char line width, 2-space indent, double quotes)
- No `console.log` in library code (only allowed in `src/index.ts` for CLI errors)
- Use Pino logger for all structured logging

Format and lint:
```bash
pnpm run fmt       # auto-format
pnpm run fmt:check # check formatting
pnpm run lint      # lint
```

## Architecture Rules

Forge enforces strict module boundaries via automated tests:

1. **Layer direction** — A module at layer N may only import from layers 0..N-1
2. **No circular imports** — If A imports B, B must not import A
3. **400-line file limit** — No source file may exceed 400 lines
4. **types.ts as contract** — Cross-module imports should target `types.ts`

These rules are enforced by tests in `test/architecture/`. Run `pnpm test` to verify.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full layer diagram and module inventory.

## Adding Adapters

### New tracker

1. Create `src/tracker/<kind>.ts` implementing `TrackerAdapter`
2. Add a case to the factory in `src/tracker/index.ts`
3. Add the kind to the schema enum in `src/config/schema.ts`
4. Write tests in `test/unit/tracker/<kind>.test.ts`

### New agent

1. Create `src/agent/<kind>.ts` implementing `AgentAdapter`
2. Add a case to the factory in `src/agent/index.ts`
3. Add the kind to the schema enum in `src/config/schema.ts`
4. Write tests in `test/unit/agent/<kind>.test.ts`

See [ARCHITECTURE.md](ARCHITECTURE.md#extension-points) for detailed instructions.

## Commit Messages

Use conventional commit format:

```
type(scope): description

feat(tracker): add GitHub Issues adapter
fix(worker): handle stall timeout correctly
test(orchestrator): add dispatcher priority tests
```
