---
name: debug
description: Investigate stuck runs and execution failures by tracing Forge logs with issue/session identifiers.
---

# Debug

## Goals

- Find why a run is stuck, retrying, or failing.
- Correlate issue identity to an agent session quickly.
- Read the right logs in the right order to isolate root cause.

## Log Sources

- Primary log: `forge.log` (or path configured via `--logs-root`)
  - Forge uses Pino for structured JSON logging.
  - Console output uses pino-pretty for human-readable format.
  - File output is newline-delimited JSON (one object per line).

## Correlation Keys

Forge logs include these structured fields for filtering:

- `issueId`: tracker-specific issue ID (e.g., Linear UUID)
- `identifier`: human-readable ticket key (e.g., `MT-625`)
- `sessionId`: agent session identifier
- `workspace`: filesystem path to the issue workspace

## Quick Triage (Stuck Run)

1. Confirm the symptom: is the issue dispatched but not completing?
2. Find recent log lines for the ticket (search by `identifier` first).
3. Extract `sessionId` from matching lines.
4. Trace that session across start, event stream, completion/failure, and
   stall handling logs.
5. Classify: timeout/stall, agent startup failure, turn failure, or
   orchestrator retry loop.

## Commands

```bash
# 1) Search by ticket key (fastest entry point)
rg -n '"identifier":"MT-625"' forge.log*

# 2) If needed, search by issue ID
rg -n '"issueId":"<uuid>"' forge.log*

# 3) Pull session IDs for a ticket
rg -o '"sessionId":"[^"]+"' forge.log* | sort -u

# 4) Trace one session end-to-end
rg -n '"sessionId":"<session-id>"' forge.log*

# 5) Focus on failure signals
rg -n '"msg":"(Worker error|stalled|scheduling retry|Completed)"' forge.log*

# For pretty-printed console logs, use plain text search:
rg -n "MT-625" forge.log*
```

## Log Structure (JSON format)

Each log line is a JSON object with at minimum:

```json
{
  "level": 30,
  "time": 1710000000000,
  "msg": "Dispatching MT-625: Fix login bug",
  "issueId": "abc-123",
  "identifier": "MT-625"
}
```

Pino log levels: 10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal.

## Investigation Flow

1. **Locate the ticket slice:**
   - Search by `identifier` field.
   - If noise is high, add `issueId` filter.
2. **Establish timeline:**
   - Find first dispatch log: `"msg":"Dispatching ..."`
   - Follow with completion, error, or stall events.
3. **Classify the problem:**
   - **Stall loop:** Orchestrator detects no activity within `stall_timeout_seconds`,
     kills the worker, schedules retry with backoff.
   - **Agent startup failure:** Agent adapter fails to spawn session.
   - **Turn execution failure:** Agent reports error event during streaming.
   - **Terminal transition:** Issue was moved to Done/Closed while worker was running.
4. **Check retry state:**
   - Look for retry scheduling logs with attempt count.
   - Exponential backoff: base_delay * 2^(attempt-1), capped at max_delay.
   - After max_attempts, issue is released (no more retries).
5. **Capture evidence:**
   - Save key log lines with timestamps, `issueId`, and `sessionId`.
   - Record probable root cause and the exact failing stage.

## Common Failure Modes

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Issue dispatched but never completes | Agent process hung or crashed | Check agent adapter logs, verify CLI is accessible |
| Rapid retry loop | Agent errors on every turn | Check error events in session stream |
| Issue never dispatched | Blocked by active blocker issue | Check blocker states in tracker |
| Dispatch but immediate completion | Issue moved to terminal state externally | Expected behavior — check tracker |
| "Worker error" in logs | Unhandled exception in worker loop | Check full error message and stack |

## Notes

- Prefer `rg` (ripgrep) over `grep` for speed on large log files.
- Check rotated logs (`forge.log*`) before concluding data is missing.
- Use `jq` for structured queries on JSON log files:
  ```bash
  cat forge.log | jq 'select(.identifier == "MT-625")'
  ```
