# Admiral not showing after macOS window close-reopen

**Date:** 2026-03-27

## Problem

On macOS, closing the Fleet window (Cmd+W) and reopening from the dock caused the Admiral terminal to not appear. Quitting (Cmd+Q) and reopening worked fine.

## Root Cause

`ptyManager.killAll()` in the `mainWindow.on('close')` handler disposes exit handlers **before** killing the PTY processes. This meant the `AdmiralProcess.onExit` callback never fired, so `admiralProcess.paneId` was never cleared to `null` and `status` was never set to `'stopped'`.

When the window reopened and `ensureStarted()` was called, it saw the stale `paneId` and returned it directly (line 609: `if (admiralProcessRef.paneId) return admiralProcessRef.paneId`). The renderer received this dead paneId, created a terminal for it, but `pty.attach()` returned empty data since the PTY no longer existed in the manager's map.

## Fix

After `ptyManager.killAll()` in the close handler, explicitly reset `admiralProcess.paneId = null` and `admiralProcess.status = 'stopped'`.

## Lesson

When `ptyManager.kill()` disposes exit handlers before killing the process, any external state that depends on exit callbacks (like `admiralProcess.paneId`) won't be cleaned up. Any code that calls `killAll()` must manually reset state that would normally be cleaned up by exit handlers.
