# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (Electron + Python backend with hot reload)
npm run dev

# Run Python backend standalone (opens browser to http://localhost:8080)
uv run python python/backend.py
uv run python python/backend.py --debug  # with debug.log

# Test Python modules directly
uv run python python/extract_prices.py [path/to/file.pdf]
uv run python python/update_pdf.py

# Build for distribution
npm run build:mac
npm run build:win
npm run build:linux
npm run build:local:mac  # includes Python bundling
```

## Architecture

Electron desktop app with Python backend for PDF processing.

```
Electron Main Process (src/main/)
├── main.js           → Window management, menus, IPC handlers
├── python-bridge.js  → Spawns/manages Python backend process
└── preload.js        → Exposes safe APIs to renderer

Renderer Process (src/renderer/)
├── index.html        → Price editing UI
└── editor.js         → Frontend logic, API calls to backend

Python Backend (python/)
├── backend.py        → HTTP API server on localhost:8080
├── extract_prices.py → PyMuPDF price extraction
└── update_pdf.py     → PyMuPDF redaction + text insertion
```

**Data Flow:**
```
Electron menu → native file dialog → /api/load (pdf_path) → extract_prices
                                          ↓
                      renderer displays prices as editable list
                                          ↓
             Export button → /api/export (updates[]) → update_pdf → saved PDF
```

**API Endpoints:**
- `GET /api/health` - Backend status
- `GET /api/prices` - Get cached prices
- `POST /api/load` - Load PDF: `{"pdf_path": "..."}`
- `POST /api/export` - Export: `{"updates": [...], "output_path": "..."}`

## Critical: Avoiding Visible Rectangles

The PDF has background graphics. Standard redaction creates visible white rectangles. The solution requires ALL of these in `update_pdf.py`:

```python
# 1. MUST be called before any text extraction or redaction
fitz.TOOLS.set_small_glyph_heights(True)

# 2. Use tighter bbox (10% margin reduction)
margin = height * 0.1
tight_rect = fitz.Rect(x0, y0 + margin, x1, y1 - margin)

# 3. Redact with fill=False
page.add_redact_annot(tight_rect, fill=False)

# 4. Apply with graphics preservation
page.apply_redactions(
    images=fitz.PDF_REDACT_IMAGE_NONE,
    graphics=fitz.PDF_REDACT_LINE_ART_NONE
)

# 5. Clean up
page.clean_contents()
```

## Font Configuration

Uses Calibri from Microsoft Office:
- macOS: `/Applications/Microsoft Word.app/Contents/Resources/DFonts/Calibri.ttf`
- Windows: `C:/Windows/Fonts/calibri.ttf`
- Fallback: Helvetica (`fontname="helv"`)

## Python-Electron Communication

Python backend signals readiness by printing `READY:{port}` to stdout. The `python-bridge.js` watches for this pattern before resolving the startup promise.

In development, uses project's `.venv/bin/python`. In production, uses PyInstaller-bundled executable at `resources/python-backend/`.

## CI/CD

GitHub Actions workflow (`.github/workflows/build.yml`) triggers on version tags (`v*`):
1. Builds Python backend with PyInstaller on macOS and Windows
2. Builds Electron app with electron-builder
3. Uploads artifacts to GitHub Release

## Issue Tracking with Beads

This project uses [beads](https://github.com/steveyegge/beads) (`bd`) for issue tracking.

**When you discover issues during development, FILE THEM - don't silently ignore:**

```bash
bd create "Description of issue" -t [type] -p [priority]
```

**Types:** `bug`, `task`, `chore`, `feature`, `epic`

**Priorities:**
- `1` - Critical (blocks functionality, causes errors)
- `2` - Important (should fix soon)
- `3` - Nice-to-have (cleanup, minor improvements)

**File a bead when you find:**
- Bugs or potential errors
- Missing error handling
- TODO/FIXME comments that need attention
- Code smells or technical debt
- Missing tests or documentation gaps
- Performance concerns
- Security issues

**Examples:**
```bash
bd create "update_pdf.py:45 missing error handling for invalid bbox" -t bug -p 2
bd create "python-bridge.js needs timeout for Python startup" -t task -p 2
bd create "Add unit tests for extract_prices.py" -t chore -p 3
```

**Workflow:**
```bash
bd ready                    # Find work with no blockers
bd update <id> --status in_progress  # Claim work
bd close <id>               # Complete work
bd sync                     # Sync with git
```

### User Report Triage

Bug Spray (Help → Bug Spray) allows users to submit bug reports. Reports are handled differently based on whether ERROR level logs are detected:

**With ERROR in logs (auto-approved):**
- Status: `open` (visible to `bd ready`)
- Label: `has-error`
- Priority: P1
- No manual triage needed

**Without ERROR (requires triage):**
- Status: `deferred` (invisible to `bd ready`)
- Label: `needs-triage`
- Priority: P2
- User must provide description

**Finding reports to triage:**
```bash
bd list --status=deferred --label=needs-triage
```

**Approving a report (makes it available to automation):**
```bash
bd update <id> --status=open --remove-label=needs-triage
```

**Rejecting a report:**
```bash
bd close <id> --reason="Invalid: <explanation>"
```

**Finding auto-approved reports:**
```bash
bd list --label=has-error
```

The error detection uses Python logging format (`" - ERROR - "`) which cannot be spoofed via `/api/log` (logs at INFO level). Unit tests verify injection resistance.

### Me Too Votes

When users see a similar bug during Bug Spray submission, they can click "Me Too" instead of filing a duplicate. Votes are stored in:

```
.beads/attachments/<issue-id>/votes.json
```

Each vote includes timestamp, user note, and system info. Check vote count during triage:

```bash
cat .beads/attachments/<issue-id>/votes.json | jq length
```

More votes = higher priority signal. Consider vote context when prioritizing fixes.
