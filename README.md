# Inspire Hub

Desktop application shell for Inspire Solutions. Built with Electron (TypeScript) and Python backends.

## Features

- **Price List Editor** - Edit prices in PDF price lists
- **Equipment Request** - Submit and track internal equipment requests

## Bug Reporting (Bug Spray)

Found a bug? Use **Help → Bug Spray** to submit a report.

### What Gets Captured

- **Screenshot** - Current window state
- **Application logs** - Recent activity and errors (current session only)
- **System info** - OS version, app version, memory usage

### How It Works

1. Click **Help → Bug Spray** (or press the keyboard shortcut)
2. Describe what went wrong
3. Review the screenshot preview
4. Click **Submit**

If a similar bug has already been reported, you'll see a match and can click **"Me Too"** to add your vote.

### Where Reports Go

- **Production**: Submitted to GitHub Issues
- **Development**: Stored locally in `.beads/`

## Development

Requires Node.js 18+ and Python 3.12+.

```bash
# Install dependencies
npm install
uv sync

# Run in development mode
npm run dev

# Build for distribution
npm run build:mac
```

## Architecture

```
Electron App (TypeScript)
├── Main Process
│   ├── Window management
│   ├── Native file dialogs
│   ├── Menu bar
│   └── Python backend management
├── Shell (src/shell/)
│   ├── Navigation between apps
│   ├── Centralized logging
│   └── Bug Spray UI
└── Apps (src/apps/)
    ├── price-list/     → Python backend (port 8080-8089)
    ├── equipment/      → Python backend (port 8090-8099)
    └── bugspray/       → No backend (uses shell services)
```

## Project Structure

```
inspirehub/
├── src/
│   ├── main/               # Electron main process
│   │   ├── main.ts
│   │   ├── preload.ts
│   │   └── python-bridge.ts
│   ├── shell/              # App shell (navigation, logging)
│   │   ├── shell.html
│   │   └── shell.ts
│   ├── apps/               # Individual apps (iframes)
│   │   ├── price-list/
│   │   ├── equipment/
│   │   └── bugspray/
│   └── shared/             # Shared utilities
├── python/                 # Python backends
│   ├── shared/             # Shared Python utilities
│   ├── price_list/         # Price List backend
│   │   ├── backend.py
│   │   ├── extract_prices.py
│   │   └── update_pdf.py
│   └── equipment/          # Equipment backend
│       ├── api.py
│       ├── models.py
│       └── database.py
├── scripts/
│   ├── dev.js              # Development launcher
│   ├── copy-assets.js      # Build asset copier
│   └── build-python.js     # PyInstaller bundler
└── dist/                   # Build output
```

## Roadmap

See [Issue #5: Independent Module System](https://github.com/audiovideoron/inspirehub/issues/5) for the planned architecture to support independent module development and distribution.

## License

MIT
