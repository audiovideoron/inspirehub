---
description: "Run codebase-analyzer and security-scanner in parallel"
allowed-tools: ["Task", "Bash", "Read"]
---

# Audit

Run all code analyzers in parallel to identify issues. Files beads with consistent prefixes (SECURITY:, QUALITY:) for downstream processing by `/orchestrate`.

## Workflow

### Step 1: Spawn Analyzers in Parallel

Use a SINGLE message with MULTIPLE Task tool calls to run both agents simultaneously:

```
Task 1: security-scanner
  - Scan for security vulnerabilities
  - File beads with SECURITY: prefix

Task 2: codebase-analyzer
  - Scan for code quality issues
  - File beads with QUALITY: prefix
```

Both agents run in parallel. Wait for both to complete before proceeding.

### Step 2: Collect Results

```bash
bd list --status=open
```

### Step 3: Generate Summary

Group issues by prefix and priority:

```
=== AUDIT COMPLETE ===

SECURITY Issues:
  P1 (Critical/High): X
  P2 (Medium): X
  P3 (Low): X

QUALITY Issues:
  P1 (Critical): X
  P2 (Important): X
  P3 (Cleanup): X

Total: X issues filed

Files with multiple issues (potential conflicts):
  - backend.py: X issues
  - main.js: X issues
```

## Flags

- No flags - always runs both analyzers in parallel

## Notes

- Both analyzers check for duplicates before filing
- Issues are tagged with file:line for precise conflict detection
- This command is read-only (analyzers only file beads, no code changes)
- Use `/maintain` for full automation including fixes
