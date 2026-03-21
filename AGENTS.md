# Fleet

A lightweight, cross-platform terminal multiplexer desktop app for developers running multiple AI coding agents simultaneously. 

## Stack

Electron + electron-vite + React + TypeScript, xterm.js for terminal emulation, node-pty for PTY processes, shadcn/ui + Tailwind for UI chrome.

## Reference Repos

Three reference codebases live in `reference/` for inspiration and pattern reference:

### `reference/cmux`
**cmux** — The primary inspiration for Fleet. A Ghostty-based macOS terminal app with vertical tabs and notification rings for AI coding agents. Written in Swift as a native macOS app. Key concepts to borrow: vertical tab sidebar, split panes, notification rings (OSC 9/777 escape detection), and the overall UX for managing multiple agent sessions. Mac-only, which is why Fleet exists — to bring this experience cross-platform via Electron.

### `reference/gastown`
**Gas Town** — A multi-agent orchestration system for Codex with persistent work tracking. Written in Go. Provides a workspace manager that coordinates multiple Codex agents with persistent state via git-backed hooks. Relevant for understanding agent coordination patterns, mailbox/identity systems, and how to scale to many concurrent agents. Its architecture (Mayor coordinator, Rigs, Crews, Polecats) is a useful reference for the Socket API and automation layer.

### `reference/pixel-agents`
**Pixel Agents** — A VS Code extension that visualizes AI agents as pixel art characters in an office. Written in TypeScript (Node.js extension + React webview). Most relevant reference for Fleet's TypeScript patterns, terminal lifecycle management, and JSONL-based agent activity tracking. Key patterns to study: terminal creation/adoption, file watching for agent transcripts, and the message protocol between backend and frontend.

## Project Docs

The full product spec lives in `docs/idea.md` — covers features, architecture, data model, notification detection, socket API, distribution, and platform-specific notes.

## Learnings

Past mistakes and fixes are documented in `docs/learnings/`. **After every mistake or unexpected bug, write down what happened and how it was fixed in a new or existing learnings file.** This prevents repeating the same mistakes. Always research (GitHub issues, Context7 docs) before attempting random fixes.

## Development Notes

- **ESM output:** The main and preload processes output ESM (`.mjs`). Use `import.meta.url` instead of `__dirname`.
- **node-pty macOS bug:** `spawn-helper` needs `chmod +x` — handled by postinstall script.
- **xterm.js + StrictMode:** Track PTY creation in a module-level Set to prevent duplicates. Use Canvas addon (not WebGL) to avoid disposal errors.
- **xterm.js container sizing:** Mount xterm into an inner div, put padding on an outer wrapper div. Otherwise `fit` addon miscalculates dimensions.
