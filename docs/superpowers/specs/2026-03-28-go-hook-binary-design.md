# Go Hook Binary Design

**Date:** 2026-03-28
**Status:** Approved

## Problem

The Fleet Copilot hook (`fleet-copilot.py`) requires Python 3 to be installed on the user's machine. This is an unnecessary external dependency that can cause installation failures or confusing errors when Python is missing.

## Solution

Replace the Python hook script with a compiled Go binary that ships inside the Electron app. Go produces static binaries with zero runtime dependencies and trivial cross-compilation.

## Directory Structure

```
hooks/
  fleet-copilot.py              # deleted
  fleet-copilot-go/
    main.go                     # Go source (stdlib only, no external deps)
    go.mod                      # module definition
  bin/                          # build output (gitignored)
    fleet-copilot-darwin-arm64
    fleet-copilot-darwin-amd64
    fleet-copilot-windows-amd64.exe
    fleet-copilot-linux-amd64
```

## Build Targets

| Platform      | Binary Name                        | GOOS/GOARCH    |
|---------------|------------------------------------|----------------|
| macOS arm64   | `fleet-copilot-darwin-arm64`       | darwin/arm64   |
| macOS x64     | `fleet-copilot-darwin-amd64`       | darwin/amd64   |
| Windows x64   | `fleet-copilot-windows-amd64.exe`  | windows/amd64  |
| Linux x64     | `fleet-copilot-linux-amd64`        | linux/amd64    |

## Go Binary Behavior

Identical to the current Python script:

1. Check `FLEET_SESSION` env var — exit 0 if not set
2. Read JSON from stdin (Claude Code hook payload)
3. Determine event type and build state object with: `session_id`, `cwd`, `event`, `pid` (parent), `tty` (parent's TTY)
4. Set status based on event type (same mapping as Python)
5. Connect to Unix socket at `/tmp/fleet-copilot.sock`
6. Send JSON state
7. For `PermissionRequest` (except `AskUserQuestion`): half-close write side, wait for response with 5-minute timeout, print JSON decision to stdout
8. For all other events: send and close

Uses only Go stdlib: `encoding/json`, `net`, `os`, `os/exec`, `fmt`, `strings`, `syscall`.

## Build Script

`scripts/build-hook.sh` — cross-compiles all targets:

```sh
#!/bin/sh
set -e
cd hooks/fleet-copilot-go
for target in "darwin/arm64" "darwin/amd64" "windows/amd64" "linux/amd64"; do
  GOOS="${target%/*}" GOARCH="${target#*/}"
  OUT="../bin/fleet-copilot-${GOOS}-${GOARCH}"
  [ "$GOOS" = "windows" ] && OUT="${OUT}.exe"
  CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" go build -ldflags="-s -w" -o "$OUT" .
done
```

npm script: `"build:hook": "sh scripts/build-hook.sh"`

## CI Changes

### ci.yml

Add before the typecheck step:

```yaml
- uses: actions/setup-go@v5
  with:
    go-version: '1.22'
- run: npm run build:hook
```

### release.yml

Add `actions/setup-go` + `npm run build:hook` to each release job (mac-arm64, mac-x64, win, linux) before the `electron-vite build` step.

## electron-builder.yml Changes

Change `extraResources` to only ship the correct platform binary:

```yaml
extraResources:
  - from: hooks/bin/
    to: hooks/
    filter:
      - fleet-copilot-${os}-*
```

Note: electron-builder supports `${os}` and `${arch}` variables in extraResources filters.

## hook-installer.ts Changes

- Delete `detectPython()` function
- Delete `makeHookCommand()` — command is now just the binary path
- Change `HOOK_SCRIPT_NAME` to a function that returns the platform-specific binary name:
  - `fleet-copilot-darwin-arm64` / `fleet-copilot-darwin-amd64` on macOS
  - `fleet-copilot-windows-amd64.exe` on Windows
  - `fleet-copilot-linux-amd64` on Linux
- Use `process.platform` and `process.arch` to select the correct binary
- `getHookScriptSourcePath()` looks in `hooks/bin/` (dev) or `process.resourcesPath/hooks/` (production)
- Hook command in settings.json becomes just the absolute path to the binary (no interpreter prefix)

## .gitignore

Add `hooks/bin/` to prevent committing compiled binaries.

## What Does Not Change

- Unix socket protocol and JSON format
- `socket-server.ts` — no modifications
- Hook registration structure in `settings.json`
- All IPC handlers and session store logic
- The copilot UI
