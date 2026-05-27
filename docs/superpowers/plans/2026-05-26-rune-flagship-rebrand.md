# Rune as Flagship Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Pi with Rune as Fleet's flagship coding agent in marketing, Dashboard, CLI, and Settings — without removing any Pi code.

**Architecture:** Add a parallel `rune.*` IPC surface that mirrors the existing `pi.*` surface (socket command → renderer event → workspace store action). Rune runs inside a plain terminal tab whose leaf carries an `initialCmd` field; no Rune-specific tab component is needed. A new lightweight Settings section points users at Rune's own configuration TUI.

**Tech Stack:** Electron + electron-vite + React + TypeScript, xterm.js + node-pty, shadcn/ui + Tailwind, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-26-rune-flagship-rebrand-design.md`

---

## File Structure

**New files:**
- `src/renderer/src/components/settings/rune/RuneSection.tsx` — Rune Settings page.

**Modified files:**
- `src/shared/ipc-channels.ts` — new `RUNE_*` channel names.
- `src/shared/ipc-api.ts` — new `RuneOpenPayload` type.
- `src/shared/types.ts` — add `initialCmd?: string` to `PaneLeaf`.
- `src/main/socket-server.ts` — handle `rune.open` socket command.
- `src/main/socket-supervisor.ts` — re-emit `rune-open` event.
- `src/main/index.ts` — forward `rune-open` to renderer.
- `src/main/ipc-handlers.ts` — `rune.getVersion`, `rune.openSkillsDir` handlers.
- `src/main/fleet-cli.ts` — `fleet rune` CLI group.
- `src/main/__tests__/fleet-cli.test.ts` — tests for `fleet rune`.
- `src/main/__tests__/socket-server.test.ts` — test for `rune.open` (or create if absent).
- `src/preload/index.ts` — expose `window.fleet.rune`.
- `src/renderer/src/components/PaneGrid.tsx` — pass `initialCmd` to `TerminalPane`.
- `src/renderer/src/components/TerminalPane.tsx` — accept and forward `initialCmd`.
- `src/renderer/src/components/Dashboard.tsx` — "Start Rune" CTA.
- `src/renderer/src/components/settings/SettingsNav.tsx` — add Rune entry, relabel Pi.
- `src/renderer/src/components/settings/SettingsTab.tsx` — route `'rune'` to new section.
- `src/renderer/src/App.tsx` — Dashboard prop, `rune.onOpen` listener.
- `src/renderer/src/store/workspace-store.ts` — `addRuneTab` action.
- `src/renderer/src/store/__tests__/workspace-store.test.ts` — test for `addRuneTab` (or create if absent).
- `README.md` — Rune recommended callout.

---

## Task 1: IPC channels, payload types, preload bindings

**Files:**
- Modify: `src/shared/ipc-channels.ts:115` (insert after Pi block)
- Modify: `src/shared/ipc-api.ts` (insert near `PiOpenPayload`)
- Modify: `src/preload/index.ts:31-34` (imports) and the `pi:` block around line 339 (insert sibling `rune:` block)

- [ ] **Step 1: Add Rune IPC channel constants**

In `src/shared/ipc-channels.ts`, immediately after the closing `PI_*` block (line ~114, after `PI_ENV_IS_ENCRYPTION_AVAILABLE`), add:

```ts
  // Rune Agent
  RUNE_OPEN: 'rune:open',
  RUNE_VERSION: 'rune:version',
  RUNE_OPEN_SKILLS_DIR: 'rune:open-skills-dir',
```

- [ ] **Step 2: Add Rune payload type**

In `src/shared/ipc-api.ts`, immediately after `PiOpenPayload`:

```ts
export type RuneOpenPayload = {
  cwd: string;
  args: string[];
};

export type RuneVersionResponse =
  | { installed: true; version: string }
  | { installed: false };
```

- [ ] **Step 3: Add the `rune` namespace to the preload bridge**

In `src/preload/index.ts`, add `RuneOpenPayload, RuneVersionResponse` to the existing type-only import block from `../shared/ipc-api`.

Then, immediately after the `pi:` block (right after the closing brace at line ~356, before `piConfig:`), add:

```ts
  rune: {
    onOpen: (callback: (payload: RuneOpenPayload) => void): Unsubscribe =>
      onChannel(IPC_CHANNELS.RUNE_OPEN, callback),
    getVersion: async (): Promise<RuneVersionResponse> =>
      typedInvoke(IPC_CHANNELS.RUNE_VERSION),
    openSkillsDir: async (): Promise<void> => typedInvoke(IPC_CHANNELS.RUNE_OPEN_SKILLS_DIR)
  },
```

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: PASS (channels exported, types referenced are defined). No runtime behavior changes yet.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-channels.ts src/shared/ipc-api.ts src/preload/index.ts
git commit -m "feat(rune): add rune IPC channel constants and preload bridge"
```

---

## Task 2: Main-process socket route + main forwarder for `rune.open`

**Files:**
- Modify: `src/main/socket-server.ts:375-380` (add `case 'rune.open'` near `pi.open`)
- Modify: `src/main/socket-supervisor.ts:100-101` (re-emit `rune-open`)
- Modify: `src/main/index.ts:358-362` (forward `rune-open` to renderer over `RUNE_OPEN` channel)
- Test: `src/main/__tests__/socket-server.test.ts` (create if missing, otherwise extend)

- [ ] **Step 1: Write the failing socket-server test**

Append (or create) `src/main/__tests__/socket-server.test.ts` with a test that:

1. Constructs `SocketServer` with a stub `ImageService` and stub `AnnotateService`.
2. Calls the internal command dispatcher with `command: 'rune.open'`, `args: { cwd: '/tmp/foo', args: ['--prompt', 'hi'] }`.
3. Asserts that the server emits `'rune-open'` with `{ cwd: '/tmp/foo', args: ['--prompt', 'hi'] }` and returns `{ ok: true }`.

If a parallel `pi.open` test exists in this file, mirror its structure. If you need to invoke the private handler, follow the pattern already used for the existing `pi.open` case (e.g. by calling the same exported entry point and listening on the EventEmitter API exposed by `SocketServer`).

Example shape (adjust to whatever access patterns the existing file uses):

```ts
import { describe, it, expect, vi } from 'vitest';
import { SocketServer } from '../socket-server';

describe('SocketServer rune.open', () => {
  it('emits rune-open with cwd and args', async () => {
    const server = new SocketServer(/* stub deps */);
    const spy = vi.fn();
    server.on('rune-open', spy);
    const result = await (server as unknown as {
      handle: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
    }).handle('rune.open', { cwd: '/tmp/foo', args: ['--prompt', 'hi'] });
    expect(spy).toHaveBeenCalledWith({ cwd: '/tmp/foo', args: ['--prompt', 'hi'] });
    expect(result).toEqual({ ok: true });
  });

  it('rejects rune.open without cwd', async () => {
    const server = new SocketServer(/* stub deps */);
    await expect(
      (server as unknown as {
        handle: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
      }).handle('rune.open', {})
    ).rejects.toThrow(/cwd/);
  });
});
```

If the existing pi.open test has a different shape, copy that shape instead — the goal is "the test mirrors how the pi.open path is already tested." If no socket-server tests exist at all, copy the `pi.open` case structure into a brand-new file and use the same mocking approach used elsewhere in `src/main/__tests__/`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/socket-server.test.ts`
Expected: FAIL with `Unknown command: rune.open`.

- [ ] **Step 3: Add the `rune.open` case to `socket-server.ts`**

In `src/main/socket-server.ts`, immediately after the `pi.open` case (around line 380), insert:

```ts
      case 'rune.open': {
        const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
        if (!cwd) throw new CodedError('rune.open requires a cwd', 'BAD_REQUEST');
        const rawArgs = args.args;
        const runeArgs = Array.isArray(rawArgs)
          ? rawArgs.filter((a): a is string => typeof a === 'string')
          : [];
        this.emit('rune-open', { cwd, args: runeArgs });
        return { ok: true };
      }
```

- [ ] **Step 4: Re-emit `rune-open` in the supervisor**

In `src/main/socket-supervisor.ts`, immediately after the `'pi-open'` re-emit (around line 101), add:

```ts
    server.on('rune-open', (...args: unknown[]) => {
      this.emit('rune-open', ...args);
    });
```

- [ ] **Step 5: Forward `rune-open` from supervisor to renderer**

In `src/main/index.ts`, immediately after the existing `socketSupervisor.on('pi-open', ...)` block (around line 358-362), add:

```ts
  socketSupervisor.on('rune-open', (payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.RUNE_OPEN, payload);
    }
  });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/socket-server.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/socket-server.ts src/main/socket-supervisor.ts src/main/index.ts src/main/__tests__/socket-server.test.ts
git commit -m "feat(rune): route rune.open socket command to renderer IPC"
```

---

## Task 3: Main-process IPC handlers — `rune.getVersion` and `rune.openSkillsDir`

**Files:**
- Modify: `src/main/ipc-handlers.ts:569-572` (insert after `PI_VERSION` handler)

- [ ] **Step 1: Add `RUNE_VERSION` handler**

In `src/main/ipc-handlers.ts`, immediately after the `PI_VERSION` handler (around lines 569-572), add:

```ts
  ipcMain.handle(IPC_CHANNELS.RUNE_VERSION, async () => {
    const { spawn } = await import('node:child_process');
    return await new Promise<RuneVersionResponse>((resolveVersion) => {
      const child = spawn('rune', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.on('error', () => resolveVersion({ installed: false }));
      child.on('close', (code) => {
        if (code === 0) {
          const version = stdout.trim() || 'unknown';
          resolveVersion({ installed: true, version });
        } else {
          resolveVersion({ installed: false });
        }
      });
    });
  });
```

Add `RuneVersionResponse` to the existing type-only import block at the top of the file (it's already exported from `../shared/ipc-api`).

- [ ] **Step 2: Add `RUNE_OPEN_SKILLS_DIR` handler**

In the same file, immediately after the handler from Step 1, add:

```ts
  ipcMain.handle(IPC_CHANNELS.RUNE_OPEN_SKILLS_DIR, async () => {
    const { shell } = await import('electron');
    const { mkdir } = await import('node:fs/promises');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = join(homedir(), '.rune', 'skills');
    await mkdir(dir, { recursive: true });
    await shell.openPath(dir);
  });
```

If `shell`, `mkdir`, `homedir`, or `join` are already imported at the top of the file, use the existing imports instead of dynamic ones and inline the body without the `await import` calls. Match the file's existing style.

- [ ] **Step 3: Type-check and run existing tests**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx vitest run src/main/__tests__`
Expected: PASS (no new tests added in this task — the handlers wrap `spawn` and `shell.openPath` which are intentionally not unit-tested; they're verified manually below).

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc-handlers.ts
git commit -m "feat(rune): add rune.getVersion and rune.openSkillsDir IPC handlers"
```

---

## Task 4: Add `initialCmd` to `PaneLeaf` and thread it through `PaneGrid` → `TerminalPane`

**Files:**
- Modify: `src/shared/types.ts:43-49` (add `initialCmd?: string` to `PaneLeaf`)
- Modify: `src/renderer/src/components/PaneGrid.tsx:187-199` (pass `initialCmd`)
- Modify: `src/renderer/src/components/TerminalPane.tsx:11-50` (accept and forward prop)

- [ ] **Step 1: Extend the `PaneLeaf` type**

In `src/shared/types.ts`, locate the `PaneLeaf` definition (around line 43). Add a new optional field:

```ts
export type PaneLeaf = {
  type: 'leaf';
  id: string;
  cwd: string;
  // ...existing fields...
  paneType?: 'terminal' | 'file' | 'image' | 'images' | 'pi' | 'markdown';
  /** Command to autorun when this pane's PTY is first created (e.g. "rune"). Ignored on PTY reattach. */
  initialCmd?: string;
};
```

(Preserve every existing field — only add `initialCmd`.)

- [ ] **Step 2: Forward `initialCmd` from `PaneGrid` to `TerminalPane`**

In `src/renderer/src/components/PaneGrid.tsx`, locate the `<TerminalPane>` invocation around lines 187-199. Add `initialCmd={leaf.node.initialCmd}` to the prop list:

```tsx
              <TerminalPane
                paneId={leaf.id}
                cwd={leaf.node.cwd}
                isActive={leaf.id === activePaneId}
                onFocus={() => onPaneFocus(leaf.id)}
                serializedContent={serializedPanes?.get(leaf.id) ?? leaf.node.serializedContent}
                fontFamily={fontFamily}
                fontSize={fontSize}
                onSplitHorizontal={() => splitPane(leaf.id, 'horizontal')}
                onSplitVertical={() => splitPane(leaf.id, 'vertical')}
                onClose={() => closePane(leaf.id)}
                shellProfileId={leaf.node.shellProfileId}
                initialCmd={leaf.node.initialCmd}
              />
```

- [ ] **Step 3: Accept the prop in `TerminalPane`**

In `src/renderer/src/components/TerminalPane.tsx`:

a) Extend `TerminalPaneProps`:

```ts
type TerminalPaneProps = {
  paneId: string;
  cwd: string;
  isActive: boolean;
  onFocus: () => void;
  serializedContent?: string;
  fontFamily?: string;
  fontSize?: number;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onClose?: () => void;
  shellProfileId?: string;
  initialCmd?: string;
};
```

b) Destructure `initialCmd` in the component signature:

```ts
export function TerminalPane({
  paneId,
  cwd,
  isActive,
  onFocus,
  serializedContent,
  fontFamily,
  fontSize,
  onSplitHorizontal,
  onSplitVertical,
  onClose,
  shellProfileId,
  initialCmd
}: TerminalPaneProps): React.JSX.Element {
```

c) Forward it into the `useTerminal` options around line 41-50:

```ts
  const { focus, scrollToBottom, search, searchPrevious, clearSearch } = useTerminal(containerRef, {
    paneId,
    cwd,
    serializedContent,
    isActive,
    fontFamily,
    fontSize,
    workspaceId,
    shellProfileId,
    cmd: initialCmd,
    onScrollStateChange: setIsScrolledUp
    // ...keep any other existing fields in place
  });
```

(`useTerminal` already supports `cmd` per `src/renderer/src/hooks/use-terminal.ts:481`; no change needed there.)

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Smoke-test that existing terminals still work**

Run: `npm run lint`
Expected: PASS.

Run any existing tests touching TerminalPane/PaneGrid/use-terminal:

Run: `npx vitest run src/renderer`
Expected: PASS — `initialCmd` defaults to `undefined`, so existing behavior is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/renderer/src/components/PaneGrid.tsx src/renderer/src/components/TerminalPane.tsx
git commit -m "feat(panes): support initialCmd on PaneLeaf for autostarting commands"
```

---

## Task 5: Workspace store — `addRuneTab` action

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts:143-145` (interface), `355-386` (insert after `addPiTab` impl)
- Test: `src/renderer/src/store/__tests__/workspace-store.test.ts` (create or extend)

- [ ] **Step 1: Write the failing store test**

In `src/renderer/src/store/__tests__/` (create the file if it doesn't exist):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore } from '../workspace-store';

describe('addRuneTab', () => {
  beforeEach(() => {
    useWorkspaceStore.setState((s) => ({
      ...s,
      workspace: { ...s.workspace, tabs: [] },
      activeTabId: null,
      activePaneId: null,
      isDirty: false
    }));
  });

  it('creates a terminal tab whose leaf has initialCmd set to "rune"', () => {
    const paneId = useWorkspaceStore.getState().addRuneTab('/tmp/proj', []);
    const tabs = useWorkspaceStore.getState().workspace.tabs;
    expect(tabs).toHaveLength(1);
    const tab = tabs[0];
    expect(tab.type).toBeUndefined(); // plain terminal tab
    expect(tab.label).toBe('Rune');
    expect(tab.splitRoot.type).toBe('leaf');
    if (tab.splitRoot.type !== 'leaf') throw new Error('expected leaf');
    expect(tab.splitRoot.id).toBe(paneId);
    expect(tab.splitRoot.initialCmd).toBe('rune');
  });

  it('appends args to the initialCmd', () => {
    useWorkspaceStore.getState().addRuneTab('/tmp/proj', ['--prompt', 'hello world']);
    const tab = useWorkspaceStore.getState().workspace.tabs[0];
    if (tab.splitRoot.type !== 'leaf') throw new Error('expected leaf');
    // Args containing spaces should be single-quoted so the shell parses them correctly.
    expect(tab.splitRoot.initialCmd).toBe("rune --prompt 'hello world'");
  });

  it('shell-quotes args containing single quotes', () => {
    useWorkspaceStore.getState().addRuneTab('/tmp/proj', ["it's fine"]);
    const tab = useWorkspaceStore.getState().workspace.tabs[0];
    if (tab.splitRoot.type !== 'leaf') throw new Error('expected leaf');
    expect(tab.splitRoot.initialCmd).toBe("rune 'it'\\''s fine'");
  });
});
```

If an existing store test file uses a different setup helper (e.g. `resetStore()`), follow that pattern instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/store`
Expected: FAIL — `addRuneTab is not a function`.

- [ ] **Step 3: Add `addRuneTab` to the store interface**

In `src/renderer/src/store/workspace-store.ts`, locate the existing `addPiTab` interface declaration (around line 145):

```ts
  addPiTab: (cwd: string) => string;
```

Add immediately after it:

```ts
  addRuneTab: (cwd: string, args: string[]) => string;
```

- [ ] **Step 4: Implement `addRuneTab`**

Locate the existing `addPiTab` implementation (around line 355). Immediately after its closing brace and comma, add:

```ts
  addRuneTab: (cwd, args) => {
    const { id: profileId, pathContext } = resolveDefaultProfile();
    const initialCmd = buildRuneCommand(args);
    const leaf: PaneLeaf = {
      type: 'leaf',
      id: generateId(),
      cwd,
      shellProfileId: profileId,
      pathContext,
      initialCmd
    };
    const tab: Tab = {
      id: generateId(),
      label: 'Rune',
      labelIsCustom: true,
      cwd,
      splitRoot: leaf,
      shellProfileId: profileId,
      pathContext
    };
    logTabs.debug('addRuneTab', { tabId: tab.id, cwd, paneId: leaf.id, initialCmd });
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: [...state.workspace.tabs, tab]
      },
      activeTabId: tab.id,
      activePaneId: leaf.id,
      isDirty: true
    }));
    return leaf.id;
  },
```

- [ ] **Step 5: Add the `buildRuneCommand` helper near the top of the file**

Above the store factory (after the other helpers like `cwdBasename`, near the existing `resolveDefaultProfile` helper), add:

```ts
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./=:@]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function buildRuneCommand(args: string[]): string {
  if (args.length === 0) return 'rune';
  return `rune ${args.map(shellQuote).join(' ')}`;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/store`
Expected: PASS — all three `addRuneTab` tests green.

- [ ] **Step 7: Type-check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts src/renderer/src/store/__tests__/workspace-store.test.ts
git commit -m "feat(rune): add addRuneTab workspace store action"
```

---

## Task 6: App.tsx — Dashboard prop + `rune.onOpen` listener

**Files:**
- Modify: `src/renderer/src/App.tsx:281-289` (insert listener block after Pi listener), `797-803` (Dashboard CTA wiring)

- [ ] **Step 1: Add the `rune.onOpen` subscription**

In `src/renderer/src/App.tsx`, locate the existing Pi-open listener (around lines 281-289 — the `useEffect` that calls `window.fleet.pi.onOpen`). Directly after that `useEffect`, add a parallel block:

```tsx
  // Open Rune agent tab via IPC (fleet rune CLI command, Dashboard CTA)
  useEffect(() => {
    const cleanup = window.fleet.rune.onOpen((payload) => {
      useWorkspaceStore.getState().addRuneTab(payload.cwd, payload.args);
    });
    return cleanup;
  }, []);
```

- [ ] **Step 2: Wire the Dashboard "Start Rune" prop**

In the same file, locate the existing `<Dashboard ... />` render (around lines 797-803). Add `onStartRune` to its props:

```tsx
              <Dashboard
                recentFiles={recentFiles}
                recentFolders={recentFolders}
                onNewTerminal={() => addTab(undefined, '/')}
                onOpenFile={openFile}
                onOpenFolder={(folderPath) => addTab(undefined, folderPath)}
                onStartRune={() => {
                  useWorkspaceStore.getState().addRuneTab(window.fleet.homeDir, []);
                }}
              />
```

`window.fleet.homeDir` is the same accessor used elsewhere in this file (e.g. `App.tsx:260, 331, 335, 471`). The existing `onNewTerminal` line uses `'/'` because "New Terminal" is intentionally cwd-agnostic; for Rune we want the user's home directory as the working tree root.

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: FAIL — `Dashboard` doesn't accept `onStartRune` yet. (This is the next task.) That's expected; do not commit yet.

- [ ] **Step 4: Hold this change for Task 8**

Do not commit. The Dashboard prop must be added first; this change will be committed together with Task 8.

---

## Task 7: `fleet rune` CLI subcommand

**Files:**
- Modify: `src/main/fleet-cli.ts:359` (top-level command table), `397-416` (after the `pi:` help entry), `606-648` (insert a `rune` block after the `pi` block)
- Test: `src/main/__tests__/fleet-cli.test.ts:207+`

- [ ] **Step 1: Write the failing CLI tests**

Open `src/main/__tests__/fleet-cli.test.ts` and append after the existing `fleet pi plan_open` describe block:

```ts
describe('fleet rune', () => {
  it('sends rune.open with cwd and empty args by default', async () => {
    const sendSpy = vi.fn().mockResolvedValue({ ok: true });
    // Use the same mocking pattern this file already uses for `fleet pi`.
    // The structure below assumes runCli + a mocked FleetCLI; adjust to match.
    const out = await runCli(['rune'], { sendSpy });
    expect(sendSpy).toHaveBeenCalledWith(
      'rune.open',
      expect.objectContaining({ cwd: expect.any(String), args: [] })
    );
    expect(out).toMatch(/Opening Rune/);
  });

  it('passes trailing args through to rune', async () => {
    const sendSpy = vi.fn().mockResolvedValue({ ok: true });
    const out = await runCli(['rune', '--prompt', 'fix tests'], { sendSpy });
    expect(sendSpy).toHaveBeenCalledWith(
      'rune.open',
      expect.objectContaining({ args: ['--prompt', 'fix tests'] })
    );
    expect(out).toMatch(/Opening Rune/);
  });

  it('returns a friendly error when Fleet is not running', async () => {
    const sendSpy = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await runCli(['rune'], { sendSpy });
    expect(out).toBe('Fleet is not running');
  });
});
```

If the existing `fleet pi plan_open` tests use different mock helpers (`runCli` may not exist by that name), copy the helper shape used by those tests verbatim and only swap the assertions. The goal is: each new test mirrors the structure of the existing pi tests in this file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts`
Expected: FAIL — `Unknown fleet command: rune` or equivalent.

- [ ] **Step 3: Add the `rune` row to the top-level help table**

In `src/main/fleet-cli.ts`, locate the `HELP_TOP` constant (around lines 354-359). Add a new row to the markdown table right after the `pi` row:

```
| rune | Open Rune coding agent tabs. |
```

- [ ] **Step 4: Add the `rune` help block**

In the same file, locate the `pi:` entry in the `HELP_GROUPS` record (around lines 397-416). Add a new sibling entry directly after it:

```ts
  rune: `# fleet rune

Open a Rune coding agent tab.

## Usage

  fleet rune
  fleet rune [--any-rune-flag ...]

## Description

Opens a new terminal tab in the current directory and launches Rune
(https://github.com/khang859/rune). Trailing arguments are passed through
to the rune binary unchanged.

## Examples

\`\`\`bash
fleet rune
fleet rune --prompt "fix the failing test"
\`\`\``,
```

- [ ] **Step 5: Add the top-level `rune` command branch**

In the same file, locate the `if (group === 'pi') {` block (around lines 606-648). Directly after its closing brace, add:

```ts
  // ── Top-level "rune" command ─────────────────────────────────────────────
  if (group === 'rune') {
    // Everything after `fleet rune` is passed through to the rune binary.
    // `action` and `rest` already exclude the literal "rune" group token.
    const passthrough: string[] = [];
    if (action) passthrough.push(action);
    passthrough.push(...rest);

    const cliArgs: Record<string, unknown> = {
      cwd: process.cwd(),
      args: passthrough
    };

    const cli = new FleetCLI(sockPath);
    try {
      const response = opts?.retry
        ? await cli.sendWithRetry('rune.open', cliArgs)
        : await cli.send('rune.open', cliArgs);
      if (!response.ok) {
        return `Error: ${response.error ?? 'Unknown error'}`;
      }
      return 'Opening Rune in Fleet';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOENT')) {
        return 'Fleet is not running';
      }
      return `Error: ${msg}`;
    }
  }
```

If `action` and `rest` aren't already destructured at the top of this function (they are — the `pi` block references them), use the same names that block uses.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/fleet-cli.test.ts`
Expected: PASS — all three `fleet rune` tests green.

- [ ] **Step 7: Type-check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/fleet-cli.ts src/main/__tests__/fleet-cli.test.ts
git commit -m "feat(cli): add fleet rune subcommand to open a Rune agent tab"
```

---

## Task 8: Dashboard — "Start Rune" CTA

**Files:**
- Modify: `src/renderer/src/components/Dashboard.tsx:22-65` (extend props, add button)

- [ ] **Step 1: Extend `DashboardProps`**

In `src/renderer/src/components/Dashboard.tsx`, locate `DashboardProps` (around lines 22-28). Add `onStartRune`:

```ts
type DashboardProps = {
  recentFiles: string[];
  recentFolders: string[];
  onNewTerminal: () => void;
  onStartRune: () => void;
  onOpenFile: (filePath: string) => void;
  onOpenFolder: (folderPath: string) => void;
};
```

- [ ] **Step 2: Destructure and use the new prop**

Update the component signature (around line 30):

```ts
export function Dashboard({
  recentFiles,
  recentFolders,
  onNewTerminal,
  onStartRune,
  onOpenFile,
  onOpenFolder
}: DashboardProps): React.JSX.Element {
```

Then, immediately after the existing "New Terminal" button (around lines 55-63), add a "Start Rune" button using the same styling. Use a `Rocket` icon from `lucide-react` (already a dependency). At the top of the file, add `Rocket` to the lucide import:

```ts
import { Terminal, Folder, FileText, Rocket } from 'lucide-react';
```

Then insert the button immediately after the New Terminal button:

```tsx
        {/* Start Rune Action */}
        <button
          onClick={onStartRune}
          className="flex items-center gap-3 text-neutral-400 hover:text-cyan-400 transition-colors cursor-pointer group"
        >
          <Rocket size={16} />
          <span className="text-sm">Start Rune</span>
        </button>
```

- [ ] **Step 3: Type-check (now including the App.tsx changes from Task 6)**

Run: `npm run typecheck`
Expected: PASS — Dashboard now accepts `onStartRune`, and App.tsx supplies it.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit (bundles Task 6 + Task 8)**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/Dashboard.tsx
git commit -m "feat(rune): wire Dashboard Start Rune CTA and rune.onOpen listener"
```

---

## Task 9: Settings nav update + `RuneSection` component + `SettingsTab` routing

**Files:**
- Modify: `src/renderer/src/components/settings/SettingsNav.tsx` (add `'rune'` to union, reorder, relabel `'pi'`)
- Create: `src/renderer/src/components/settings/rune/RuneSection.tsx`
- Modify: `src/renderer/src/components/settings/SettingsTab.tsx` (route `'rune'`)

- [ ] **Step 1: Update `SettingsNav.tsx`**

In `src/renderer/src/components/settings/SettingsNav.tsx`:

a) Extend the `SettingsSection` union (around line 1-9):

```ts
export type SettingsSection =
  | 'general'
  | 'notifications'
  | 'socket'
  | 'visualizer'
  | 'updates'
  | 'copilot'
  | 'annotate'
  | 'rune'
  | 'pi';
```

b) Update `ALL_SECTIONS` order and the Pi label:

```ts
const ALL_SECTIONS: Array<{ id: SettingsSection; label: string; darwinOnly?: boolean }> = [
  { id: 'general', label: 'General' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'socket', label: 'Socket API' },
  { id: 'visualizer', label: 'Visualizer' },
  { id: 'copilot', label: 'Copilot', darwinOnly: true },
  { id: 'rune', label: 'Rune' },
  { id: 'pi', label: 'Pi (legacy)' },
  { id: 'annotate', label: 'Annotate' },
  { id: 'updates', label: 'Updates' } // Always keep at bottom
];
```

- [ ] **Step 2: Create `RuneSection.tsx`**

Create `src/renderer/src/components/settings/rune/RuneSection.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { ExternalLink, Copy, FolderOpen } from 'lucide-react';

const INSTALL_CMD =
  'curl -fsSL https://raw.githubusercontent.com/khang859/rune/main/install.sh | sh';
const RUNE_GITHUB = 'https://github.com/khang859/rune';

type VersionState =
  | { kind: 'loading' }
  | { kind: 'installed'; version: string }
  | { kind: 'missing' };

export function RuneSection(): React.JSX.Element {
  const [versionState, setVersionState] = useState<VersionState>({ kind: 'loading' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.fleet.rune.getVersion().then((res) => {
      if (!alive) return;
      if (res.installed) setVersionState({ kind: 'installed', version: res.version });
      else setVersionState({ kind: 'missing' });
    });
    return () => {
      alive = false;
    };
  }, []);

  const copyInstall = async (): Promise<void> => {
    await navigator.clipboard.writeText(INSTALL_CMD);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-4">
      <section className="rounded border border-blue-900/40 bg-blue-950/20 px-4 py-3 space-y-2">
        <h2 className="text-sm font-semibold text-neutral-100">Rune</h2>
        <p className="text-xs text-neutral-400">
          Rune is Fleet's recommended terminal coding agent. Configure providers, models, and skills
          from inside Rune via <code className="text-neutral-300">/providers</code>,{' '}
          <code className="text-neutral-300">/model</code>, and{' '}
          <code className="text-neutral-300">/settings</code>.
        </p>
        <a
          href={RUNE_GITHUB}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300"
        >
          github.com/khang859/rune <ExternalLink size={12} />
        </a>
      </section>

      <section className="rounded border border-neutral-800 bg-neutral-900/40 px-4 py-3 space-y-2">
        <h3 className="text-xs font-medium text-neutral-300 uppercase tracking-wider">Install</h3>
        {versionState.kind === 'loading' && (
          <p className="text-xs text-neutral-500">Checking for Rune…</p>
        )}
        {versionState.kind === 'installed' && (
          <p className="text-xs text-neutral-400">
            Installed: <span className="text-neutral-200">{versionState.version}</span>
          </p>
        )}
        {versionState.kind === 'missing' && (
          <>
            <p className="text-xs text-neutral-400">Rune is not installed.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-neutral-950 border border-neutral-800 px-2 py-1 text-xs text-neutral-300 overflow-x-auto whitespace-nowrap">
                {INSTALL_CMD}
              </code>
              <button
                type="button"
                onClick={copyInstall}
                className="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
              >
                <Copy size={12} />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="rounded border border-neutral-800 bg-neutral-900/40 px-4 py-3 space-y-2">
        <h3 className="text-xs font-medium text-neutral-300 uppercase tracking-wider">Skills</h3>
        <p className="text-xs text-neutral-400">
          Drop markdown skills into <code className="text-neutral-300">~/.rune/skills/</code> for
          Rune to pick up.
        </p>
        <button
          type="button"
          onClick={() => void window.fleet.rune.openSkillsDir()}
          className="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          <FolderOpen size={12} />
          Open ~/.rune/skills
        </button>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Route `'rune'` in `SettingsTab.tsx`**

In `src/renderer/src/components/settings/SettingsTab.tsx`, locate the conditional that renders sections based on `active` (search for `'pi'`). Add a matching branch for `'rune'` immediately above the Pi branch, importing `RuneSection` at the top of the file:

```tsx
import { RuneSection } from './rune/RuneSection';
```

And in the conditional render (adjust to the file's existing pattern — switch or ternaries):

```tsx
{active === 'rune' && <RuneSection />}
```

Follow whatever rendering style the existing file uses; if it's a switch on `active`, add `case 'rune': return <RuneSection />;` directly above the `case 'pi':` branch.

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/settings/SettingsNav.tsx src/renderer/src/components/settings/SettingsTab.tsx src/renderer/src/components/settings/rune/RuneSection.tsx
git commit -m "feat(settings): add Rune section, demote Pi Agent to Pi (legacy)"
```

---

## Task 10: README — Recommended agent callout

**Files:**
- Modify: `README.md` (insert under the existing top-line tagline)

- [ ] **Step 1: Add the Rune callout**

In `README.md`, immediately after the tagline line on line 3-5 ("Fleet gives you a single window..."), insert:

```markdown
## Recommended agent: Rune

[Rune](https://github.com/khang859/rune) is Fleet's flagship terminal coding agent.

```bash
curl -fsSL https://raw.githubusercontent.com/khang859/rune/main/install.sh | sh
```

Run `fleet rune` from any terminal (or click **Start Rune** on the Fleet dashboard)
to launch a Rune tab. Rune ships with read/write/edit/bash tools, markdown skills,
plan mode, and MCP plugin support, and works with ChatGPT (Codex), Groq, and Ollama.
```

(Render-fence the inner code block correctly — the install command is inside a fenced block; the outer markdown should not break.)

- [ ] **Step 2: Visually confirm rendering**

Run: `git diff README.md | head -40`
Expected: The diff shows a clean insertion with no surrounding formatting drift.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): recommend Rune as Fleet's flagship coding agent"
```

---

## Final verification

- [ ] **Step 1: Full type check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Manual smoke tests**

Boot the app (`npm run dev` if available, or build + launch). Verify:

1. Dashboard shows **Start Rune** below **New Terminal**. Clicking it opens a new terminal tab labeled **Rune** and `rune` runs (Fleet skill auto-injects on `RUNE_READY_MARKER`).
2. From a terminal pane, `fleet rune` opens a new tab the same way.
3. `fleet rune --prompt "say hello"` opens a tab and passes the prompt through.
4. **Settings → Rune** renders:
   - Version row shows installed version (or install snippet + Copy button if not installed).
   - **Open ~/.rune/skills** opens the folder.
5. **Settings → Pi (legacy)** still loads the existing Pi panel unchanged.
6. README renders correctly on GitHub-flavored markdown preview.

- [ ] **Step 5: Final summary**

Confirm to the user that the implementation is complete and reference the verified surfaces above.
