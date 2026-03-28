# Hook Socket: `end` event never fires for PermissionRequest

**Date:** 2026-03-28

## Problem

The copilot session phase was stuck at "processing" when Claude Code was actually waiting for user input (AskUserQuestion). The copilot sprite showed "processing" animation and the input bar was disabled.

## Root Cause

The Node.js socket server (`socket-server.ts`) processes hook events in the `'end'` event handler — which only fires when the remote end closes the connection. For `PermissionRequest` events, the Python hook keeps the connection open (`sock.recv()` blocks waiting for a response), so `'end'` never fires and `processHookEvent()` is never called. The session phase stays at whatever it was before (usually "processing" from the preceding PreToolUse event).

## Fix

1. **Python hook**: For regular PermissionRequest, half-close the write side (`sock.shutdown(SHUT_WR)`) before `recv()`. This triggers the Node.js `'end'` event while keeping the read side open for the response.
2. **AskUserQuestion special case**: Since AskUserQuestion doesn't need a permission response from Fleet (user responds in terminal), the hook just sends the event and exits immediately without waiting.

## Key Insight

When using Unix domain sockets with a request-response pattern, the server's `'end'` event won't fire until the client closes its write side. If the client needs to both send data AND receive a response, use `shutdown(SHUT_WR)` to half-close after sending.
