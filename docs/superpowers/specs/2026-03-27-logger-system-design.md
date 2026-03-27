# Logger System Design

**Date:** 2026-03-27
**Scope:** Main process only (extensible to renderer later)

## Overview

Replace raw `console.*` calls in `src/main/` with a structured Winston-based logger. Adds level filtering (DEBUG in dev, INFO in production) and file logging with daily rotation.

## Dependencies

- `winston` — core logger
- `winston-daily-rotate-file` — file rotation transport

## Logger Module (`src/main/logger.ts`)

Single module exporting:

1. **`logger`** — root Winston instance
2. **`createLogger(tag: string)`** — factory returning a child logger with the tag baked into all output

### Level Configuration

- **Default:** `debug` in dev (`import.meta.env.DEV` or `app.isPackaged === false`), `info` in production
- **Override:** `LOG_LEVEL` env var takes precedence when set

### Transports

**Console transport (always active):**
- Custom format: `[tag] level: message` with colorization in dev
- Human-readable for terminal output during `electron-vite dev`

**File transport (`winston-daily-rotate-file`):**
- Path: `~/.fleet/logs/fleet-%DATE%.log`
- Rotation: daily
- Retention: 7 days max
- Format: JSON for machine readability

### Child Logger Usage

```ts
// src/main/pty-manager.ts
import { createLogger } from './logger'
const log = createLogger('pty-manager')

log.debug('spawning PTY', { shell, cols, rows })
log.error('PTY exited unexpectedly', { code })
```

## Initialization

The logger is a module-level singleton — initializes on first import. The file transport uses `app.getPath('home')` for the log directory (`~/.fleet/logs/`), which is available immediately in Electron's main process without waiting for `app.whenReady()`. Winston creates the directory if it doesn't exist.

## Migration Strategy

Replace `console.*` calls in `src/main/` files (~20 files, ~100+ call sites) with child logger equivalents.

### Mapping

| Before | After |
|--------|-------|
| `console.log('[tag] msg', data)` | `log.info('msg', { data })` |
| `console.warn('[tag] msg')` | `log.warn('msg')` |
| `console.error('[tag] msg', err)` | `log.error('msg', { error: err })` |
| `console.log('[debug ...]')` | `log.debug('...')` |

### Rules

- Each file gets `const log = createLogger('module-name')` at the top
- Strip `[tag]` prefix from message strings — the child logger adds it automatically
- Structured data goes in the metadata object, not string interpolation
- Error objects go as `{ error: err }` for proper serialization
- Files outside `src/main/` (renderer, scripts) are **not touched** — they keep `console.*`

## What Does NOT Change

- `electron-vite` config
- Build pipeline (Winston is a Node.js dep, works in main process as-is)
- Preload or renderer code
