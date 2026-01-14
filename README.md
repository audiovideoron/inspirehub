# Inspire Hub

Desktop application for Inspire Solutions. Built with Electron and Python.

## Features

- **Price List Editor** - Edit prices in PDF price lists
- **Equipment Search** - Search R2 inventory (coming soon)
- **Equipment Request** - Submit internal equipment requests (coming soon)

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
Electron App
├── Main Process (Node.js)
│   ├── Native file dialogs
│   ├── Menu bar
│   └── Python sidecar management
├── Renderer Process (HTML/JS)
│   └── UI (price editor, equipment search)
└── Python Backend (localhost:8080)
    ├── PDF price extraction/modification
    └── R2 API (mock for now)
```

## Project Structure

```
inspirehub/
├── src/
│   ├── main/           # Electron main process
│   │   ├── main.js
│   │   ├── preload.js
│   │   └── python-bridge.js
│   └── renderer/       # UI
│       ├── index.html
│       ├── editor.js
│       └── editor.css
├── python/             # Python backend
│   ├── backend.py      # HTTP API server
│   ├── extract_prices.py
│   ├── update_pdf.py
│   └── r2_mock.py      # R2 API mock (coming soon)
├── scripts/
│   ├── dev.js          # Development launcher
│   └── build-python.js # PyInstaller bundler
└── dist/               # Build output
```

## License

MIT
