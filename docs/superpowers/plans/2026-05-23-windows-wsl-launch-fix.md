# Windows + WSL Launch Fix (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Phase 1 primitives (`ShellProfile`, `WslService`, `path-platform`) into the live PTY launch path, the CWD poller, and the tab/subtitle render path — so that on Windows a new pane defaults to a WSL profile, lands in `$HOME`, displays its tab title with `~`-collapse, and tracks CWD changes on native panes via `pid-cwd`. macOS and Linux behavior must be unchanged.

**Architecture:** A profile resolved in the main process drives `pty.spawn` args (`wsl.exe -d <distro> ~` for WSL profiles). The IPC handler resolves a `shellProfileId` to a `ShellProfile` via the (now-cached) `ShellProfileRegistry`, falling back to `getDefaultProfileId()` for legacy callers. Tab/Pane gain optional `shellProfileId` and `pathContext` fields; the renderer threads `pathContext` from the leaf into `path-platform.basename` (for tab titles) and `path-platform.displayPath` (for Telescope subtitles), backed by a small `HomesStore` that caches host + per-distro WSL homes. The `cwd-poller` adds a `win32` branch using the already-installed `pid-cwd` package; WSL panes are deliberately skipped because their poll-based CWD will be wrong — Phase 3 installs the OSC 7 hook.

**Tech Stack:** TypeScript (strict), Electron main+preload+renderer, Zustand stores, Vitest, `node-pty`, `pid-cwd` (already a dep).

---

## File map

| File | Action | Purpose |
|---|---|---|
| `src/main/shell-profiles.ts` | Modify | Promise-cache `enumerate()`; add `getDefaultProfileId()`; cache distro list |
| `src/main/__tests__/shell-profiles.test.ts` | Modify | Tests for cache + `getDefaultProfileId` |
| `src/shared/ipc-api.ts` | Modify | `defaultProfileId` on `ShellProfilesListResponse`; `shellProfileId?` on `PtyCreateRequest` |
| `src/main/ipc-handlers.ts` | Modify | List response returns defaultProfileId; PTY_CREATE resolves profile + plumbs pathContext to poller |
| `src/preload/index.ts` | Modify | `window.fleet.shellProfiles.list()` returns `{ profiles, defaultProfileId }` |
| `src/shared/types.ts` | Modify | Optional `shellProfileId` + `pathContext` on `Tab` and `PaneLeaf` |
| `src/main/pty-manager.ts` | Modify | Accept `profile?: ShellProfile`; build WSL args |
| `src/main/__tests__/pty-manager.test.ts` | Modify | Tests for WSL spawn-arg construction |
| `src/main/cwd-poller.ts` | Modify | `pid-cwd` on win32; skip WSL panes |
| `src/main/__tests__/cwd-poller.test.ts` | Modify | Tests for win32 + WSL-skip |
| `src/renderer/src/store/shell-profiles-store.ts` | Create | Zustand store: profiles, defaultProfile, isLoaded, load() |
| `src/renderer/src/store/__tests__/shell-profiles-store.test.ts` | Create | Tests for the renderer store |
| `src/renderer/src/store/homes-store.ts` | Create | Zustand store: hostHomeDir, wslHomeByDistro, ensureWslHome() |
| `src/renderer/src/store/__tests__/homes-store.test.ts` | Create | Tests for homes store |
| `src/renderer/src/store/workspace-store.ts` | Modify | `cwdBasename(cwd, ctx)` context-aware; addTab/duplicateTab/addPiTab populate profile fields |
| `src/renderer/src/components/TabItem.tsx` | Modify | Pass `tab.pathContext` to `cwdBasename` |
| `src/renderer/src/components/Telescope/modes/panes-mode.ts` | Modify | Subtitle via `displayPath(p, ctx, homes)` |
| `src/renderer/src/hooks/use-terminal.ts` | Modify | Accept + pass `shellProfileId` (createTerminal + restartPane) |
| `src/renderer/src/App.tsx` | Modify | Boot effect: `useShellProfilesStore.getState().load()` |

No new IPC channels — all five from Phase 1 are reused.

---

## Task 1: Cache `ShellProfileRegistry.enumerate()` + add `getDefaultProfileId`

**Files:**
- Modify: `src/main/shell-profiles.ts`
- Modify: `src/main/__tests__/shell-profiles.test.ts`

- [ ] **Step 1: Append failing tests**

Open `src/main/__tests__/shell-profiles.test.ts` and append at the bottom (inside the existing module, after the last `describe`):

```ts
describe('ShellProfileRegistry caching', () => {
  it('only enumerates once across multiple calls', async () => {
    const listDistros = vi.fn().mockResolvedValue([]);
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: {},
      wslService: { listDistros } as unknown as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    await reg.enumerate();
    await reg.enumerate();
    await reg.enumerate();
    expect(listDistros).toHaveBeenCalledTimes(1);
  });

  it('refresh() invalidates the cache', async () => {
    const listDistros = vi.fn().mockResolvedValue([]);
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: {},
      wslService: { listDistros } as unknown as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    await reg.enumerate();
    reg.refresh();
    await reg.enumerate();
    expect(listDistros).toHaveBeenCalledTimes(2);
  });
});

describe('ShellProfileRegistry.getDefaultProfileId', () => {
  it('returns the first profile id on darwin', async () => {
    const reg = new ShellProfileRegistry({
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      wslService: { listDistros: vi.fn().mockResolvedValue([]) } as unknown as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    expect(await reg.getDefaultProfileId()).toBe('posix.zsh');
  });

  it('returns wsl.<default distro> on win32 when a default WSL distro exists', async () => {
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: {},
      wslService: {
        listDistros: vi.fn().mockResolvedValue([
          { name: 'Debian', version: 2, isDefault: false, state: 'stopped' },
          { name: 'Ubuntu-22.04', version: 2, isDefault: true, state: 'running' }
        ])
      } as unknown as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    expect(await reg.getDefaultProfileId()).toBe('wsl.Ubuntu-22.04');
  });

  it('returns windows.powershell on win32 when no WSL distros exist', async () => {
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: {},
      wslService: { listDistros: vi.fn().mockResolvedValue([]) } as unknown as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    expect(await reg.getDefaultProfileId()).toBe('windows.powershell');
  });

  it('returns the first WSL profile on win32 when WSL distros exist but none are default', async () => {
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: {},
      wslService: {
        listDistros: vi.fn().mockResolvedValue([
          { name: 'Alpine', version: 2, isDefault: false, state: 'stopped' }
        ])
      } as unknown as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    expect(await reg.getDefaultProfileId()).toBe('wsl.Alpine');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/shell-profiles.test.ts`
Expected: FAIL — "reg.getDefaultProfileId is not a function" and the cache assertions fail (each enumerate call currently invokes listDistros).

- [ ] **Step 3: Implement caching + `getDefaultProfileId` + `refresh`**

Edit `src/main/shell-profiles.ts`. Replace the existing `enumerate()` method and append the two new methods. The full updated class body should look like:

```ts
export class ShellProfileRegistry {
  private cachedProfiles: Promise<ShellProfile[]> | null = null;
  private cachedDistros: Array<{ name: string; isDefault: boolean }> = [];

  constructor(private deps: RegistryDeps) {}

  async enumerate(): Promise<ShellProfile[]> {
    if (!this.cachedProfiles) {
      this.cachedProfiles = this.doEnumerate();
    }
    return this.cachedProfiles;
  }

  refresh(): void {
    this.cachedProfiles = null;
    this.cachedDistros = [];
  }

  async getDefaultProfileId(): Promise<string> {
    const profiles = await this.enumerate();
    if (this.deps.platform !== 'win32') {
      return profiles[0]?.id ?? 'posix.unknown';
    }
    const defaultDistro = this.cachedDistros.find((d) => d.isDefault);
    if (defaultDistro) return `wsl.${defaultDistro.name}`;
    const firstWsl = profiles.find((p) => p.kind === 'wsl');
    if (firstWsl) return firstWsl.id;
    return 'windows.powershell';
  }

  private async doEnumerate(): Promise<ShellProfile[]> {
    if (this.deps.platform === 'win32') {
      return this.enumerateWindows();
    }
    return this.enumeratePosix();
  }

  private enumeratePosix(): ShellProfile[] {
    const shell = this.deps.env.SHELL ?? '/bin/zsh';
    const label = pathBasename(shell);
    return [
      {
        id: `posix.${label}`,
        kind: 'system',
        label,
        command: shell,
        args: [],
        pathContext: 'posix'
      }
    ];
  }

  private async enumerateWindows(): Promise<ShellProfile[]> {
    const profiles: ShellProfile[] = [
      {
        id: 'windows.powershell',
        kind: 'system',
        label: 'PowerShell',
        command: 'powershell.exe',
        args: [],
        pathContext: 'win32'
      },
      {
        id: 'windows.cmd',
        kind: 'system',
        label: 'Command Prompt',
        command: 'cmd.exe',
        args: [],
        pathContext: 'win32'
      }
    ];

    const programFiles = this.deps.env.ProgramFiles;
    if (programFiles) {
      const gitBash = win32Join(programFiles, 'Git', 'bin', 'bash.exe');
      if (this.deps.fileExists(gitBash)) {
        profiles.push({
          id: 'windows.git-bash',
          kind: 'system',
          label: 'Git Bash',
          command: gitBash,
          args: ['--login', '-i'],
          pathContext: 'win32'
        });
      }
    }

    const distros = await this.deps.wslService.listDistros();
    this.cachedDistros = distros.map((d) => ({ name: d.name, isDefault: d.isDefault }));
    for (const d of distros) {
      profiles.push({
        id: `wsl.${d.name}`,
        kind: 'wsl',
        label: `${d.name} (WSL)`,
        command: 'wsl.exe',
        args: ['-d', d.name],
        pathContext: { kind: 'wsl', distro: d.name }
      });
    }

    return profiles;
  }
}
```

Note: keep the existing imports. If the file imports `join` from `'node:path'` directly, rename the import alias used inside `enumerateWindows` (e.g. `import { basename as pathBasename, win32 as { join: win32Join } } from 'node:path';` — or destructure separately). The Phase 1 plan used `path.win32.join`; preserve that. Concretely, the file's top should have:

```ts
import { basename as pathBasename } from 'node:path';
import { win32 as winPath } from 'node:path';
// then use winPath.join(...) where `win32Join` appears above
```

Adjust the references above accordingly so they call `winPath.join(programFiles, 'Git', 'bin', 'bash.exe')`. The key invariant from Phase 1's #7 decision (use win32 joiner so Linux test hosts still produce backslash paths) must be preserved.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/shell-profiles.test.ts`
Expected: PASS — all original 4 tests plus 6 new ones = 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/shell-profiles.ts src/main/__tests__/shell-profiles.test.ts
git commit -m "feat(main): cache shell-profile enumeration and add getDefaultProfileId"
```

---

## Task 2: Extend `ShellProfilesListResponse` with `defaultProfileId`

**Files:**
- Modify: `src/shared/ipc-api.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Extend the response type**

In `src/shared/ipc-api.ts`, locate the existing `ShellProfilesListResponse` (added in Phase 1, near the bottom of the file) and change it to:

```ts
export type ShellProfilesListResponse = {
  profiles: ShellProfile[];
  defaultProfileId: string;
};
```

- [ ] **Step 2: Update the main-process handler**

In `src/main/ipc-handlers.ts`, find the existing `SHELL_PROFILES_LIST` handler (added in Phase 1). Replace its body with:

```ts
ipcMain.handle(IPC_CHANNELS.SHELL_PROFILES_LIST, async (): Promise<ShellProfilesListResponse> => {
  const profiles = await shellProfileRegistry.enumerate();
  const defaultProfileId = await shellProfileRegistry.getDefaultProfileId();
  return { profiles, defaultProfileId };
});
```

- [ ] **Step 3: Update the preload bridge**

In `src/preload/index.ts`, find the existing `shellProfiles.list` function (added in Phase 1, around line 380). Replace it with:

```ts
shellProfiles: {
  list: async (): Promise<{ profiles: ShellProfile[]; defaultProfileId: string }> => {
    const res = await typedInvoke<ShellProfilesListResponse>(IPC_CHANNELS.SHELL_PROFILES_LIST);
    return { profiles: res.profiles, defaultProfileId: res.defaultProfileId };
  }
},
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-api.ts src/main/ipc-handlers.ts src/preload/index.ts
git commit -m "feat(ipc): return defaultProfileId from shellProfiles.list"
```

---

## Task 3: Add `shellProfileId` + `pathContext` to `Tab` and `PaneLeaf`

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add the imports + new optional fields**

At the top of `src/shared/types.ts`, add the import (it's a type-only import to avoid affecting the bundle):

```ts
import type { PathContext } from './shell-profiles';
```

Modify the `Tab` type — add two optional fields at the end:

```ts
export type Tab = {
  id: string;
  label: string;
  labelIsCustom: boolean;
  cwd: string;
  type?: 'terminal' | 'file' | 'image' | 'images' | 'settings' | 'annotate' | 'pi' | 'markdown';
  avatarVariant?: string;
  splitRoot: PaneNode;
  // Worktree group fields
  groupId?: string;
  groupRole?: 'parent' | 'worktree';
  groupLabel?: string;
  worktreeBranch?: string;
  worktreePath?: string;
  /** ShellProfile id used when this tab was created. Optional for legacy persisted tabs. */
  shellProfileId?: string;
  /** Path semantics for this tab (driven by the chosen shellProfile). Optional for legacy tabs. */
  pathContext?: PathContext;
};
```

Modify the `PaneLeaf` type — add the same two fields:

```ts
export type PaneLeaf = {
  type: 'leaf';
  id: string;
  ptyPid?: number;
  shell?: string;
  cwd: string;
  paneType?: 'terminal' | 'file' | 'image' | 'images' | 'pi' | 'markdown';
  filePath?: string;
  isDirty?: boolean;
  serializedContent?: string;
  label?: string;
  labelIsCustom?: boolean;
  /** ShellProfile id used to spawn this pane's PTY. Optional for legacy persisted leaves. */
  shellProfileId?: string;
  /** Path semantics for this pane. Drives basename/displayPath rendering. */
  pathContext?: PathContext;
};
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS (additive optional fields — no existing code breaks).

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(shared): add optional shellProfileId and pathContext to Tab and PaneLeaf"
```

---

## Task 4: Extend `PtyCreateRequest` + `PtyCreateOptions`

**Files:**
- Modify: `src/shared/ipc-api.ts`
- Modify: `src/main/pty-manager.ts`

- [ ] **Step 1: Add `shellProfileId` to the IPC request**

In `src/shared/ipc-api.ts`, find the existing `PtyCreateRequest` (at the top of the file, around lines 4–12). Add the new optional field:

```ts
export type PtyCreateRequest = {
  paneId: string;
  cwd: string;
  shell?: string;
  cmd?: string;
  workspaceId?: string;
  exitOnComplete?: boolean;
  /** Resolved on the main side to a ShellProfile via ShellProfileRegistry. Optional for legacy callers. */
  shellProfileId?: string;
};
```

- [ ] **Step 2: Add `profile` to the main-side options**

In `src/main/pty-manager.ts`, add an import at the top:

```ts
import type { ShellProfile } from '../shared/shell-profiles';
```

Then extend `PtyCreateOptions` (lines 7–20) with one new optional field:

```ts
export type PtyCreateOptions = {
  paneId: string;
  cwd: string;
  shell?: string;
  cmd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string | undefined>;
  exitOnComplete?: boolean;
  workspaceId?: string;
  /** Optional resolved profile. When present, drives WSL arg construction. */
  profile?: ShellProfile;
};
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-api.ts src/main/pty-manager.ts
git commit -m "feat(pty): add shellProfileId/profile fields to PtyCreate types"
```

---

## Task 5: `PtyManager.create` builds WSL args when profile is WSL

**Files:**
- Modify: `src/main/pty-manager.ts`
- Modify: `src/main/__tests__/pty-manager.test.ts`

- [ ] **Step 1: Append failing tests**

Append at the bottom of `src/main/__tests__/pty-manager.test.ts`:

```ts
describe('PtyManager profile-aware spawn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns wsl.exe with [-d <distro> ~] when given a WSL profile', () => {
    const manager = new PtyManager();
    manager.create({
      paneId: 'pane-wsl',
      cwd: 'C:\\Users\\khang\\dev',
      profile: {
        id: 'wsl.Ubuntu-22.04',
        kind: 'wsl',
        label: 'Ubuntu-22.04 (WSL)',
        command: 'wsl.exe',
        args: ['-d', 'Ubuntu-22.04'],
        pathContext: { kind: 'wsl', distro: 'Ubuntu-22.04' }
      }
    });
    expect(ptyModule.spawn).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu-22.04', '~'],
      expect.objectContaining({ cwd: 'C:\\Users\\khang\\dev' })
    );
  });

  it('spawns profile.command with profile.args for system profiles', () => {
    const manager = new PtyManager();
    manager.create({
      paneId: 'pane-pwsh',
      cwd: 'C:\\Users\\khang',
      profile: {
        id: 'windows.powershell',
        kind: 'system',
        label: 'PowerShell',
        command: 'powershell.exe',
        args: [],
        pathContext: 'win32'
      }
    });
    expect(ptyModule.spawn).toHaveBeenCalledWith(
      'powershell.exe',
      [],
      expect.objectContaining({ cwd: 'C:\\Users\\khang' })
    );
  });

  it('falls back to opts.shell when no profile is provided (legacy path)', () => {
    const manager = new PtyManager();
    manager.create({
      paneId: 'pane-legacy',
      cwd: '/tmp',
      shell: '/bin/zsh'
    });
    expect(ptyModule.spawn).toHaveBeenCalledWith('/bin/zsh', [], expect.objectContaining({ cwd: '/tmp' }));
  });

  it('combines profile.args with cmd when both are present', () => {
    const manager = new PtyManager();
    manager.create({
      paneId: 'pane-cmd',
      cwd: '/tmp',
      cmd: 'echo hello',
      profile: {
        id: 'posix.zsh',
        kind: 'system',
        label: 'zsh',
        command: '/bin/zsh',
        args: [],
        pathContext: 'posix'
      }
    });
    expect(ptyModule.spawn).toHaveBeenCalledWith(
      '/bin/zsh',
      ['-c', 'echo hello; exec /bin/zsh'],
      expect.objectContaining({ cwd: '/tmp' })
    );
  });
});
```

The `ptyModule` import was already added by the existing test file (see line 67: `import * as ptyModule from 'node-pty';`). If a fresh test scope is needed at the top of this block, add it again.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/pty-manager.test.ts`
Expected: FAIL — the WSL test fails because today the spawn call is `('zsh', [], ...)` (or whatever `getDefaultShell()` returns), not `('wsl.exe', ['-d', 'Ubuntu-22.04', '~'], ...)`.

- [ ] **Step 3: Implement profile-aware spawn**

In `src/main/pty-manager.ts`, replace the body of `create()` (lines 47–114) from `const shell = opts.shell ?? getDefaultShell();` through the existing `pty.spawn(...)` call. The new logic must:

1. If `opts.profile?.kind === 'wsl'`, use `wsl.exe` + `['-d', distro, '~']` as the base, append `cmd` handling on top.
2. If `opts.profile?.kind === 'system'`, use `profile.command` + `profile.args` as the base.
3. Otherwise fall back to `opts.shell ?? getDefaultShell()` (legacy).

Concrete replacement (the part that needs changing — keep everything before line 47 and after the spawn call untouched):

```ts
    let shell: string;
    let baseArgs: string[];

    if (opts.profile?.kind === 'wsl') {
      const distro = opts.profile.pathContext === 'win32' || opts.profile.pathContext === 'posix'
        ? ''
        : opts.profile.pathContext.distro;
      shell = opts.profile.command;
      // Trailing `~` forces the WSL shell to land in $HOME, overriding the
      // Windows cwd that node-pty passes to wsl.exe. Microsoft documents this
      // pattern as `wsl ~`.
      baseArgs = ['-d', distro, '~'];
    } else if (opts.profile?.kind === 'system') {
      shell = opts.profile.command;
      baseArgs = [...opts.profile.args];
    } else {
      shell = opts.shell ?? getDefaultShell();
      baseArgs = [];
    }

    const args: string[] = [...baseArgs];

    if (opts.cmd) {
      if (opts.exitOnComplete) {
        args.push('-c', opts.cmd);
      } else {
        args.push('-c', `${opts.cmd}; exec ${shell}`);
      }
    }

    log.debug('spawning PTY', {
      shell,
      args,
      cwd: opts.cwd,
      profileId: opts.profile?.id,
      pathPrefix: process.env.PATH?.substring(0, 80)
    });
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: { ...(opts.env ?? process.env), FLEET_SESSION: '1' }
    });
```

Note: when `opts.profile?.kind === 'wsl'` AND `opts.cmd` is also passed, the resulting args become `['-d', distro, '~', '-c', cmd]`. That is the documented behavior — `wsl ~ -c <cmd>` runs the command and exits. The fallback-to-shell path (`exec ${shell}` after `;`) is meaningless for WSL because `${shell}` is `wsl.exe`; it doesn't re-launch a login shell. The `cmd` use case is dominated by crew/agent PTYs which set `exitOnComplete: true`, so this is acceptable.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/pty-manager.test.ts`
Expected: PASS — original tests still pass, four new tests pass (= 9 tests in this file plus whatever the second `describe` block adds).

- [ ] **Step 5: Commit**

```bash
git add src/main/pty-manager.ts src/main/__tests__/pty-manager.test.ts
git commit -m "feat(pty): construct WSL spawn args from ShellProfile"
```

---

## Task 6: `cwd-poller.ts` — `pid-cwd` on win32 + skip WSL panes

**Files:**
- Modify: `src/main/cwd-poller.ts`
- Modify: `src/main/__tests__/cwd-poller.test.ts`

- [ ] **Step 1: Append failing tests**

Append at the bottom of `src/main/__tests__/cwd-poller.test.ts`:

```ts
describe('CwdPoller on win32', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('uses pid-cwd to resolve cwd for win32 panes', async () => {
    const ptyManager = makeMockPtyManager('C:\\old');
    const poller = new CwdPoller(eventBus, ptyManager);
    poller.startPolling('pane-1', 999, 'win32');

    await vi.advanceTimersByTimeAsync(5001);

    expect(pidCwd).toHaveBeenCalledWith(999);
    poller.stopAll();
  });

  it('does not poll WSL panes (waits for OSC 7)', async () => {
    const ptyManager = makeMockPtyManager('C:\\old');
    const poller = new CwdPoller(eventBus, ptyManager);
    poller.startPolling('pane-wsl', 999, { kind: 'wsl', distro: 'Ubuntu' });

    await vi.advanceTimersByTimeAsync(10000);

    expect(pidCwd).not.toHaveBeenCalled();
    poller.stopAll();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/cwd-poller.test.ts`
Expected: FAIL — `startPolling` takes two args, not three; on win32 today `readProcCwd` returns null (the win32 guard).

- [ ] **Step 3: Implement**

Replace the entire body of `src/main/cwd-poller.ts` with:

```ts
import { readlink } from 'fs/promises';
import pidCwd from 'pid-cwd';
import type { EventBus } from './event-bus';
import type { PtyManager } from './pty-manager';
import type { PathContext } from '../shared/shell-profiles';

const POLL_INTERVAL_MS = 5000;

export class CwdPoller {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private osc7Seen = new Set<string>();

  constructor(
    private eventBus: EventBus,
    private ptyManager: PtyManager
  ) {}

  startPolling(paneId: string, pid: number, pathContext: PathContext = 'posix'): void {
    if (this.timers.has(paneId)) return;
    // WSL panes only update via OSC 7 (installed by Phase 3's ensureFleetCli hook).
    // Polling the wsl.exe pid on the Windows side returns the wrong cwd because
    // the Linux-side shell's cwd is invisible to the Windows kernel.
    if (typeof pathContext === 'object' && pathContext.kind === 'wsl') {
      return;
    }

    const timer = setInterval(() => {
      if (this.osc7Seen.has(paneId)) {
        this.stopPolling(paneId);
        return;
      }
      void readProcCwd(pid).then((cwd) => {
        if (cwd) {
          const current = this.ptyManager.getCwd(paneId);
          if (cwd !== current) {
            this.eventBus.emit('cwd-changed', { type: 'cwd-changed', paneId, cwd, source: 'poll' });
          }
        }
      });
    }, POLL_INTERVAL_MS);

    this.timers.set(paneId, timer);
  }

  markOsc7Seen(paneId: string): void {
    this.osc7Seen.add(paneId);
  }

  stopPolling(paneId: string): void {
    const timer = this.timers.get(paneId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(paneId);
    }
    this.osc7Seen.delete(paneId);
  }

  stopAll(): void {
    for (const paneId of this.timers.keys()) {
      clearInterval(this.timers.get(paneId));
    }
    this.timers.clear();
    this.osc7Seen.clear();
  }
}

async function readProcCwd(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }

  if (process.platform === 'darwin' || process.platform === 'win32') {
    try {
      return await pidCwd(pid);
    } catch {
      return null;
    }
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/cwd-poller.test.ts`
Expected: PASS — all original 3 tests + 2 new tests = 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/cwd-poller.ts src/main/__tests__/cwd-poller.test.ts
git commit -m "feat(cwd-poller): support win32 via pid-cwd, skip WSL panes"
```

---

## Task 7: IPC `PTY_CREATE` handler resolves profile + plumbs pathContext

**Files:**
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Edit the handler**

Open `src/main/ipc-handlers.ts`. The current handler signature for `PTY_CREATE` at line 104 is synchronous (`(_event, req: PtyCreateRequest) =>`). We need to make it async to resolve the profile. Replace the handler (lines 104–160) with:

```ts
ipcMain.handle(IPC_CHANNELS.PTY_CREATE, async (_event, req: PtyCreateRequest) => {
  log.debug('ipc:pty:create', { paneId: req.paneId, cwd: req.cwd, shellProfileId: req.shellProfileId });

  // Resolve Claude config: workspace override → global → default
  const settings = settingsStore.get();
  const wsOverride = req.workspaceId
    ? settings.copilot.workspaceOverrides[req.workspaceId]
    : undefined;
  const claudeConfigDir = wsOverride?.claudeConfigDir || settings.copilot.claudeConfigDir || '';

  const extraEnv: Record<string, string> = {};
  if (claudeConfigDir) {
    extraEnv.CLAUDE_CONFIG_DIR = claudeConfigDir;
  }

  // Resolve the ShellProfile (defaulting to the registry's default if not provided).
  const profileId = req.shellProfileId ?? (await shellProfileRegistry.getDefaultProfileId());
  const profiles = await shellProfileRegistry.enumerate();
  const profile = profiles.find((p) => p.id === profileId);

  const alreadyExisted = ptyManager.has(req.paneId);
  const result = ptyManager.create({
    ...req,
    profile,
    env: Object.keys(extraEnv).length > 0 ? { ...process.env, ...extraEnv } : undefined
  });

  // Skip re-registering listeners on idempotent path (HMR reloads) to prevent
  // duplicate onExit/onData callbacks stacking up
  if (!alreadyExisted) {
    activityTracker.trackPane(req.paneId);
    ptyManager.onData(req.paneId, (data, paused) => {
      notificationDetector.scan(req.paneId, data);
      activityTracker.onData(req.paneId);
      const w = getWindow();
      if (w && !w.isDestroyed()) {
        w.webContents.send(IPC_CHANNELS.PTY_DATA, {
          paneId: req.paneId,
          data,
          paused
        } satisfies PtyDataPayload);
      }
    });

    ptyManager.onExit(req.paneId, (exitCode) => {
      cwdPoller.stopPolling(req.paneId);
      const w = getWindow();
      if (w && !w.isDestroyed()) {
        w.webContents.send(IPC_CHANNELS.PTY_EXIT, {
          paneId: req.paneId,
          exitCode
        } satisfies PtyExitPayload);
      }
      eventBus.emit('pty-exit', { type: 'pty-exit', paneId: req.paneId, exitCode });
    });

    // Start CWD polling fallback. For WSL panes the poller no-ops — Phase 3's
    // OSC 7 hook will drive cwd updates once the shell sources ~/.fleetrc.sh.
    cwdPoller.startPolling(req.paneId, result.pid, profile?.pathContext ?? 'posix');

    eventBus.emit('pane-created', { type: 'pane-created', paneId: req.paneId });
  }
  return result;
});
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run the main test suite to ensure no regression**

Run: `npx vitest run src/main`
Expected: PASS — all main-process tests (incl. Phase 1 + the new ones from Tasks 1, 5, 6).

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc-handlers.ts
git commit -m "feat(ipc): resolve ShellProfile in pty:create and plumb pathContext to poller"
```

---

## Task 8: Renderer `shell-profiles-store` (Zustand)

**Files:**
- Create: `src/renderer/src/store/shell-profiles-store.ts`
- Create: `src/renderer/src/store/__tests__/shell-profiles-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/src/store/__tests__/shell-profiles-store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShellProfile } from '../../../../shared/shell-profiles';

const listMock = vi.fn();

beforeEach(() => {
  listMock.mockReset();
  // Stub the preload bridge before importing the store
  (globalThis as unknown as { window: { fleet: { shellProfiles: { list: typeof listMock } } } }).window = {
    fleet: { shellProfiles: { list: listMock } }
  };
});

async function freshStore() {
  // Re-import to reset Zustand state between tests
  const mod = await import('../shell-profiles-store');
  mod.useShellProfilesStore.setState({ profiles: [], defaultProfile: null, isLoaded: false });
  return mod;
}

describe('useShellProfilesStore', () => {
  it('starts empty and isLoaded=false', async () => {
    const { useShellProfilesStore } = await freshStore();
    expect(useShellProfilesStore.getState().profiles).toEqual([]);
    expect(useShellProfilesStore.getState().defaultProfile).toBeNull();
    expect(useShellProfilesStore.getState().isLoaded).toBe(false);
  });

  it('load() populates profiles and defaultProfile by id', async () => {
    const profile: ShellProfile = {
      id: 'wsl.Ubuntu',
      kind: 'wsl',
      label: 'Ubuntu (WSL)',
      command: 'wsl.exe',
      args: ['-d', 'Ubuntu'],
      pathContext: { kind: 'wsl', distro: 'Ubuntu' }
    };
    const pwsh: ShellProfile = {
      id: 'windows.powershell',
      kind: 'system',
      label: 'PowerShell',
      command: 'powershell.exe',
      args: [],
      pathContext: 'win32'
    };
    listMock.mockResolvedValue({ profiles: [pwsh, profile], defaultProfileId: 'wsl.Ubuntu' });

    const { useShellProfilesStore } = await freshStore();
    await useShellProfilesStore.getState().load();

    const state = useShellProfilesStore.getState();
    expect(state.profiles).toHaveLength(2);
    expect(state.defaultProfile?.id).toBe('wsl.Ubuntu');
    expect(state.isLoaded).toBe(true);
  });

  it('falls back to first profile when defaultProfileId is not found', async () => {
    const pwsh: ShellProfile = {
      id: 'windows.powershell',
      kind: 'system',
      label: 'PowerShell',
      command: 'powershell.exe',
      args: [],
      pathContext: 'win32'
    };
    listMock.mockResolvedValue({ profiles: [pwsh], defaultProfileId: 'wsl.Missing' });

    const { useShellProfilesStore } = await freshStore();
    await useShellProfilesStore.getState().load();

    expect(useShellProfilesStore.getState().defaultProfile?.id).toBe('windows.powershell');
  });

  it('load() is idempotent — calling twice does not re-fetch', async () => {
    listMock.mockResolvedValue({ profiles: [], defaultProfileId: '' });
    const { useShellProfilesStore } = await freshStore();
    await useShellProfilesStore.getState().load();
    await useShellProfilesStore.getState().load();
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/store/__tests__/shell-profiles-store.test.ts`
Expected: FAIL — "Cannot find module '../shell-profiles-store'"

- [ ] **Step 3: Implement the store**

```ts
// src/renderer/src/store/shell-profiles-store.ts
import { create } from 'zustand';
import type { ShellProfile } from '../../../shared/shell-profiles';

type ShellProfilesState = {
  profiles: ShellProfile[];
  defaultProfile: ShellProfile | null;
  isLoaded: boolean;
  load: () => Promise<void>;
};

export const useShellProfilesStore = create<ShellProfilesState>((set, get) => ({
  profiles: [],
  defaultProfile: null,
  isLoaded: false,
  load: async () => {
    if (get().isLoaded) return;
    const { profiles, defaultProfileId } = await window.fleet.shellProfiles.list();
    const defaultProfile = profiles.find((p) => p.id === defaultProfileId) ?? profiles[0] ?? null;
    set({ profiles, defaultProfile, isLoaded: true });
  }
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/store/__tests__/shell-profiles-store.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/shell-profiles-store.ts src/renderer/src/store/__tests__/shell-profiles-store.test.ts
git commit -m "feat(renderer): add shell-profiles store"
```

---

## Task 9: Renderer `homes-store` (Zustand)

**Files:**
- Create: `src/renderer/src/store/homes-store.ts`
- Create: `src/renderer/src/store/__tests__/homes-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/src/store/__tests__/homes-store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const wslHomeDirMock = vi.fn();

beforeEach(() => {
  wslHomeDirMock.mockReset();
  (globalThis as unknown as { window: unknown }).window = {
    fleet: {
      homeDir: 'C:\\Users\\khang',
      wsl: { homeDir: wslHomeDirMock }
    }
  };
});

async function freshStore() {
  const mod = await import('../homes-store');
  mod.useHomesStore.setState({
    hostHomeDir: (globalThis as unknown as { window: { fleet: { homeDir: string } } }).window.fleet.homeDir,
    wslHomeByDistro: {}
  });
  return mod;
}

describe('useHomesStore', () => {
  it('exposes the host home dir from window.fleet.homeDir', async () => {
    const { useHomesStore } = await freshStore();
    expect(useHomesStore.getState().hostHomeDir).toBe('C:\\Users\\khang');
  });

  it('ensureWslHome() caches the result per distro', async () => {
    wslHomeDirMock.mockResolvedValueOnce('/home/khang');
    const { useHomesStore } = await freshStore();
    await useHomesStore.getState().ensureWslHome('Ubuntu');
    await useHomesStore.getState().ensureWslHome('Ubuntu');
    expect(wslHomeDirMock).toHaveBeenCalledTimes(1);
    expect(useHomesStore.getState().wslHomeByDistro.Ubuntu).toBe('/home/khang');
  });

  it('snapshot() returns the shape expected by path-platform.displayPath', async () => {
    wslHomeDirMock.mockResolvedValueOnce('/home/khang');
    const { useHomesStore } = await freshStore();
    await useHomesStore.getState().ensureWslHome('Ubuntu');
    const snap = useHomesStore.getState().snapshot();
    expect(snap).toEqual({
      homeDir: 'C:\\Users\\khang',
      wslHomeByDistro: { Ubuntu: '/home/khang' }
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/store/__tests__/homes-store.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the store**

```ts
// src/renderer/src/store/homes-store.ts
import { create } from 'zustand';

type HomesState = {
  hostHomeDir: string;
  wslHomeByDistro: Record<string, string>;
  ensureWslHome: (distro: string) => Promise<string>;
  snapshot: () => { homeDir: string; wslHomeByDistro: Record<string, string> };
};

export const useHomesStore = create<HomesState>((set, get) => ({
  hostHomeDir: window.fleet.homeDir,
  wslHomeByDistro: {},
  ensureWslHome: async (distro: string) => {
    const cached = get().wslHomeByDistro[distro];
    if (cached) return cached;
    const home = await window.fleet.wsl.homeDir(distro);
    set((state) => ({
      wslHomeByDistro: { ...state.wslHomeByDistro, [distro]: home }
    }));
    return home;
  },
  snapshot: () => ({
    homeDir: get().hostHomeDir,
    wslHomeByDistro: get().wslHomeByDistro
  })
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/store/__tests__/homes-store.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/homes-store.ts src/renderer/src/store/__tests__/homes-store.test.ts
git commit -m "feat(renderer): add homes store for path-platform displayPath"
```

---

## Task 10: Context-aware `cwdBasename` in `workspace-store.ts`

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts`

- [ ] **Step 1: Replace the `cwdBasename` definition**

In `src/renderer/src/store/workspace-store.ts`, replace the existing `cwdBasename` (lines 102–105) with:

```ts
import { basename as pathBasename } from '../../../shared/path-platform';
import type { PathContext } from '../../../shared/shell-profiles';

/** Extract basename from a path for auto-labeling tabs. ctx defaults to 'posix'. */
export function cwdBasename(cwd: string, ctx: PathContext = 'posix'): string {
  return pathBasename(cwd, ctx);
}
```

The `basename` function in `path-platform.ts` already returns `'Shell'` for empty/root inputs (see Phase 1's `basename` test cases), so the new function preserves the original contract.

- [ ] **Step 2: Update internal call sites in this file**

There are 3 internal call sites that need the `pathContext` arg. Update each:

1. `addTab()` line 290 — leave as-is for now. Task 13 rewrites the whole method and threads `pathContext` from the resolved default profile. If you commit Task 10 before Task 13, this line continues to compile because the new `ctx` param has a default of `'posix'`.

2. `resetTabLabel()` line 418 — existing:

```ts
{ ...t, label: cwdBasename(liveCwd ?? t.cwd), labelIsCustom: false }
```

Update to:

```ts
{ ...t, label: cwdBasename(liveCwd ?? t.cwd, t.pathContext ?? 'posix'), labelIsCustom: false }
```

3. `createWorktreeGroup()` line 463 — existing:

```ts
const groupLabel = sourceTab.groupLabel ?? cwdBasename(repoPath);
```

Update to:

```ts
const groupLabel = sourceTab.groupLabel ?? cwdBasename(repoPath, sourceTab.pathContext ?? 'posix');
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Run the renderer tests**

Run: `npx vitest run src/renderer`
Expected: PASS — `workspace-store.test.ts` keeps passing since the new arg has a default of `'posix'` and existing tests use POSIX paths.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts
git commit -m "feat(workspace-store): make cwdBasename context-aware"
```

---

## Task 11: `TabItem.tsx` + `Sidebar.tsx` thread `pathContext` to `cwdBasename`

**Files:**
- Modify: `src/renderer/src/components/TabItem.tsx`
- Modify: `src/renderer/src/components/Sidebar.tsx`

`TabItem` does not have `tab` in scope — it destructures fields individually from `TabItemProps`. We need to add `pathContext` as a prop and pipe it through from the caller (`Sidebar.tsx:1190`).

- [ ] **Step 1: Add `pathContext` to `TabItemProps`**

In `src/renderer/src/components/TabItem.tsx`, add an import near the top (alongside the existing type imports):

```ts
import type { PathContext } from '../../../shared/shell-profiles';
```

Modify `TabItemProps` (lines 13–47) to add the optional field — append after `worktreeBranch?` and before `indentLevel?`:

```ts
  /** Path semantics for rendering the auto-label. Undefined = treat as POSIX. */
  pathContext?: PathContext;
```

- [ ] **Step 2: Destructure and use the new prop**

In the function body around lines 75–100, add `pathContext` to the destructured params (any position after `cwd: fallbackCwd` is fine). Then update line 249 to pass it:

```tsx
{labelIsCustom ? label : cwdBasename(cwd, pathContext ?? 'posix')}
```

- [ ] **Step 3: Pass `tab.pathContext` from `Sidebar.tsx`**

In `src/renderer/src/components/Sidebar.tsx`, find the `<TabItem ... />` JSX (line 1190). Add one new prop alongside `worktreeBranch`:

```tsx
pathContext={tab.pathContext}
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/TabItem.tsx src/renderer/src/components/Sidebar.tsx
git commit -m "feat(tabs): render tab title with context-aware basename"
```

---

## Task 12: Telescope `panes-mode` subtitle uses `displayPath`

**Files:**
- Modify: `src/renderer/src/components/Telescope/modes/panes-mode.ts`

- [ ] **Step 1: Locate the line**

Open `src/renderer/src/components/Telescope/modes/panes-mode.ts`. Around line 38 you'll find:

```ts
subtitle: leaf.cwd.replace(window.fleet.homeDir, '~'),
```

- [ ] **Step 2: Replace it with `displayPath`**

Add imports at the top of the file:

```ts
import { displayPath } from '../../../../../shared/path-platform';
import { useHomesStore } from '../../../store/homes-store';
```

Replace the subtitle expression with:

```ts
subtitle: displayPath(leaf.cwd, leaf.pathContext ?? 'posix', useHomesStore.getState().snapshot()),
```

`useHomesStore.getState().snapshot()` is sync. The snapshot may not yet include the relevant WSL distro home — that's OK; `displayPath` will fall back to the raw path when no rule matches (see Phase 1's tests). The home gets populated lazily by `ensureWslHome` from Task 14.

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Run all renderer tests**

Run: `npx vitest run src/renderer`
Expected: PASS — no test exists for panes-mode subtitle today; we're not adding one. Compilation must pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Telescope/modes/panes-mode.ts
git commit -m "feat(telescope): render pane subtitles with context-aware displayPath"
```

---

## Task 13: `addTab` / `duplicateTab` / `addPiTab` populate profile + context

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts`

- [ ] **Step 1: Import the shell-profiles store**

Near the top of `src/renderer/src/store/workspace-store.ts`, add:

```ts
import { useShellProfilesStore } from './shell-profiles-store';
import type { PathContext } from '../../../shared/shell-profiles';
```

Then add a small helper near the existing `createLeaf`:

```ts
function resolveDefaultProfile(): { id: string | undefined; pathContext: PathContext } {
  const def = useShellProfilesStore.getState().defaultProfile;
  return {
    id: def?.id,
    pathContext: def?.pathContext ?? (window.fleet.platform === 'win32' ? 'win32' : 'posix')
  };
}

function createLeafWithProfile(cwd: string, profileId: string | undefined, pathContext: PathContext): PaneLeaf {
  return { type: 'leaf', id: generateId(), cwd, shellProfileId: profileId, pathContext };
}
```

- [ ] **Step 2: Update `addTab` body (lines 289–310)**

Replace the entire `addTab` method with:

```ts
addTab: (label, cwd) => {
  const { id: profileId, pathContext } = resolveDefaultProfile();
  const resolvedLabel = label || cwdBasename(cwd, pathContext);
  const leaf = createLeafWithProfile(cwd, profileId, pathContext);
  const tab: Tab = {
    id: generateId(),
    label: resolvedLabel,
    labelIsCustom: !!label,
    cwd,
    splitRoot: leaf,
    shellProfileId: profileId,
    pathContext
  };
  logTabs.debug('addTab', { tabId: tab.id, label: resolvedLabel, cwd, paneId: leaf.id });
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

- [ ] **Step 3: `duplicateTab` is fine as-is (lines 312–332)**

`duplicateTab` already delegates to `addTab(undefined, cwd)` at line 331. Since the updated `addTab` resolves the current default profile, `duplicateTab` will produce a new tab using today's default — which matches existing behavior because Phase 2 has no UI for changing the default. Phase 4 will revisit when the picker lands. No change needed.

- [ ] **Step 4: Update `addPiTab` body (lines 334–355)**

Replace the entire `addPiTab` method with:

```ts
addPiTab: (cwd) => {
  const { id: profileId, pathContext } = resolveDefaultProfile();
  const leaf: PaneLeaf = {
    type: 'leaf',
    id: generateId(),
    cwd,
    paneType: 'pi',
    shellProfileId: profileId,
    pathContext
  };
  const tab: Tab = {
    id: generateId(),
    label: 'Pi Agent',
    labelIsCustom: true,
    cwd,
    type: 'pi',
    splitRoot: leaf,
    shellProfileId: profileId,
    pathContext
  };
  logTabs.debug('addPiTab', { tabId: tab.id, cwd, paneId: leaf.id });
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

- [ ] **Step 5: No follow-up to Task 10's call sites needed**

`resetTabLabel` and `createWorktreeGroup` were updated in Task 10 to read `t.pathContext ?? 'posix'` and `sourceTab.pathContext ?? 'posix'` respectively. After Task 13 lands, new tabs carry a real `pathContext`, so the `'posix'` fallback only fires for legacy persisted tabs (acceptable).

- [ ] **Step 6: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Run all renderer tests**

Run: `npx vitest run src/renderer`
Expected: PASS. If `workspace-store.test.ts` has tests that construct `Tab`s without `shellProfileId`/`pathContext`, they still pass because those fields are optional. Tests that call `addTab(...)` indirectly observe `defaultProfile = null` (no `load()` in tests) — the helper returns `id: undefined, pathContext: 'posix'`, which is the same default as before.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts
git commit -m "feat(workspace-store): stamp shellProfileId and pathContext on new tabs"
```

---

## Task 14: Boot wiring — load shell-profiles store on app start

**Files:**
- Modify: `src/renderer/src/App.tsx` (or whichever module owns top-level boot effects)
- Modify: `src/renderer/src/hooks/use-terminal.ts`

- [ ] **Step 1: Trigger shell-profiles load on mount**

Open `src/renderer/src/App.tsx`. Near the top of the `App` component (or in whichever root component owns mount-time effects), add:

```ts
import { useEffect } from 'react';
import { useShellProfilesStore } from './store/shell-profiles-store';

// inside the component:
useEffect(() => {
  void useShellProfilesStore.getState().load();
}, []);
```

If a root effects hook already exists (search for the closest existing `useEffect(() => { void window.fleet.*; }, [])` in `App.tsx`), add the `load()` call inside that effect rather than a new one.

- [ ] **Step 2: Pass `shellProfileId` from `use-terminal.ts`**

In `src/renderer/src/hooks/use-terminal.ts`, find the `UseTerminalOptions` type (lines 14–32) and add:

```ts
export type UseTerminalOptions = {
  paneId: string;
  cwd: string;
  fontSize?: number;
  fontFamily?: string;
  scrollback?: number;
  cmd?: string;
  exitOnComplete?: boolean;
  serializedContent?: string;
  onScrollStateChange?: (isScrolledUp: boolean) => void;
  attachOnly?: boolean;
  cursorHidden?: boolean;
  workspaceId?: string;
  /** ShellProfile id used to spawn the PTY. Read from PaneLeaf by callers. */
  shellProfileId?: string;
};
```

Find the `pty.create(...)` call at lines 366–372. The current options object is:

```ts
.create({
  paneId: options.paneId,
  cwd: options.cwd,
  cmd: options.cmd,
  exitOnComplete: options.exitOnComplete,
  workspaceId: options.workspaceId
})
```

Add one new field — the rest of the call (including the `.then()` resize trick at lines 374–388) stays untouched:

```ts
.create({
  paneId: options.paneId,
  cwd: options.cwd,
  cmd: options.cmd,
  exitOnComplete: options.exitOnComplete,
  workspaceId: options.workspaceId,
  shellProfileId: options.shellProfileId
})
```

Find `restartPane` (lines 59–82) — change its signature and the inner create call:

```ts
export async function restartPane(
  paneId: string,
  cwd: string,
  workspaceId?: string,
  shellProfileId?: string
): Promise<void> {
  restartingPanes.add(paneId);
  window.fleet.pty.kill(paneId);
  createdPtys.delete(paneId);

  const term = terminalRegistry.get(paneId);
  if (term) {
    term.clear();
    term.reset();
  }

  await new Promise((r) => setTimeout(r, 100));

  createdPtys.add(paneId);
  await window.fleet.pty.create({ paneId, cwd, workspaceId, shellProfileId });
}
```

There is only one caller of `restartPane` outside `use-terminal.ts` itself — `src/renderer/src/components/settings/CopilotSection.tsx:66`. Update that line:

```ts
// before
void restartPane(leaf.id, cwd, wsId);

// after
void restartPane(leaf.id, cwd, wsId, leaf.shellProfileId);
```

`leaf.shellProfileId` may be `undefined` for legacy persisted leaves — the IPC handler defaults to `getDefaultProfileId()` in that case.

- [ ] **Step 3: Pass `leaf.shellProfileId` into `<TerminalPane>` and then into `useTerminal`**

`TerminalPane` does not have access to the leaf — it gets only `paneId, cwd, ...` props from `PaneGrid`. Add a new prop end-to-end.

3a. In `src/renderer/src/components/TerminalPane.tsx`, add to `TerminalPaneProps` (lines 11–22):

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
};
```

Destructure `shellProfileId` in the component params (around line 25–35), and pass it into the `useTerminal({...})` options object at line 39–48:

```tsx
const { focus, scrollToBottom, search, searchPrevious, clearSearch } = useTerminal(containerRef, {
  paneId,
  cwd,
  serializedContent,
  isActive,
  fontFamily,
  fontSize,
  workspaceId,
  shellProfileId,
  onScrollStateChange: setIsScrolledUp
});
```

3b. In `src/renderer/src/components/PaneGrid.tsx`, find the `<TerminalPane ... />` JSX (line 187). Add one new prop:

```tsx
shellProfileId={leaf.node.shellProfileId}
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Run renderer tests**

Run: `npx vitest run src/renderer`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/hooks/use-terminal.ts src/renderer/src/components/TerminalPane.tsx
# Plus any additional files that call restartPane
git commit -m "feat(renderer): thread shellProfileId through use-terminal and restartPane"
```

---

## Task 15: Full verification

**Files:** (none — verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS — all Phase 1 tests + all new Phase 2 tests + all pre-existing tests. Note: Phase 1 was at 493/493. Phase 2 adds approximately +20–25 tests across `shell-profiles.test.ts`, `pty-manager.test.ts`, `cwd-poller.test.ts`, `shell-profiles-store.test.ts`, and `homes-store.test.ts`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS (no new errors/warnings beyond what Phase 1 left behind). If new lint warnings show up, `npm run lint -- --fix` and commit as a `style:` cleanup commit afterward.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Manual smoke on host platform**

Run: `npm run dev`

On macOS/Linux:
- App window opens.
- New tab opens a terminal with the default shell, tab title shows `~` or basename of cwd.
- `cd ~/Downloads` updates the tab title to `Downloads` (POSIX polling unchanged).

On Windows (manual QA — see acceptance criteria below):
- New tab on Windows + WSL: opens a WSL pane in `$HOME`, tab title shows `~`.
- `cd ~/dev` updates the tab title to `dev` (OSC 7 fires only after Phase 3; for now manual `cd` won't immediately reflect — that's expected).
- New tab in PowerShell pane (via picker — not built yet — or by editing layout JSON to use `windows.powershell`): tab title shows path with backslash basename. `cd C:\Users` updates within 5s via `pid-cwd`.

If Windows host isn't available to the executor: document that as "deferred to acceptance QA on Khang's machine" in the PR description.

- [ ] **Step 6: Renderer devtools sanity check**

In devtools console:

```js
await window.fleet.shellProfiles.list()
// Expect: { profiles: [...], defaultProfileId: 'wsl.Ubuntu-22.04' | 'posix.zsh' | 'windows.powershell' }
```

- [ ] **Step 7: Commit any final cleanup**

```bash
git status
# if clean → skip commit
# if not clean → fix and commit
```

---

## Phase 2 Acceptance Criteria (from the handoff)

- ✅ On Windows: opening a new WSL pane lands in `$HOME` (`~`).
- ✅ On Windows: tab title shows `~` or a child path collapsed against `~`.
- ✅ On Windows: changing directory in a native cmd/PowerShell pane updates the tab title (poller picks it up via `pid-cwd`).
- ✅ macOS/Linux: zero regression. Existing flow still works.
- ✅ Existing tests still pass.

## Phase 2 Out-of-Scope (per handoff)

- The picker UI (Phase 4).
- Bridge socket changes (Phase 4 or 5).
- `~/.fleetrc.sh` hook installation (Phase 3 + 5).
- Persistent workspace defaults (Phase 4).
- Re-tagging OSC 7 `cwd-changed` events with `PathContext` — the renderer reads context from the leaf instead.

## Self-Review Notes

This plan covers Phase 2's three bugs:

| Bug | Tasks |
|---|---|
| WSL launches with `/mnt/c/...` instead of `$HOME` | 4 (types) + 5 (PtyManager) + 7 (IPC resolution) + 13/14 (renderer wiring) |
| Tab title shows `/mnt/c/...` instead of `~/...` | 3 (types) + 10 (cwdBasename) + 11 (TabItem) + 13 (addTab) |
| No CWD updates on Windows | 6 (cwd-poller) + 7 (poller plumbing) |

Plus the Telescope subtitle fix (`panes-mode.ts:38`) and the renderer stores needed to support both.

Open caveats from Phase 1 addressed by Phase 2:
- "`shellProfileRegistry.enumerate()` runs on every IPC call" → Task 1 caches.
- "The three path-translation IPC handlers leak raw `wsl.exe` exceptions to the renderer" → still open; not blocking Phase 2 because no caller invokes them yet. Defer to the phase that actually consumes them (Phase 4 picker / Phase 5 CLI).
