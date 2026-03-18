# Tech Debt Tracker

Known technical debt items, ordered by severity.

## Medium

- **`src/index.ts:27`** — Uses `console.error` for fatal CLI errors. Acceptable for the CLI entry point but would be cleaner with a dedicated error formatter.
- **`src/worker/runner.ts`** — No error-specific types for different failure modes (agent crash vs. timeout vs. tracker error). Currently all failures are generic `Error`.

## Low

- **`src/config/resolver.ts`** — Uses `any` type in environment variable expansion logic. Should use a narrower type or Zod refinement.
- **`src/tracker/index.ts`, `src/agent/index.ts`** — Factory functions use `string` for kind parameter instead of the Zod-validated union type from schema.
- **No Jira or GitHub tracker implementations** — Only Linear and Memory trackers exist. Not needed yet, but the adapter pattern is ready.
- **No `--dry-run` mode** — CLI has no way to validate config and exit without starting the polling loop.

## Resolved

(None yet)
