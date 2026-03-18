# Live Demo Checklist

Prerequisites for running Forge against a real project for the first time.

## Required

- [ ] **Linear project** with a few test tickets in "Todo" state
- [ ] **LINEAR_API_KEY** environment variable set (`export LINEAR_API_KEY="lin_api_..."`)
- [ ] **Claude Code CLI** installed and authenticated (`claude` on PATH)
- [ ] **GitHub CLI** installed and authenticated (`gh` on PATH) — needed by push/land skills
- [ ] **Target repository** — a real or test repo that the agent can modify
- [ ] **WORKFLOW.md** customized:
  - `project_slug` set to your Linear project slug
  - `after_create` hook updated with your repo clone URL
  - `active_states` / `terminal_states` matching your Linear workflow

## Verification Steps

```bash
# 1. Validate config (no credentials needed)
forge validate WORKFLOW.md

# 2. Preview what would be dispatched
forge --dry-run WORKFLOW.md

# 3. Start for real
forge WORKFLOW.md
```

## Recommended

- [ ] Start with `max_concurrent_agents: 1` to observe behavior before scaling up
- [ ] Set `max_turns: 5` initially to limit token spend during testing
- [ ] Use a dedicated test repository to avoid unintended changes
- [ ] Monitor logs: `tail -f` the log file specified by `--logs-root`
