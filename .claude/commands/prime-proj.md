---
description: Load context for InspirePriceList - architecture, issues, and current state (project)
allowed-tools: Bash, Read
---

# Prime

Initialize context for working on InspirePriceList by gathering project state and documentation.

## Execute

```bash
# Current git state
git status --short
git log --oneline -5

# Project health and ready work
bd stats
bd ready
```

## Read

- CLAUDE.md (architecture, commands, critical patterns)
- AGENTS.md (workflow instructions)

## Report

After gathering context, provide a **concise** summary (not a wall of text):

1. **Git state**: Uncommitted changes? Recent commits?
2. **Project health**: Open issues, blocked work
3. **Ready work**: Top 3 priority items from `bd ready`
4. **Recommendation**: Single sentence on what to tackle first
