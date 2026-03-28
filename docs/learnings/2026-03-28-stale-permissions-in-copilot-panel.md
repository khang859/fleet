# Stale Permissions in Copilot Sessions Panel

## Problem

The Claude Sessions panel showed Allow/Deny permission buttons even after the permissions had already been approved in the terminal window.

## Root Cause

Two issues:

1. **No socket close cleanup**: When the hook process exits (user approved in terminal, timeout, etc.), the Unix socket closes but `socket-server.ts` had no `close` handler. The pending permission was never removed from the session store, so it persisted in the UI forever.

2. **Missing `tool_use_id` in PermissionRequest hook**: The Python hook (`fleet-copilot.py`) didn't forward `tool_use_id` for `PermissionRequest` events (only `PreToolUse` and `PostToolUse` did). If the cache lookup in `session-store.ts` failed to match, permissions were stored with `unknown-${timestamp}` IDs. When `PostToolUse` later fired with the real `tool_use_id`, it couldn't match and clear the stale permission.

## Fix

1. Added `client.on('close')` handler in `socket-server.ts` that finds and removes any pending permission associated with the closed socket.
2. Added `tool_use_id` extraction in `fleet-copilot.py` for `PermissionRequest` events, matching the pattern used by `PreToolUse` and `PostToolUse`.
