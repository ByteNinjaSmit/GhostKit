# MockPilot

**AI mock-interview coach — realistic voice interviews, a live coding round, and structured feedback, all on your desktop.**

MockPilot is a cross-process [Electron](https://www.electronjs.org/) desktop app that runs realistic, spoken mock interviews powered by Google Gemini. It conducts a live voice conversation as an interviewer, runs a coding round with an in-app editor and code execution, retrieves context from your own documents (RAG), and saves every session so you can review transcripts, feedback, and trends over time.

> ⚠️ **Intended use — practice only.** MockPilot is a *practice* tool for rehearsing interviews on your own. It includes window "stealth" options (screen-capture exclusion, no taskbar button). Do **not** use it to gain an unfair advantage in a real, live, or proctored interview or assessment — that is dishonest, usually against the rules you agreed to, and can have serious consequences. See [Responsible use](#responsible-use).

---

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration (Gemini API key)](#configuration-gemini-api-key)
- [Running in development](#running-in-development)
- [Building the Windows installer](#building-the-windows-installer)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Where your data lives](#where-your-data-lives)
- [Project structure](#project-structure)
- [npm scripts](#npm-scripts)
- [Troubleshooting](#troubleshooting)
- [Security posture](#security-posture)
- [Responsible use](#responsible-use)
- [License](#license)

---

## Features

- **🎙️ Live voice interview** — a real-time spoken interview driven by the Gemini Live API. Configure the **role** (Software Engineer, DevOps, AI/ML, Data, HR), **difficulty** (easy / medium / hard), **target company**, and **duration** on the Setup screen.
- **💻 Coding round** — an integrated [Monaco](https://microsoft.github.io/monaco-editor/) editor with syntax highlighting for many languages, on-demand hints, code execution, and an AI code review of your submission.
- **📸 Screenshot → problem extraction** — capture a coding problem from your screen with a hotkey; the image is held in memory and only sent to Gemini after you explicitly confirm.
- **📚 Retrieval-augmented context (RAG)** — index your own notes/resume/PDFs into a local vector store (`better-sqlite3` + `sqlite-vec`) so answers and questions can draw on your material.
- **📊 History & trends** — every session is stored locally; browse past sessions, read transcripts and feedback, and view topic-trend charts (Recharts).
- **🧾 Structured feedback** — per-answer review and end-of-session summaries.
- **🕶️ Stealth window options** — screen-capture exclusion, always-on-top, skip-taskbar, and a floating "Ghost" HUD overlay (see [Responsible use](#responsible-use)).

## Tech stack

| Layer | Technology |
|-------|-----------|
| Shell | Electron 44 |
| Build | electron-vite 5, Vite 7, electron-builder 26 (NSIS) |
| UI | React 18, TypeScript 5, Tailwind CSS 3, class-variance-authority |
| Editor | Monaco (`@monaco-editor/react`) |
| Charts | Recharts 3 |
| AI | `@google/genai` (Gemini + Gemini Live) |
| Storage | `better-sqlite3` (SQLite), `sqlite-vec` (vector search) |
| Secrets | `keytar` (OS credential store) |
| PDF | `pdf-parse` |

## Architecture

MockPilot follows Electron's three-part model with a strict security boundary:

- **Main process** (`electron/`) — owns all privileged work: Gemini calls, the SQLite databases, the OS keychain, screenshot capture, code execution, and window/stealth management. Exposes a typed IPC surface (`electron/ipc-types.ts`).
- **Preload** (`electron/preload.ts`) — the *only* bridge between main and renderer, built as CommonJS (`.cjs`). It exposes a narrow, typed `window.api` via `contextBridge` and re-validates every payload crossing the boundary.
- **Renderer** (`src/`) — the React UI. Runs **untrusted**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and a locked-down Content-Security-Policy. It has no direct Node or filesystem access — everything goes through `window.api`.

Prompt templates live as editable Markdown in [`prompts/`](prompts/) (`interviewer.md`, `hints.md`, `review.md`, `code-review.md`, `screenshot-extract.md`) and are read at runtime, so you can tune behavior without touching code.

## Prerequisites

- **Node.js 20+** (developed on Node 22) and npm 10+.
- **Windows 10 version 2004 (build 19041) or newer** for a fully functional build. The screen-capture-exclusion feature (`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`) only *excludes* the window on these versions; on older builds it falls back to rendering black in captures.
- **A C/C++ build toolchain** — the native modules `better-sqlite3` and `keytar` are compiled/rebuilt against Electron's ABI at install time. On Windows install the **Visual Studio 2022 Build Tools** with the **Desktop development with C++** workload:

  ```powershell
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
    --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  ```

  (`sqlite-vec` ships a prebuilt Windows binary and needs no compilation.)
- **A Google Gemini API key** — get one from [Google AI Studio](https://aistudio.google.com/apikey).

## Installation

```bash
git clone <your-remote-url> GhostKit
cd GhostKit
npm install
```

`npm install` runs a `postinstall` step (`electron-builder install-app-deps`) that rebuilds `better-sqlite3` and `keytar` for Electron's ABI. If it fails with *"Could not find any Visual Studio installation"*, install the C++ Build Tools (above) and re-run `npm install`.

> If `node_modules` ever looks corrupt (e.g. wrong-OS `.node` binaries, or `@google/genai` missing its `.d.ts` files), do a clean reinstall: `rm -rf node_modules && npm install`.

## Configuration (Gemini API key)

MockPilot never stores your API key in a plaintext file. On first launch:

1. Open **Settings**.
2. Paste your **Google Gemini API key**.

The key is stored via **keytar** in the OS credential vault (Windows Credential Manager). Without a key, the interview, hints, review, and RAG features are inert.

## Running in development

```bash
npm run dev
```

This starts `electron-vite` with hot-reload for the renderer and launches the app. Main-process logs stream to the terminal — the fastest way to see runtime errors.

## Building the Windows installer

```bash
npm run build:win
```

This runs `typecheck` → `electron-vite build` → `electron-builder --win`. Output in `dist/`:

- **`MockPilot-Setup-<version>-x64.exe`** — the NSIS installer to distribute. Per-user install (no admin prompt), installs under `%LOCALAPPDATA%\Programs`, lets you choose the folder, and creates desktop + Start-menu shortcuts.
- **`win-unpacked/MockPilot.exe`** — the raw unpacked app; run it directly without installing.

> **Unsigned build.** No code-signing certificate is configured, so Windows SmartScreen shows an *"unknown publisher"* warning on first run. Choose **More info → Run anyway**. Signing requires a certificate (`win.certificateFile` / `CSC_LINK`) and is out of scope for this repo.

## Keyboard shortcuts

Global hotkeys (registered while the app is running):

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+M` | Summon / focus the main window (needed because the window has no taskbar button by default) |
| `Ctrl+Alt+G` | Toggle the floating **Ghost** HUD overlay |
| `Ctrl+Alt+C` | Toggle click-through on the overlay |
| `Ctrl+Alt+X` | Panic — hide/close stealth windows |
| `Ctrl+Shift+S` | Capture a screenshot of the coding problem *(only while the Coding page is open)* |

In-session UI shortcuts: `Ctrl+Shift+Space` (toggle session), `Ctrl+Shift+H` (next hint).

**Window presentation:** by default the main window ships **without a taskbar button** (`skipTaskbar`), so Windows Task Manager lists the process under **Background processes** rather than **Apps**. This is a grouping choice, not concealment — the process remains fully visible and named in Task Manager. Turn it off in Settings to get a normal taskbar button back.

## Where your data lives

All user data is stored under `app.getPath('userData')` — on Windows: `%APPDATA%\mockpilot\`.

| File | Contents |
|------|----------|
| `history.sqlite3` | Session history, transcripts, feedback |
| `rag.sqlite3` | Your indexed documents + vector embeddings |
| *(OS credential vault)* | Gemini API key (via keytar) |

Uninstalling **keeps** this data by design. To remove it, delete `%APPDATA%\mockpilot\` and remove the MockPilot entry from Windows Credential Manager.

## Project structure

```
GhostKit/
├─ electron/                 # Main process (privileged)
│  ├─ main.ts                # App lifecycle, windows, hotkeys, IPC registration
│  ├─ preload.ts             # contextBridge API (the only main↔renderer bridge)
│  ├─ ipc-types.ts           # Typed IPC channels, payloads, shared constants
│  ├─ lib/                   # promptTemplate, redact, speechMetrics, ...
│  └─ services/              # gemini, geminiLive, rag, history, keyVault,
│                            #   codingAssist, codeRunner, review, usage
├─ src/                      # Renderer (React UI)
│  ├─ pages/                 # Setup, Interview, CodingRound, History, Settings
│  ├─ components/            # UI, transcript, overlay, history, charts
│  ├─ audio/                 # capture / playback / PCM worklet pipeline
│  └─ lib/                   # hooks and helpers
├─ prompts/                  # Editable Markdown prompt templates
├─ scripts/generate-icon.mjs # Icon generation
├─ build/                    # Build resources (icon.ico / icon.png)
├─ electron-builder.yml      # Packaging config (NSIS, Windows x64)
├─ electron.vite.config.ts   # electron-vite build config
└─ package.json
```

## npm scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Launch the app with hot-reload |
| `npm run build` | Typecheck, then build main/preload/renderer bundles |
| `npm run build:win` | Full build + package the Windows NSIS installer |
| `npm run preview` | Preview the production build |
| `npm run typecheck` | Type-check both the Node and web tsconfigs |
| `npm run icon` | Regenerate app icons |
| `npm run postinstall` | Rebuild native modules for Electron (runs automatically on install) |

## Troubleshooting

- **`node-gyp` / "Could not find any Visual Studio installation"** — install the VS 2022 Build Tools with the C++ workload (see [Prerequisites](#prerequisites)), then re-run `npm install`.
- **`NODE_MODULE_VERSION` mismatch at runtime** — a native module wasn't built for Electron's ABI. Run `npm run postinstall` (i.e. `electron-builder install-app-deps`).
- **SmartScreen "unknown publisher"** — expected for the unsigned build; choose *More info → Run anyway*.
- **AI features do nothing** — set your Gemini API key in **Settings**.
- **Can't find the window** — it has no taskbar button by default; press `Ctrl+Alt+M`.
- **Corrupt `node_modules`** — `rm -rf node_modules && npm install`.

## Security posture

- Renderer is fully sandboxed and isolated; no Node integration; strict CSP.
- Every IPC payload is validated on both sides of the bridge.
- `window.open` / `target="_blank"` only opens plain `https:` URLs in the system browser (blocks `file:`, `ms-msdt:`, and other protocol-handler pivots).
- API key is kept in the OS credential vault, never in a config file.
- Screenshots are held in memory only (never written to disk) and uploaded only after explicit confirmation.

## Responsible use

MockPilot is built for **self-directed interview practice**. The stealth features (screen-capture exclusion, no-taskbar/background-process presentation, click-through HUD overlay) exist so a *practice* overlay doesn't clutter your own recordings or screen — **not** to deceive an interviewer.

Using it to obtain real-time help during an actual interview, exam, or proctored assessment is a form of cheating: it typically violates the terms you agreed to, is unfair to other candidates, and can cost you the offer, the job, or your standing. Please use it honestly. The maintainers accept no responsibility for misuse.

## License

Private / unpublished (`"private": true`). No license is granted for redistribution unless the repository owner adds one.
