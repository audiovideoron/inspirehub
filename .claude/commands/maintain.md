---
description: "Fix all issues: scan → fix → push (use --fix-only to skip scanning, --app to scope)"
allowed-tools: ["Task", "Bash", "Read", "Grep"]
---

# Maintain

Scan for issues, fix them, push.

## Arguments

- `--fix-only` or `--no-scan`: Skip the scan step and only fix existing issues
- `--app=<name>`: Only fix issues for a specific app (equipment, price-list, shell)

## Workflow

### 1. Scan (skip if --fix-only)

**If `--fix-only` or `--no-scan` is passed, skip to step 2.**

Otherwise, spawn both analyzers in parallel:

```
Task: security-scanner
Task: codebase-analyzer
```

Wait for both to complete.

Note: Scanners analyze the entire codebase. App filtering applies to fixing, not scanning.

### 2. Get Ready Work

**If `--app=<name>` is provided:**
```bash
bd ready --label=app:<name> --json
```

**Otherwise (all apps):**
```bash
bd ready --json
```

If nothing ready, report "Nothing to fix" and stop.

### 3. Fix

For each ready issue, parse the file from the title. Group by file.

**Create worktrees** for parallel isolation (per Anthropic best practices):
```bash
git worktree add /tmp/maintain-{group} -b fix/{group}
```

**Parallel:** Issues touching different files run simultaneously in separate worktrees.
**Sequential:** Issues touching the same file run one at a time in the same worktree.

Spawn fix agents using `subagent_type: general-purpose` with this prompt:

```
Fix bead {BEAD_ID}

WORKING DIRECTORY: {WORKTREE_PATH}

1. bd show {BEAD_ID}
2. Read the target file
3. Implement minimal fix
4. Run tests (npm test or uv run pytest)
5. If tests pass: commit and bd close {BEAD_ID}
6. If tests fail: don't commit, report failure
```

### 4. Merge & Cleanup

For each group:
1. `git merge fix/{group} --no-edit`
2. If merge succeeds: `bd close` all SUCCESS issues in that group
3. Remove worktree: `git worktree remove /tmp/maintain-{group}`
4. Delete branch: `git branch -d fix/{group}`

Skip failed groups (don't merge, don't close issues, but still cleanup worktree/branch).

### 5. Push

```bash
bd sync
git push
bd sync  # sync again after push
```

### 6. Report

```
Fixed: X
Failed: Y
Pushed to: origin/main
Worktrees cleaned: Y
```
