---
description: "Triage Bug Spray submissions from GitHub Issues into beads"
---

Triage user-submitted bug reports from Bug Spray (GitHub Issues) into the beads issue tracker.

## 1. Fetch Open Bug Spray Issues

```bash
gh issue list -R audiovideoron/InspirePriceList --label "user-reported" --state open --json number,title,body,labels,createdAt
```

If no issues found, report "No Bug Spray submissions to triage" and exit.

## 2. For Each Issue

Display:
- Issue number and title
- Created date
- Labels (note if `has-error` is present - indicates auto-approved with ERROR in logs)
- Body content (truncated if very long)

Ask user: **Accept or Reject?**

### If Accept:

1. Determine priority:
   - P1 if `has-error` label present
   - P2 otherwise

2. Create bead:
   ```bash
   bd create --title="<issue title>" --type=bug --priority=<1 or 2>
   ```

3. Close GitHub issue with bead reference:
   ```bash
   gh issue close <number> -R audiovideoron/InspirePriceList -c "Accepted as <bead-id>"
   ```

### If Reject:

1. Ask user for rejection reason
2. Close GitHub issue:
   ```bash
   gh issue close <number> -R audiovideoron/InspirePriceList -c "Rejected: <reason>"
   ```

## 3. Summary

Report totals: X accepted, Y rejected, Z remaining.

---

**Note**: Bug Spray submissions include system info, app logs, and user session activity. Review the body content to understand the reported issue.
