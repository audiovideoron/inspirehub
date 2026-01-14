---
description: "Security scan + commit with good message + smart push"
---

Commit current changes with security scanning and alpha smoke tests:

## 0. Stage Scope

- Run `git status --short` to show staged/unstaged changes
- Verify only intended changes are staged
- All subsequent checks apply ONLY to staged changes

## 1. Security Scan

Use the security-scanner agent to scan staged diff only:

- **Critical issues** (credentials, secrets, SQL/command injection, XSS/HTML injection, auth/session leaks):
  - Show findings and ask: "Fix automatically? (yes/no/skip)"
  - Block commit until resolved or skipped
- **Warnings only**: Show briefly, do not block
- **Clean**: Continue silently

## 2. Alpha Smoke Tests (MANDATORY)

Run the 3-test stability harness:

```bash
npm run test:alpha
```

- Tests: undo/redo anchor, mirror/flip anchor, auth 401 redirect anchor
- Expected runtime: ~15-20 seconds
- **If ANY smoke test fails**:
  - Print failing test name(s) and error
  - **ABORT commit immediately**
  - Do NOT proceed under any circumstances
- If all pass: Continue to commit

## 3. Commit

Write a conventional commit message:

- **Type prefix**: feat/fix/refactor/docs/test/chore/etc
- **Subject line**: Concise summary of what changed
- **Body** (multi-line):
  - What changed
  - Why it changed
  - Impact / risk assessment
- Include Claude Code attribution footer

## 4. Push

- Always push: `git push -u origin <current-branch>`
- Do NOT ask for confirmation
- Note: Pushing to `main` triggers GitHub Actions deployment
- If on `main` branch, include `DEPLOY:` line in commit body describing deployment impact

---

**Constraints**:
- Smoke tests must remain fast (~15-20s)
- Smoke tests are limited to the 3 core anchors only
- Do not add additional test gates to this workflow
