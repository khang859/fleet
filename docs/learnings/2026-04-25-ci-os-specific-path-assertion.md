# CI OS-specific path assertion

## What happened

CI failed on `pi-agent-manager.test.ts` because a launch-command assertion expected the quoted agent binary path to contain `'/Users/`. That passed on macOS but failed on the Linux GitHub runner, where `os.homedir()` resolves to `/home/runner`.

## Fix

Assert against `posixShellQuote(mgr.getBinPath())` instead of a hard-coded platform-specific path prefix. This keeps the test focused on the intended behavior: command paths are shell-quoted.

## Prevention

Avoid hard-coding OS-specific home directory prefixes in cross-platform tests. When testing derived paths, assert against the same public path-building API or use platform-neutral path properties.
