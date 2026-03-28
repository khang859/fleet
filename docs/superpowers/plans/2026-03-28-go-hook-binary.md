# Go Hook Binary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python copilot hook script with a compiled Go binary that ships with Fleet, removing the Python dependency.

**Architecture:** A single Go binary (stdlib only) that reads JSON from stdin, sends events over a Unix domain socket, and for permission requests waits for a response. Cross-compiled for darwin/arm64, darwin/amd64, windows/amd64, linux/amd64. Built by a shell script invoked via npm, integrated into CI/CD.

**Tech Stack:** Go 1.22+, shell script for build orchestration, GitHub Actions for CI

---

### Task 1: Create the Go module and source

**Files:**
- Create: `hooks/fleet-copilot-go/go.mod`
- Create: `hooks/fleet-copilot-go/main.go`

- [ ] **Step 1: Create go.mod**

```
module github.com/khang859/fleet/hooks/fleet-copilot-go

go 1.22
```

- [ ] **Step 2: Write main.go**

Port the Python script logic 1:1. The binary must:
- Check `FLEET_SESSION` env var, exit 0 if unset
- Read JSON from stdin
- Get parent PID and its TTY (via `ps -p <ppid> -o tty=`)
- Build a state object with `session_id`, `cwd`, `event`, `pid`, `tty`
- Set `status` based on event type (identical mapping to Python):
  - `UserPromptSubmit` → `processing`
  - `PreToolUse` → `running_tool` (include `tool`, `tool_input`, `tool_use_id`)
  - `PostToolUse` → `processing` (include `tool`, `tool_input`, `tool_use_id`)
  - `PermissionRequest` → `waiting_for_approval` (include `tool`, `tool_input`, `tool_use_id`; if tool is `AskUserQuestion`, send event and exit)
  - `Notification` → `waiting_for_input` if `idle_prompt`, `notification` otherwise (skip `permission_prompt`); include `notification_type`, `message`
  - `Stop` / `SubagentStop` → `waiting_for_input`
  - `SessionStart` → `waiting_for_input`
  - `SessionEnd` → `ended`
  - `PreCompact` → `compacting`
  - default → `unknown`
- For `PermissionRequest` (non-AskUserQuestion): connect to socket, send JSON, shutdown write side, read response (5 min timeout), print decision JSON to stdout
- For all other events: connect, send JSON, close
- Socket path: `/tmp/fleet-copilot.sock`

```go
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

const (
	socketPath     = "/tmp/fleet-copilot.sock"
	timeoutSeconds = 300
)

type HookInput struct {
	SessionID        string                 `json:"session_id"`
	HookEventName    string                 `json:"hook_event_name"`
	CWD              string                 `json:"cwd"`
	ToolName         string                 `json:"tool_name,omitempty"`
	ToolInput        map[string]interface{} `json:"tool_input,omitempty"`
	ToolUseID        string                 `json:"tool_use_id,omitempty"`
	NotificationType string                 `json:"notification_type,omitempty"`
	Message          string                 `json:"message,omitempty"`
}

type State struct {
	SessionID        string                 `json:"session_id"`
	CWD              string                 `json:"cwd"`
	Event            string                 `json:"event"`
	PID              int                    `json:"pid"`
	TTY              *string                `json:"tty"`
	Status           string                 `json:"status,omitempty"`
	Tool             string                 `json:"tool,omitempty"`
	ToolInput        map[string]interface{} `json:"tool_input,omitempty"`
	ToolUseID        string                 `json:"tool_use_id,omitempty"`
	NotificationType string                 `json:"notification_type,omitempty"`
	Message          string                 `json:"message,omitempty"`
}

type PermissionDecision struct {
	HookSpecificOutput struct {
		HookEventName string `json:"hookEventName"`
		Decision      struct {
			Behavior string `json:"behavior"`
			Message  string `json:"message,omitempty"`
		} `json:"decision"`
	} `json:"hookSpecificOutput"`
}

type SocketResponse struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}

func getTTY() *string {
	if runtime.GOOS == "windows" {
		return nil
	}
	ppid := os.Getppid()
	cmd := exec.Command("ps", "-p", fmt.Sprintf("%d", ppid), "-o", "tty=")
	out, err := cmd.Output()
	if err == nil {
		tty := strings.TrimSpace(string(out))
		if tty != "" && tty != "??" && tty != "-" {
			if !strings.HasPrefix(tty, "/dev/") {
				tty = "/dev/" + tty
			}
			return &tty
		}
	}
	return nil
}

func sendEvent(state *State, waitForResponse bool) *SocketResponse {
	conn, err := net.DialTimeout("unix", socketPath, 5*time.Second)
	if err != nil {
		return nil
	}

	data, err := json.Marshal(state)
	if err != nil {
		conn.Close()
		return nil
	}

	_, err = conn.Write(data)
	if err != nil {
		conn.Close()
		return nil
	}

	if waitForResponse {
		// Half-close write side so server sees EOF and can process the event
		if uc, ok := conn.(*net.UnixConn); ok {
			uc.CloseWrite()
		}
		conn.SetReadDeadline(time.Now().Add(time.Duration(timeoutSeconds) * time.Second))
		buf := make([]byte, 4096)
		n, err := conn.Read(buf)
		conn.Close()
		if err != nil || n == 0 {
			return nil
		}
		var resp SocketResponse
		if json.Unmarshal(buf[:n], &resp) != nil {
			return nil
		}
		return &resp
	}

	conn.Close()
	return nil
}

func main() {
	if os.Getenv("FLEET_SESSION") == "" {
		os.Exit(0)
	}

	var input HookInput
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		os.Exit(1)
	}

	tty := getTTY()
	state := &State{
		SessionID: input.SessionID,
		CWD:       input.CWD,
		Event:     input.HookEventName,
		PID:       os.Getppid(),
		TTY:       tty,
	}

	switch input.HookEventName {
	case "UserPromptSubmit":
		state.Status = "processing"

	case "PreToolUse":
		state.Status = "running_tool"
		state.Tool = input.ToolName
		state.ToolInput = input.ToolInput
		state.ToolUseID = input.ToolUseID

	case "PostToolUse":
		state.Status = "processing"
		state.Tool = input.ToolName
		state.ToolInput = input.ToolInput
		state.ToolUseID = input.ToolUseID

	case "PermissionRequest":
		state.Status = "waiting_for_approval"
		state.Tool = input.ToolName
		state.ToolInput = input.ToolInput
		state.ToolUseID = input.ToolUseID

		if state.Tool == "AskUserQuestion" {
			sendEvent(state, false)
			os.Exit(0)
		}

		resp := sendEvent(state, true)
		if resp != nil {
			var output PermissionDecision
			output.HookSpecificOutput.HookEventName = "PermissionRequest"

			switch resp.Decision {
			case "allow":
				output.HookSpecificOutput.Decision.Behavior = "allow"
			case "deny":
				output.HookSpecificOutput.Decision.Behavior = "deny"
				msg := resp.Reason
				if msg == "" {
					msg = "Denied by user via Fleet Copilot"
				}
				output.HookSpecificOutput.Decision.Message = msg
			default:
				os.Exit(0)
			}

			result, _ := json.Marshal(output)
			fmt.Println(string(result))
		}
		os.Exit(0)

	case "Notification":
		if input.NotificationType == "permission_prompt" {
			os.Exit(0)
		} else if input.NotificationType == "idle_prompt" {
			state.Status = "waiting_for_input"
		} else {
			state.Status = "notification"
		}
		state.NotificationType = input.NotificationType
		state.Message = input.Message

	case "Stop":
		state.Status = "waiting_for_input"

	case "SubagentStop":
		state.Status = "waiting_for_input"

	case "SessionStart":
		state.Status = "waiting_for_input"

	case "SessionEnd":
		state.Status = "ended"

	case "PreCompact":
		state.Status = "compacting"

	default:
		state.Status = "unknown"
	}

	sendEvent(state, false)
}
```

- [ ] **Step 3: Verify it compiles locally**

Run: `cd hooks/fleet-copilot-go && go build -o /dev/null .`
Expected: exits 0 with no errors

- [ ] **Step 4: Commit**

```bash
git add hooks/fleet-copilot-go/go.mod hooks/fleet-copilot-go/main.go
git commit -m "feat(copilot): add Go source for hook binary"
```

---

### Task 2: Create the build script and npm integration

**Files:**
- Create: `scripts/build-hook.sh`
- Modify: `package.json` (scripts section)

- [ ] **Step 1: Create scripts/build-hook.sh**

```sh
#!/bin/sh
set -e

HOOK_DIR="hooks/fleet-copilot-go"
OUT_DIR="hooks/bin"

mkdir -p "$OUT_DIR"

for target in "darwin/arm64" "darwin/amd64" "windows/amd64" "linux/amd64"; do
  GOOS="${target%/*}"
  GOARCH="${target#*/}"
  OUT="${OUT_DIR}/fleet-copilot-${GOOS}-${GOARCH}"
  if [ "$GOOS" = "windows" ]; then
    OUT="${OUT}.exe"
  fi
  echo "Building ${GOOS}/${GOARCH}..."
  CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" go build -ldflags="-s -w" -o "$OUT" "./${HOOK_DIR}"
done

echo "All hook binaries built in ${OUT_DIR}/"
```

- [ ] **Step 2: Make the script executable**

Run: `chmod +x scripts/build-hook.sh`

- [ ] **Step 3: Add npm script to package.json**

Add to the `"scripts"` section in `package.json`:

```json
"build:hook": "sh scripts/build-hook.sh"
```

- [ ] **Step 4: Run the build and verify binaries**

Run: `npm run build:hook`
Expected: Four binaries in `hooks/bin/`:
- `fleet-copilot-darwin-arm64`
- `fleet-copilot-darwin-amd64`
- `fleet-copilot-windows-amd64.exe`
- `fleet-copilot-linux-amd64`

Verify: `ls -la hooks/bin/`

- [ ] **Step 5: Commit**

```bash
git add scripts/build-hook.sh package.json
git commit -m "feat(copilot): add hook binary build script and npm integration"
```

---

### Task 3: Update .gitignore and electron-builder.yml

**Files:**
- Modify: `.gitignore`
- Modify: `electron-builder.yml`

- [ ] **Step 1: Add hooks/bin/ to .gitignore**

Append to `.gitignore`:

```
hooks/bin/
```

- [ ] **Step 2: Update electron-builder.yml extraResources**

Change the `extraResources` section from:

```yaml
extraResources:
  - from: hooks/
    to: hooks/
```

to:

```yaml
extraResources:
  - from: hooks/bin/
    to: hooks/
```

This ships only the compiled binaries (not the Go source or Python script) into the app's `resources/hooks/` directory.

- [ ] **Step 3: Commit**

```bash
git add .gitignore electron-builder.yml
git commit -m "chore: gitignore hook binaries, ship only bin/ in extraResources"
```

---

### Task 4: Update hook-installer.ts

**Files:**
- Modify: `src/main/copilot/hook-installer.ts`

- [ ] **Step 1: Replace hook-installer.ts**

Replace the full content of `src/main/copilot/hook-installer.ts`. Key changes:
- Remove `detectPython()` and `makeHookCommand()` — no interpreter needed
- Add `getHookBinaryName()` that returns the platform+arch-specific binary filename
- The hook command in settings.json is now just the absolute path to the binary in `~/.claude/hooks/`
- `getHookScriptSourcePath()` becomes `getHookBinarySourcePath()` looking in `hooks/bin/` (dev) or `process.resourcesPath/hooks/` (prod)

```typescript
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '../logger';

const log = createLogger('copilot:hooks');

const CLAUDE_DIR = join(homedir(), '.claude');
const HOOKS_DIR = join(CLAUDE_DIR, 'hooks');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');

// Old Python script name — used for cleanup during migration
const LEGACY_SCRIPT_NAME = 'fleet-copilot.py';

function getHookBinaryName(): string {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  let arch: string;
  switch (process.arch) {
    case 'arm64':
      arch = 'arm64';
      break;
    case 'x64':
    default:
      arch = 'amd64';
      break;
  }
  const name = `fleet-copilot-${platform}-${arch}`;
  return platform === 'windows' ? `${name}.exe` : name;
}

const HOOK_BINARY_NAME = getHookBinaryName();
const HOOK_DEST = join(HOOKS_DIR, HOOK_BINARY_NAME);

type HookEntry = {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
};

type ClaudeSettings = {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
};

function buildHookEntries(command: string): Record<string, HookEntry[]> {
  const simpleHook = (timeout?: number): HookEntry => ({
    hooks: [{ type: 'command', command, ...(timeout != null ? { timeout } : {}) }],
  });

  const matcherHook = (matcher: string, timeout?: number): HookEntry => ({
    matcher,
    hooks: [{ type: 'command', command, ...(timeout != null ? { timeout } : {}) }],
  });

  return {
    UserPromptSubmit: [simpleHook()],
    PreToolUse: [matcherHook('*')],
    PostToolUse: [matcherHook('*')],
    PermissionRequest: [matcherHook('*', 86400)],
    Notification: [matcherHook('*')],
    Stop: [simpleHook()],
    SubagentStop: [simpleHook()],
    SessionStart: [simpleHook()],
    SessionEnd: [simpleHook()],
    PreCompact: [matcherHook('auto'), matcherHook('manual')],
  };
}

function hasFleetHook(entries: HookEntry[]): boolean {
  return entries.some((entry) =>
    entry.hooks.some(
      (h) => h.command.includes(HOOK_BINARY_NAME) || h.command.includes(LEGACY_SCRIPT_NAME)
    )
  );
}

export function getHookBinarySourcePath(): string {
  // Dev: hooks/bin/<binary>
  const devPath = join(process.cwd(), 'hooks', 'bin', HOOK_BINARY_NAME);
  if (existsSync(devPath)) return devPath;

  // Production: resources/hooks/<binary>
  const resourcesPath = join(process.resourcesPath ?? '', 'hooks', HOOK_BINARY_NAME);
  if (existsSync(resourcesPath)) return resourcesPath;

  return devPath; // fallback
}

function removeLegacyHooks(): void {
  // Remove old Python script
  const legacyDest = join(HOOKS_DIR, LEGACY_SCRIPT_NAME);
  if (existsSync(legacyDest)) {
    try {
      unlinkSync(legacyDest);
      log.info('removed legacy Python hook script');
    } catch {
      log.warn('failed to remove legacy hook script');
    }
  }

  // Remove old Python hook entries from settings.json
  if (!existsSync(SETTINGS_PATH)) return;
  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    const hooks = settings.hooks ?? {};
    let changed = false;

    for (const eventName of Object.keys(hooks)) {
      const before = hooks[eventName]?.length ?? 0;
      hooks[eventName] = (hooks[eventName] ?? []).filter(
        (entry) => !entry.hooks.some((h) => h.command.includes(LEGACY_SCRIPT_NAME))
      );
      if ((hooks[eventName]?.length ?? 0) < before) changed = true;
      if (hooks[eventName]?.length === 0) {
        delete hooks[eventName];
      }
    }

    if (changed) {
      settings.hooks = hooks;
      writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
      log.info('removed legacy Python hook entries from settings.json');
    }
  } catch {
    log.warn('failed to clean legacy hook entries');
  }
}

export function syncScript(): void {
  if (!existsSync(HOOKS_DIR)) mkdirSync(HOOKS_DIR, { recursive: true });

  const source = getHookBinarySourcePath();
  if (!existsSync(source)) return;

  if (existsSync(HOOK_DEST)) {
    const srcContent = readFileSync(source);
    const destContent = readFileSync(HOOK_DEST);
    if (srcContent.equals(destContent)) return;
  }

  copyFileSync(source, HOOK_DEST);
  chmodSync(HOOK_DEST, 0o755);
  log.info('hook binary synced', { dest: HOOK_DEST });
}

export function isInstalled(): boolean {
  if (!existsSync(HOOK_DEST)) return false;
  if (!existsSync(SETTINGS_PATH)) return false;

  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    const hooks = settings.hooks ?? {};
    return 'SessionStart' in hooks && hasFleetHook(hooks['SessionStart'] ?? []);
  } catch {
    return false;
  }
}

export function install(): void {
  log.info('installing hooks');

  // Clean up legacy Python hooks first
  removeLegacyHooks();

  if (!existsSync(HOOKS_DIR)) mkdirSync(HOOKS_DIR, { recursive: true });

  const source = getHookBinarySourcePath();
  if (!existsSync(source)) {
    log.error('hook binary source not found', { source });
    throw new Error(`Hook binary not found: ${source}`);
  }
  copyFileSync(source, HOOK_DEST);
  chmodSync(HOOK_DEST, 0o755);
  log.info('hook binary installed', { dest: HOOK_DEST });

  let settings: ClaudeSettings = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    } catch {
      log.warn('failed to parse existing settings.json, starting fresh');
    }
  }

  const command = HOOK_DEST;
  const newEntries = buildHookEntries(command);

  const existingHooks = settings.hooks ?? {};

  for (const [eventName, entries] of Object.entries(newEntries)) {
    const existing = existingHooks[eventName] ?? [];
    if (!hasFleetHook(existing)) {
      existingHooks[eventName] = [...existing, ...entries];
    }
  }

  settings.hooks = existingHooks;
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  log.info('settings.json updated');
}

export function uninstall(): void {
  log.info('uninstalling hooks');

  if (existsSync(HOOK_DEST)) {
    try {
      unlinkSync(HOOK_DEST);
    } catch {
      log.warn('failed to remove hook binary');
    }
  }

  // Also clean up legacy Python script if present
  const legacyDest = join(HOOKS_DIR, LEGACY_SCRIPT_NAME);
  if (existsSync(legacyDest)) {
    try {
      unlinkSync(legacyDest);
    } catch {
      // ignore
    }
  }

  if (!existsSync(SETTINGS_PATH)) return;

  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    const hooks = settings.hooks ?? {};

    for (const eventName of Object.keys(hooks)) {
      hooks[eventName] = (hooks[eventName] ?? []).filter(
        (entry) =>
          !entry.hooks.some(
            (h) => h.command.includes(HOOK_BINARY_NAME) || h.command.includes(LEGACY_SCRIPT_NAME)
          )
      );
      if (hooks[eventName].length === 0) {
        delete hooks[eventName];
      }
    }

    settings.hooks = hooks;
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    log.info('settings.json cleaned');
  } catch {
    log.warn('failed to clean settings.json');
  }
}
```

Note: The `getHookScriptSourcePath` export has been renamed to `getHookBinarySourcePath`. Check if it's imported elsewhere:

Run: `grep -r "getHookScriptSourcePath" src/`

If any imports exist, update them to `getHookBinarySourcePath`.

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0

- [ ] **Step 3: Commit**

```bash
git add src/main/copilot/hook-installer.ts
git commit -m "feat(copilot): switch hook-installer to use Go binary instead of Python"
```

---

### Task 5: Delete the Python script

**Files:**
- Delete: `hooks/fleet-copilot.py`

- [ ] **Step 1: Remove the Python script**

Run: `rm hooks/fleet-copilot.py`

- [ ] **Step 2: Verify no other files reference fleet-copilot.py directly (beyond the legacy cleanup code)**

Run: `grep -r "fleet-copilot.py" src/ --include="*.ts" | grep -v LEGACY_SCRIPT_NAME | grep -v "legacy"`

Expected: no results (the only references should be the `LEGACY_SCRIPT_NAME` constant in hook-installer.ts)

- [ ] **Step 3: Commit**

```bash
git rm hooks/fleet-copilot.py
git commit -m "chore(copilot): remove Python hook script, replaced by Go binary"
```

---

### Task 6: Update CI workflow — ci.yml

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add Go setup and hook build to ci.yml**

Insert after the `npm ci` step and before `npm rebuild better-sqlite3`:

```yaml
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - name: Build hook binary
        run: npm run build:hook
```

The full file should be:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - run: npm ci
      - run: npm rebuild better-sqlite3
      - name: Build hook binary
        run: npm run build:hook
      - name: Type check
        run: npx tsc --noEmit
      - name: Run tests
        run: npm test
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add Go setup and hook binary build to CI"
```

---

### Task 7: Update release workflow — release.yml

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add Go setup and hook build to each release job**

Add `actions/setup-go@v5` and `npm run build:hook` to each of the four release jobs, after `npm ci` and before `electron-vite build`.

**release-mac-arm64** — insert after `npm ci` (line 35), before the `Rebuild native Electron deps` step:

```yaml
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - name: Build hook binary
        run: npm run build:hook
```

**release-mac-x64** — same insertion point (after `npm ci`, before `Rebuild native Electron deps`):

```yaml
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - name: Build hook binary
        run: npm run build:hook
```

**release-win** — insert after `npm ci`, before the `Extract release notes config` step:

```yaml
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - name: Build hook binary
        run: sh scripts/build-hook.sh
        shell: bash
```

Note: On Windows we use `shell: bash` (Git Bash) to run the shell script, and call the script directly instead of via npm to avoid shell quoting issues.

**release-linux** — insert after `npm ci`, before `Extract release notes config`:

```yaml
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - name: Build hook binary
        run: npm run build:hook
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add Go hook binary build to all release jobs"
```

---

### Task 8: Local build verification

- [ ] **Step 1: Clean build from scratch**

Run: `rm -rf hooks/bin && npm run build:hook`
Expected: Four binaries in `hooks/bin/`

- [ ] **Step 2: Verify the local binary runs correctly**

Run: `echo '{}' | FLEET_SESSION= hooks/bin/fleet-copilot-darwin-arm64`
Expected: exits 0 immediately (no FLEET_SESSION set)

Run: `echo '{"session_id":"test","hook_event_name":"SessionStart","cwd":"/tmp"}' | FLEET_SESSION=1 hooks/bin/fleet-copilot-darwin-arm64`
Expected: exits 0 (will fail to connect to socket, which is fine — it silently exits)

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 5: Final commit if any fixes were needed**

Only commit if changes were made during verification.
