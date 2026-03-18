---
name: push
description: Push current branch to origin and create or update the corresponding pull request.
---

# Push

## Prerequisites

- `gh` CLI is installed and authenticated.

## Goals

- Push current branch changes to `origin` safely.
- Create a PR if none exists for the branch, otherwise update the existing PR.
- Keep branch history clean when remote has moved.

## Steps

1. Identify current branch and confirm remote state.
2. Run local validation (tests, lint, build) before pushing.
3. Push branch to `origin` with upstream tracking if needed.
4. If push is rejected:
   - If non-fast-forward or sync issue, run the `pull` skill to merge
     `origin/main`, resolve conflicts, and rerun validation.
   - Push again; use `--force-with-lease` only when history was rewritten.
   - If auth/permissions failure, surface the exact error — do not retry.
5. Ensure a PR exists for the branch:
   - If no PR exists, create one.
   - If a PR exists and is open, update it.
   - If branch is tied to a closed/merged PR, create a new branch + PR.
   - Write a clear PR title that describes the change outcome.
   - For branch updates, reconsider whether current PR title still matches
     the latest scope; update if needed.
6. Write/update PR body:
   - Fill every section with concrete content for this change.
   - If PR already exists, refresh body to reflect total PR scope (all work
     on the branch), not just newest commits.
7. Reply with the PR URL.

## Commands

```bash
# Identify branch
branch=$(git branch --show-current)

# Push with upstream tracking
git push -u origin HEAD

# If rejected due to remote changes, use pull skill first, then retry:
git push -u origin HEAD

# Only if history was rewritten locally:
git push --force-with-lease origin HEAD

# Ensure a PR exists
pr_state=$(gh pr view --json state -q .state 2>/dev/null || true)
if [ "$pr_state" = "MERGED" ] || [ "$pr_state" = "CLOSED" ]; then
  echo "Current branch tied to closed PR; create a new branch + PR."
  exit 1
fi

pr_title="<clear PR title for this change>"
if [ -z "$pr_state" ]; then
  gh pr create --title "$pr_title"
else
  gh pr edit --title "$pr_title"
fi

# Show PR URL
gh pr view --json url -q .url
```

## Notes

- Do not use `--force`; only use `--force-with-lease` as last resort.
- Distinguish sync problems (use pull skill) from auth problems (surface error).
