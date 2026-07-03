# Auto-inject Fleet Skill into Claude Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude Code running inside Fleet automatically learn about the `fleet` CLI via a SessionStart hook, and remove the manual "Inject Fleet Skills" button.

**Architecture:** Fleet already installs a native Go hook binary (`fleet-copilot`) into `~/.claude/hooks/` registered for `SessionStart`, and every Fleet PTY carries `FLEET_SESSION=1` (the binary exits early when it is unset). We make the binary print a `hookSpecificOutput.additionalContext` pointer to stdout on `SessionStart` (Claude Code injects it into the session), then delete the renderer-side manual paste path entirely.

**Tech Stack:** Go (hook binary), TypeScript + React (Electron renderer), Vitest/ESLint/tsc for verification.

## Global Constraints

- No em dashes in any code, comment, or copy. Use a plain dash `-`.
- The injected pointer must reference the skill file by **absolute path** (resolved via the binary's `homeDir()`), never a literal `~`.
- The Go change is **additive**: do not alter existing event forwarding (`sendEvent`) or any other hook case.
- Injection is **unconditional** on `SessionStart` (all sources: startup, resume, clear, compact) - no `source`-gating and no need to read the `source` field.
- The skill file stays installed at `~/.fleet/skills/fleet.md` by `installSkillFile()` - do not touch that path.
- `hooks/bin/` is gitignored; do not attempt to commit built binaries. Commit only Go source.

---

### Task 1: SessionStart hook emits the Fleet skill pointer

**Files:**
- Modify: `hooks/fleet-copilot-go/main.go`
- Test: `hooks/fleet-copilot-go/main_test.go`

**Interfaces:**
- Consumes: existing `homeDir() string` helper (`main.go:30-35`).
- Produces: `emitSessionStartContext(w io.Writer)` - writes one line of JSON `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}` to `w`, where `additionalContext` embeds the absolute path `<home>/.fleet/skills/fleet.md`.

- [ ] **Step 1: Write the failing test**

Replace the entire `import` block at the top of `hooks/fleet-copilot-go/main_test.go` (adds `"bytes"` and `"strings"`, kept in gofmt sort order):

```go
import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)
```

Append this test to the end of `hooks/fleet-copilot-go/main_test.go`:

```go
func TestEmitSessionStartContext(t *testing.T) {
	var buf bytes.Buffer
	emitSessionStartContext(&buf)

	var out SessionStartOutput
	if err := json.Unmarshal(buf.Bytes(), &out); err != nil {
		t.Fatalf("output is not valid JSON: %v\noutput was: %q", err, buf.String())
	}
	if out.HookSpecificOutput.HookEventName != "SessionStart" {
		t.Errorf("expected hookEventName SessionStart, got %q", out.HookSpecificOutput.HookEventName)
	}
	if out.HookSpecificOutput.AdditionalContext == "" {
		t.Error("expected non-empty additionalContext")
	}
	wantPath := filepath.Join(homeDir(), ".fleet", "skills", "fleet.md")
	if !strings.Contains(out.HookSpecificOutput.AdditionalContext, wantPath) {
		t.Errorf("expected additionalContext to contain skill path %q, got %q",
			wantPath, out.HookSpecificOutput.AdditionalContext)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hooks/fleet-copilot-go && go test -run TestEmitSessionStartContext ./...`
Expected: build/compile failure - `undefined: emitSessionStartContext` and `undefined: SessionStartOutput`.

- [ ] **Step 3: Implement the struct, constant, and helper**

In `hooks/fleet-copilot-go/main.go`, add the following immediately after the `SocketResponse` struct (which ends at line 75, just before `func getTTY()`):

```go
const fleetSkillContextTemplate = "You're running inside Fleet. A `fleet` CLI is available (open files/images in Fleet tabs, annotate web pages, generate/edit AI images). Read %s for the full command reference before using it."

type SessionStartOutput struct {
	HookSpecificOutput struct {
		HookEventName     string `json:"hookEventName"`
		AdditionalContext string `json:"additionalContext"`
	} `json:"hookSpecificOutput"`
}

// emitSessionStartContext writes the Fleet skill pointer as SessionStart hook
// output. Claude Code reads this JSON from stdout and injects additionalContext
// into the session. The skill path is absolute (via homeDir) so Claude's Read
// tool can open it on any platform.
func emitSessionStartContext(w io.Writer) {
	skillPath := filepath.Join(homeDir(), ".fleet", "skills", "fleet.md")
	var out SessionStartOutput
	out.HookSpecificOutput.HookEventName = "SessionStart"
	out.HookSpecificOutput.AdditionalContext = fmt.Sprintf(fleetSkillContextTemplate, skillPath)
	data, err := json.Marshal(out)
	if err != nil {
		return
	}
	fmt.Fprintln(w, string(data))
}
```

All imports used (`io`, `filepath`, `fmt`, `encoding/json`) are already present in `main.go`.

- [ ] **Step 4: Wire the helper into the SessionStart case**

In `hooks/fleet-copilot-go/main.go`, change the `SessionStart` case (currently lines 229-230):

```go
	case "SessionStart":
		state.Status = "waiting_for_input"
```

to:

```go
	case "SessionStart":
		state.Status = "waiting_for_input"
		emitSessionStartContext(os.Stdout)
```

Do not add `os.Exit` here - the case must still fall through to the bottom `sendEvent(state, false)` so the pane-status event is still forwarded to Fleet.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd hooks/fleet-copilot-go && go test ./...`
Expected: PASS for all tests, including `TestEmitSessionStartContext` and the existing `TestStatusMapping` (which already covers `SessionStart -> waiting_for_input`, so no change needed there).

- [ ] **Step 6: Rebuild the hook binaries**

Run: `npm run build:hook`
Expected: `Building darwin/arm64...` through `Building linux/amd64...` then `All hook binaries built in .../hooks/bin/`. These land in the gitignored `hooks/bin/` and are picked up by the dev app on next launch; do not stage them.

- [ ] **Step 7: Commit**

```bash
git add hooks/fleet-copilot-go/main.go hooks/fleet-copilot-go/main_test.go
git commit -m "feat(copilot): inject Fleet skill pointer on Claude Code SessionStart"
```

---

### Task 2: Remove the manual "Inject Fleet Skills" path

**Files:**
- Delete: `src/renderer/src/lib/fleet-skill-prompt.ts`
- Modify: `src/renderer/src/components/PaneToolbar.tsx`
- Modify: `src/renderer/src/components/TerminalPane.tsx`
- Modify: `src/renderer/src/components/PiTab.tsx`
- Modify: `src/renderer/src/lib/commands.ts`
- Modify: `src/renderer/src/lib/shortcuts.ts`
- Modify: `src/renderer/src/hooks/use-pane-navigation.ts`

**Interfaces:**
- Consumes: nothing new (pure removal).
- Produces: `PaneToolbar` no longer accepts an `onInjectSkills` prop; the `inject-skills` shortcut and command no longer exist; `fleet-skill-prompt.ts` and `getFleetSkillContentInput` are gone.

- [ ] **Step 1: Delete the helper module**

```bash
git rm src/renderer/src/lib/fleet-skill-prompt.ts
```

- [ ] **Step 2: Remove the toolbar button, prop, and unused import in `PaneToolbar.tsx`**

Remove `BookOpen,` from the lucide-react import block (line 9):

```
  BookOpen,
```

Remove the prop from `PaneToolbarProps` (line 66):

```
  onInjectSkills?: () => void;
```

Remove `onInjectSkills,` from the destructured parameters (line 83):

```
  onInjectSkills,
```

Remove the entire button block (lines 165-178):

```tsx
        {onInjectSkills && (
          <ToolbarTooltip label={`Inject Fleet Skills (${shortcutLabel('inject-skills')})`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onInjectSkills();
              }}
              className={BUTTON_CLASS}
              aria-label="Inject Fleet skills"
            >
              <BookOpen size={14} />
            </button>
          </ToolbarTooltip>
        )}
```

- [ ] **Step 3: Remove the wiring and import in `TerminalPane.tsx`**

Remove the import (line 11):

```tsx
import { getFleetSkillContentInput } from '../lib/fleet-skill-prompt';
```

Remove the `onInjectSkills` prop wiring passed to `<PaneToolbar>` (lines 166-171):

```tsx
        onInjectSkills={() => {
          void getFleetSkillContentInput().then((data) => {
            window.fleet.pty.input({ paneId, data });
          });
          focus();
        }}
```

- [ ] **Step 4: Remove the wiring and import in `PiTab.tsx`**

Remove the import (line 8):

```tsx
import { getFleetSkillContentInput } from '../lib/fleet-skill-prompt';
```

Remove the `onInjectSkills` prop wiring passed to `<PaneToolbar>` (lines 181-186):

```tsx
        onInjectSkills={() => {
          void getFleetSkillContentInput().then((data) => {
            window.fleet.pty.input({ paneId, data });
          });
          focus();
        }}
```

- [ ] **Step 5: Remove the command-palette entry and import in `commands.ts`**

Remove the import (line 2):

```ts
import { getFleetSkillContentInput } from './fleet-skill-prompt';
```

Remove the command object (lines 151-164):

```ts
    {
      id: 'inject-skills',
      label: 'Inject Fleet Skills',
      shortcut: sc('inject-skills'),
      category: 'Agent',
      execute: () => {
        const { activePaneId } = useWorkspaceStore.getState();
        if (activePaneId) {
          void getFleetSkillContentInput().then((data) => {
            window.fleet.pty.input({ paneId: activePaneId, data });
          });
        }
      }
    },
```

- [ ] **Step 6: Remove the keybinding in `shortcuts.ts`**

Remove the shortcut object (lines 142-147):

```ts
  {
    id: 'inject-skills',
    label: 'Inject Fleet Skills',
    mac: { key: '.', meta: true, shift: true },
    other: { key: '.', ctrl: true, shift: true }
  },
```

- [ ] **Step 7: Remove the keydown handler and import in `use-pane-navigation.ts`**

Remove the import (line 5):

```ts
import { getFleetSkillContentInput } from '../lib/fleet-skill-prompt';
```

Remove the keydown handler block (lines 188-196):

```ts
      if (matchesShortcut(e, sc('inject-skills'))) {
        e.preventDefault();
        if (activePaneId) {
          void getFleetSkillContentInput().then((data) => {
            window.fleet.pty.input({ paneId: activePaneId, data });
          });
        }
        return;
      }
```

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both pass. In particular there must be no "unused import", "unused variable", or "cannot find module './fleet-skill-prompt'" errors. If lint reports `activePaneId` newly unused in `use-pane-navigation.ts`, confirm it is still used elsewhere in the hook (it is used by other shortcut handlers) and leave it.

- [ ] **Step 9: Run the shortcuts/palette test**

Run: `npx vitest run src/renderer/src/lib/__tests__/shortcuts-palette.test.ts`
Expected: PASS. This test checks for Cmd+K clashes and does not reference `inject-skills`; removing the shortcut must not break it.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(pane): remove manual Inject Fleet Skills path (now auto via hook)"
```

---

### Task 3: End-to-end verification

**Files:** none (manual verification via the running dev app).

**Interfaces:**
- Consumes: the built hook binary from Task 1 (`hooks/bin/`) and the renderer changes from Task 2.
- Produces: confirmation that auto-injection works and the manual affordances are gone.

- [ ] **Step 1: Restart the dev app so the new binary is installed**

The copy at `~/.claude/hooks/` only refreshes when `syncScript()` runs at app launch. If `npm run dev` is already running, stop it. Then run: `npm run dev`
Expected: app launches; `hook-installer` copies the freshly built binary into `~/.claude/hooks/`.

- [ ] **Step 2: Verify the injected context in a Claude Code pane**

In a Fleet terminal pane, run `claude` and start a session. Then confirm the agent has the Fleet context with no manual action - for example ask it: "Do you have a fleet CLI available?" It should reference reading `~/.fleet/skills/fleet.md` / the Fleet CLI.

Alternative fast check without a live model: run
`FLEET_SESSION=1 printf '{"session_id":"x","hook_event_name":"SessionStart","cwd":"/tmp","source":"startup"}' | ~/.claude/hooks/fleet-copilot-darwin-arm64`
(substitute your platform binary name). Expected stdout: a single JSON line containing `"hookEventName":"SessionStart"` and an `additionalContext` mentioning the absolute `.fleet/skills/fleet.md` path.

- [ ] **Step 3: Verify the manual affordances are gone**

Use `npm run drive -- screenshot` (or interact directly) to confirm:
- The pane toolbar no longer shows the BookOpen "Inject Fleet Skills" button.
- `Cmd+Shift+.` does nothing (no paste into the pane).
- The command palette (`Cmd+K`) has no "Inject Fleet Skills" entry.

- [ ] **Step 4: Final full check**

Run: `npm run typecheck && npm run lint && (cd hooks/fleet-copilot-go && go test ./...)`
Expected: all pass. No commit needed for this task (verification only).
