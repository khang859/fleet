# Windows + WSL Foundation (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `ShellProfile` data model, the `path-platform` pure-function module, the `WslService` translation/state class, the main-process `ShellProfileRegistry`, and the IPC plumbing — without changing any user-visible behavior.

**Architecture:** A new pair of shared modules (`shell-profiles.ts` types + `path-platform.ts` pure helpers) provides cross-process primitives. Two new main-process modules (`wsl-service.ts`, `shell-profiles.ts` registry) own state and side effects, exposed to the renderer via additions to `ipc-channels.ts`, `ipc-api.ts`, `ipc-handlers.ts`, and `preload/index.ts`. Phases 2–6 build on these primitives; this plan deliberately ships zero behavior change so failures stay localized to type checks and unit tests.

**Tech Stack:** TypeScript (strict), Electron main+preload+renderer, Node `child_process`, Vitest, existing `iconv-lite` if needed (we add it).

---

## File map

| File | Action | Purpose |
|---|---|---|
| `src/shared/shell-profiles.ts` | Create | `PathContext`, `WslDistro`, `ShellProfile`, `WslDistroState` types |
| `src/shared/path-platform.ts` | Create | Pure: `isWindowsPath`, `isWslPath`, `basename`, `join`, `displayPath` |
| `src/shared/__tests__/path-platform.test.ts` | Create | Vitest unit tests for path-platform |
| `src/main/wsl-service.ts` | Create | `WslService`: list/translate/status/warmUp |
| `src/main/__tests__/wsl-service.test.ts` | Create | Vitest unit tests for WslService |
| `src/main/shell-profiles.ts` | Create | `ShellProfileRegistry`: enumerate at startup |
| `src/main/__tests__/shell-profiles.test.ts` | Create | Vitest unit tests for registry |
| `src/shared/ipc-channels.ts` | Modify | Add `SHELL_PROFILES_LIST`, `WSL_STATUS`, `WSL_TO_WSL_PATH`, `WSL_TO_WIN_PATH`, `WSL_HOME_DIR` |
| `src/shared/ipc-api.ts` | Modify | Add request/response types |
| `src/main/ipc-handlers.ts` | Modify | Register the five new handlers |
| `src/preload/index.ts` | Modify | Expose `window.fleet.shellProfiles.*` and `window.fleet.wsl.*` |
| `src/main/index.ts` | Modify | Instantiate `WslService` + `ShellProfileRegistry` at boot |
| `package.json` | Modify | Add `iconv-lite` dep (UTF-16LE decoding) |

---

## Task 1: Shared `ShellProfile` types

**Files:**
- Create: `src/shared/shell-profiles.ts`

- [ ] **Step 1: Write the file**

```ts
// src/shared/shell-profiles.ts

/**
 * Identifies which filesystem semantics a path/process operates under.
 * - 'posix'        — macOS, Linux native
 * - 'win32'        — Windows native (PowerShell, cmd, Git Bash on Windows)
 * - { kind: 'wsl', distro } — inside a WSL distribution
 */
export type PathContext = 'posix' | 'win32' | { kind: 'wsl'; distro: string };

export type WslDistroState = 'running' | 'stopped' | 'installing' | 'error';

export type WslDistro = {
  name: string;        // e.g. 'Ubuntu-22.04'
  version: 1 | 2;
  isDefault: boolean;
  state: WslDistroState;
};

export type ShellProfileKind = 'system' | 'wsl';

export type ShellProfile = {
  /** Stable id, e.g. 'windows.powershell', 'wsl.Ubuntu-22.04', 'posix.zsh'. */
  id: string;
  kind: ShellProfileKind;
  /** Human label for pickers, e.g. 'PowerShell', 'Ubuntu (WSL)', 'zsh'. */
  label: string;
  /** Absolute path or bare name resolvable via PATH. */
  command: string;
  args: string[];
  pathContext: PathContext;
  icon?: string;
};

/** Sentinel profile id used by legacy persisted layouts before this feature shipped. */
export const LEGACY_SYSTEM_DEFAULT_ID = 'legacy.system-default';
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS (no new errors)

- [ ] **Step 3: Commit**

```bash
git add src/shared/shell-profiles.ts
git commit -m "feat(shared): add ShellProfile and PathContext types"
```

---

## Task 2: `path-platform.ts` — `isWindowsPath` and `isWslPath`

**Files:**
- Create: `src/shared/path-platform.ts`
- Create: `src/shared/__tests__/path-platform.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/shared/__tests__/path-platform.test.ts
import { describe, it, expect } from 'vitest';
import { isWindowsPath, isWslPath } from '../path-platform';

describe('isWindowsPath', () => {
  it('matches drive-letter paths with backslash', () => {
    expect(isWindowsPath('C:\\Users\\khang')).toBe(true);
  });
  it('matches drive-letter paths with forward slash', () => {
    expect(isWindowsPath('D:/projects/foo')).toBe(true);
  });
  it('matches lowercase drive letter', () => {
    expect(isWindowsPath('c:\\temp')).toBe(true);
  });
  it('rejects POSIX paths', () => {
    expect(isWindowsPath('/home/khang')).toBe(false);
  });
  it('rejects relative paths', () => {
    expect(isWindowsPath('./foo')).toBe(false);
  });
  it('rejects empty string', () => {
    expect(isWindowsPath('')).toBe(false);
  });
});

describe('isWslPath', () => {
  it('matches absolute POSIX paths', () => {
    expect(isWslPath('/home/khang')).toBe(true);
    expect(isWslPath('/mnt/c/Users/khang')).toBe(true);
  });
  it('rejects Windows paths', () => {
    expect(isWslPath('C:\\Users')).toBe(false);
  });
  it('rejects relative paths', () => {
    expect(isWslPath('home/khang')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/__tests__/path-platform.test.ts`
Expected: FAIL — "Cannot find module '../path-platform'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/path-platform.ts

const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/;

export function isWindowsPath(p: string): boolean {
  return WINDOWS_PATH_RE.test(p);
}

export function isWslPath(p: string): boolean {
  return p.startsWith('/');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/__tests__/path-platform.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/shared/path-platform.ts src/shared/__tests__/path-platform.test.ts
git commit -m "feat(shared): add isWindowsPath and isWslPath classifiers"
```

---

## Task 3: `path-platform.ts` — `basename`

**Files:**
- Modify: `src/shared/path-platform.ts`
- Modify: `src/shared/__tests__/path-platform.test.ts`

- [ ] **Step 1: Append failing tests**

Add to the existing test file:

```ts
import { basename } from '../path-platform';

describe('basename', () => {
  it('returns last segment of POSIX path', () => {
    expect(basename('/home/khang/dev/fleet', 'posix')).toBe('fleet');
  });
  it('returns last segment of Windows path with backslashes', () => {
    expect(basename('C:\\Users\\khang\\dev', 'win32')).toBe('dev');
  });
  it('returns last segment of Windows path with forward slashes', () => {
    expect(basename('C:/Users/khang/dev', 'win32')).toBe('dev');
  });
  it('returns last segment for WSL context (POSIX semantics)', () => {
    expect(basename('/home/khang/dev', { kind: 'wsl', distro: 'Ubuntu' })).toBe('dev');
  });
  it('strips trailing slashes', () => {
    expect(basename('/home/khang/', 'posix')).toBe('khang');
    expect(basename('C:\\Users\\', 'win32')).toBe('Users');
  });
  it('returns "Shell" for empty or root-only paths', () => {
    expect(basename('/', 'posix')).toBe('Shell');
    expect(basename('', 'posix')).toBe('Shell');
    expect(basename('C:\\', 'win32')).toBe('Shell');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/__tests__/path-platform.test.ts`
Expected: FAIL — "basename is not a function"

- [ ] **Step 3: Implement**

Append to `src/shared/path-platform.ts`:

```ts
function separators(ctx: PathContext): RegExp {
  return ctx === 'win32' ? /[\\/]+/ : /\/+/;
}

export function basename(p: string, ctx: PathContext): string {
  if (!p) return 'Shell';
  const sep = separators(ctx);
  const trimmed = p.replace(/[\\/]+$/, '');
  if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) return 'Shell';
  const parts = trimmed.split(sep);
  return parts[parts.length - 1] || 'Shell';
}
```

Add `import type { PathContext } from './shell-profiles';` at the top of the file if not already present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/__tests__/path-platform.test.ts`
Expected: PASS — 15 tests

- [ ] **Step 5: Commit**

```bash
git add src/shared/path-platform.ts src/shared/__tests__/path-platform.test.ts
git commit -m "feat(shared): add context-aware basename"
```

---

## Task 4: `path-platform.ts` — `join`

**Files:**
- Modify: `src/shared/path-platform.ts`
- Modify: `src/shared/__tests__/path-platform.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
import { join } from '../path-platform';

describe('join', () => {
  it('joins POSIX with forward slash', () => {
    expect(join('posix', '/home', 'khang', 'dev')).toBe('/home/khang/dev');
  });
  it('joins Windows with backslash', () => {
    expect(join('win32', 'C:\\', 'Users', 'khang')).toBe('C:\\Users\\khang');
  });
  it('joins WSL with forward slash', () => {
    expect(join({ kind: 'wsl', distro: 'Ubuntu' }, '/home', 'khang')).toBe('/home/khang');
  });
  it('collapses doubled separators', () => {
    expect(join('posix', '/home/', '/khang/', 'dev')).toBe('/home/khang/dev');
    expect(join('win32', 'C:\\Users\\', '\\khang')).toBe('C:\\Users\\khang');
  });
  it('ignores empty segments', () => {
    expect(join('posix', '/home', '', 'khang')).toBe('/home/khang');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/__tests__/path-platform.test.ts`
Expected: FAIL — "join is not a function"

- [ ] **Step 3: Implement**

Append to `src/shared/path-platform.ts`:

```ts
export function join(ctx: PathContext, ...segments: string[]): string {
  const sep = ctx === 'win32' ? '\\' : '/';
  const cleaned = segments
    .filter((s) => s.length > 0)
    .map((s, i) => {
      // Strip leading separators on all but the first segment
      // Strip trailing separators on all but the last
      let out = s;
      if (i > 0) out = out.replace(/^[\\/]+/, '');
      if (i < segments.length - 1) out = out.replace(/[\\/]+$/, '');
      return out;
    })
    .filter((s) => s.length > 0);
  return cleaned.join(sep);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/__tests__/path-platform.test.ts`
Expected: PASS — 20 tests

- [ ] **Step 5: Commit**

```bash
git add src/shared/path-platform.ts src/shared/__tests__/path-platform.test.ts
git commit -m "feat(shared): add context-aware path join"
```

---

## Task 5: `path-platform.ts` — `displayPath`

**Files:**
- Modify: `src/shared/path-platform.ts`
- Modify: `src/shared/__tests__/path-platform.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
import { displayPath } from '../path-platform';

describe('displayPath', () => {
  const homes = { homeDir: 'C:\\Users\\khang', wslHomeByDistro: { Ubuntu: '/home/khang' } };

  it('collapses Windows home to ~', () => {
    expect(displayPath('C:\\Users\\khang\\dev', 'win32', homes)).toBe('~\\dev');
  });
  it('collapses POSIX home to ~', () => {
    expect(displayPath('/Users/khang/dev', 'posix', { homeDir: '/Users/khang', wslHomeByDistro: {} })).toBe('~/dev');
  });
  it('collapses WSL home to ~ when distro home is known', () => {
    expect(displayPath('/home/khang/dev', { kind: 'wsl', distro: 'Ubuntu' }, homes)).toBe('~/dev');
  });
  it('collapses /mnt/c/Users/khang/... to ~/... when win-home is C:\\Users\\khang', () => {
    expect(displayPath('/mnt/c/Users/khang/dev', { kind: 'wsl', distro: 'Ubuntu' }, homes)).toBe('~/dev');
  });
  it('leaves /mnt/c/... uncollapsed when not under win-home', () => {
    expect(displayPath('/mnt/c/Program Files', { kind: 'wsl', distro: 'Ubuntu' }, homes)).toBe('/mnt/c/Program Files');
  });
  it('returns path unchanged when no rule matches', () => {
    expect(displayPath('D:\\Other', 'win32', homes)).toBe('D:\\Other');
    expect(displayPath('/etc/hosts', { kind: 'wsl', distro: 'Ubuntu' }, homes)).toBe('/etc/hosts');
  });
  it('handles exact home (no trailing path)', () => {
    expect(displayPath('C:\\Users\\khang', 'win32', homes)).toBe('~');
    expect(displayPath('/home/khang', { kind: 'wsl', distro: 'Ubuntu' }, homes)).toBe('~');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/__tests__/path-platform.test.ts`
Expected: FAIL — "displayPath is not a function"

- [ ] **Step 3: Implement**

Append to `src/shared/path-platform.ts`:

```ts
type DisplayPathHomes = {
  homeDir: string;
  /** Map of distro name → POSIX home inside the distro (e.g. '/home/khang'). */
  wslHomeByDistro: Record<string, string>;
};

function winToWslMountPath(winPath: string): string | null {
  // C:\Users\khang → /mnt/c/Users/khang
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return null;
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}

export function displayPath(p: string, ctx: PathContext, homes: DisplayPathHomes): string {
  if (!p) return '';

  if (ctx === 'win32') {
    if (homes.homeDir && p === homes.homeDir) return '~';
    if (homes.homeDir && p.startsWith(homes.homeDir + '\\')) {
      return '~' + p.slice(homes.homeDir.length);
    }
    return p;
  }

  if (ctx === 'posix') {
    if (homes.homeDir && p === homes.homeDir) return '~';
    if (homes.homeDir && p.startsWith(homes.homeDir + '/')) {
      return '~' + p.slice(homes.homeDir.length);
    }
    return p;
  }

  // WSL
  const wslHome = homes.wslHomeByDistro[ctx.distro];
  if (wslHome) {
    if (p === wslHome) return '~';
    if (p.startsWith(wslHome + '/')) return '~' + p.slice(wslHome.length);
  }
  // /mnt/c/Users/khang → ~/  (when win-home matches)
  const mounted = homes.homeDir ? winToWslMountPath(homes.homeDir) : null;
  if (mounted) {
    if (p === mounted) return '~';
    if (p.startsWith(mounted + '/')) return '~' + p.slice(mounted.length);
  }
  return p;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/__tests__/path-platform.test.ts`
Expected: PASS — 27 tests

- [ ] **Step 5: Commit**

```bash
git add src/shared/path-platform.ts src/shared/__tests__/path-platform.test.ts
git commit -m "feat(shared): add context-aware displayPath with WSL home collapse"
```

---

## Task 6: WslService — `parseListVerbose` UTF-16LE parser

**Files:**
- Create: `src/main/wsl-service.ts`
- Create: `src/main/__tests__/wsl-service.test.ts`
- Modify: `package.json` (add `iconv-lite`)

- [ ] **Step 1: Add iconv-lite dependency**

```bash
npm install iconv-lite
```

Expected: adds `iconv-lite` to dependencies.

- [ ] **Step 2: Write the failing test**

```ts
// src/main/__tests__/wsl-service.test.ts
import { describe, it, expect } from 'vitest';
import { parseListVerbose } from '../wsl-service';

describe('parseListVerbose', () => {
  it('parses a real-world wsl --list --verbose output (UTF-16LE)', () => {
    // Simulated output: '  NAME            STATE           VERSION\n* Ubuntu-22.04    Running         2\n  Debian          Stopped         2\n'
    const utf8 =
      '  NAME            STATE           VERSION\r\n' +
      '* Ubuntu-22.04    Running         2\r\n' +
      '  Debian          Stopped         2\r\n';
    // Encode to UTF-16LE with BOM to match wsl.exe output
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.from(utf8, 'utf16le');
    const utf16le = Buffer.concat([bom, body]);

    const distros = parseListVerbose(utf16le);

    expect(distros).toEqual([
      { name: 'Ubuntu-22.04', version: 2, isDefault: true, state: 'running' },
      { name: 'Debian', version: 2, isDefault: false, state: 'stopped' }
    ]);
  });

  it('handles output with no default distro asterisk', () => {
    const utf8 = '  NAME      STATE     VERSION\r\n  Alpine    Running   2\r\n';
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf8, 'utf16le')]);
    const distros = parseListVerbose(utf16le);
    expect(distros).toEqual([{ name: 'Alpine', version: 2, isDefault: false, state: 'running' }]);
  });

  it('returns empty array when no distros are listed', () => {
    const utf8 = 'Windows Subsystem for Linux has no installed distributions.\r\n';
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf8, 'utf16le')]);
    expect(parseListVerbose(utf16le)).toEqual([]);
  });

  it('maps Installing state', () => {
    const utf8 = '  NAME      STATE        VERSION\r\n  Ubuntu    Installing   2\r\n';
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf8, 'utf16le')]);
    const distros = parseListVerbose(utf16le);
    expect(distros[0].state).toBe('installing');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/wsl-service.test.ts`
Expected: FAIL — "Cannot find module '../wsl-service'"

- [ ] **Step 4: Implement parser**

```ts
// src/main/wsl-service.ts
import iconv from 'iconv-lite';
import type { WslDistro, WslDistroState } from '../shared/shell-profiles';

function decodeWslOutput(buf: Buffer): string {
  // wsl.exe emits UTF-16LE with a BOM on stdout.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return iconv.decode(buf.slice(2), 'utf-16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return iconv.decode(buf.slice(2), 'utf-16be');
  }
  // Fallback: treat as utf-8.
  return buf.toString('utf-8');
}

function mapState(raw: string): WslDistroState {
  const s = raw.toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'stopped') return 'stopped';
  if (s === 'installing') return 'installing';
  return 'error';
}

export function parseListVerbose(buf: Buffer): WslDistro[] {
  const text = decodeWslOutput(buf);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const distros: WslDistro[] = [];

  for (const line of lines) {
    // Header line starts with whitespace then 'NAME'
    if (/^\s*NAME\b/i.test(line)) continue;
    // Friendly "no distributions" line
    if (/no installed distributions/i.test(line)) continue;

    // Format: "[*] <name> <state> <version>" — leading "* " marks default
    const m = /^(\*?\s*)(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const isDefault = m[1].includes('*');
    const name = m[2];
    const state = mapState(m[3]);
    const versionRaw = parseInt(m[4], 10);
    const version: 1 | 2 = versionRaw === 1 ? 1 : 2;

    distros.push({ name, version, isDefault, state });
  }

  return distros;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/wsl-service.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/main/wsl-service.ts src/main/__tests__/wsl-service.test.ts
git commit -m "feat(wsl): add UTF-16LE parser for wsl --list --verbose"
```

---

## Task 7: WslService — class skeleton + `listDistros`

**Files:**
- Modify: `src/main/wsl-service.ts`
- Modify: `src/main/__tests__/wsl-service.test.ts`

- [ ] **Step 1: Append failing test**

```ts
import { WslService } from '../wsl-service';
import { vi } from 'vitest';

describe('WslService.listDistros', () => {
  it('invokes wsl.exe --list --verbose and parses output', async () => {
    const utf8 = '  NAME      STATE     VERSION\r\n* Ubuntu    Running   2\r\n';
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf8, 'utf16le')]);

    const exec = vi.fn().mockResolvedValue({ stdout: utf16le, stderr: Buffer.alloc(0) });
    const svc = new WslService({ exec });

    const distros = await svc.listDistros();

    expect(exec).toHaveBeenCalledWith('wsl.exe', ['--list', '--verbose'], expect.anything());
    expect(distros).toEqual([
      { name: 'Ubuntu', version: 2, isDefault: true, state: 'running' }
    ]);
  });

  it('returns empty array when wsl.exe exits non-zero', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('wsl not installed'));
    const svc = new WslService({ exec });
    expect(await svc.listDistros()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/wsl-service.test.ts`
Expected: FAIL — "WslService is not a constructor"

- [ ] **Step 3: Implement class + `listDistros`**

Append to `src/main/wsl-service.ts`:

```ts
import { spawn } from 'child_process';
import type { SpawnOptions } from 'child_process';

/** Minimal exec contract — allows mocking in tests without pulling in execa. */
export type WslExec = (
  command: string,
  args: string[],
  options?: SpawnOptions
) => Promise<{ stdout: Buffer; stderr: Buffer }>;

const defaultExec: WslExec = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => stdout.push(c));
    child.stderr?.on('data', (c: Buffer) => stderr.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      else reject(new Error(`${command} exited with code ${code}: ${Buffer.concat(stderr).toString('utf-8')}`));
    });
  });

export type WslServiceOptions = {
  exec?: WslExec;
};

export class WslService {
  private exec: WslExec;

  constructor(opts: WslServiceOptions = {}) {
    this.exec = opts.exec ?? defaultExec;
  }

  async listDistros(): Promise<WslDistro[]> {
    try {
      const { stdout } = await this.exec('wsl.exe', ['--list', '--verbose']);
      return parseListVerbose(stdout);
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/wsl-service.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/wsl-service.ts src/main/__tests__/wsl-service.test.ts
git commit -m "feat(wsl): add WslService.listDistros"
```

---

## Task 8: WslService — `homeDir` with cache

**Files:**
- Modify: `src/main/wsl-service.ts`
- Modify: `src/main/__tests__/wsl-service.test.ts`

- [ ] **Step 1: Append failing test**

```ts
describe('WslService.homeDir', () => {
  it('runs sh -c "echo $HOME" inside the distro and caches', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: Buffer.from('/home/khang\n', 'utf-8'), stderr: Buffer.alloc(0) });
    const svc = new WslService({ exec });

    expect(await svc.homeDir('Ubuntu')).toBe('/home/khang');
    expect(await svc.homeDir('Ubuntu')).toBe('/home/khang'); // cached, no second exec

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'sh', '-c', 'printf %s "$HOME"'],
      expect.anything()
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/wsl-service.test.ts`
Expected: FAIL — "svc.homeDir is not a function"

- [ ] **Step 3: Implement**

Append to the `WslService` class:

```ts
  private homeDirCache = new Map<string, string>();

  async homeDir(distro: string): Promise<string> {
    const cached = this.homeDirCache.get(distro);
    if (cached !== undefined) return cached;

    const { stdout } = await this.exec(
      'wsl.exe',
      ['-d', distro, '--exec', 'sh', '-c', 'printf %s "$HOME"']
    );
    const home = stdout.toString('utf-8').trim();
    this.homeDirCache.set(distro, home);
    return home;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/wsl-service.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/wsl-service.ts src/main/__tests__/wsl-service.test.ts
git commit -m "feat(wsl): add WslService.homeDir with cache"
```

---

## Task 9: WslService — `toWslPath` + `toWinPath` with cache

**Files:**
- Modify: `src/main/wsl-service.ts`
- Modify: `src/main/__tests__/wsl-service.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
describe('WslService path translation', () => {
  it('toWslPath shells out to wslpath -u and caches', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: Buffer.from('/mnt/c/Users/khang\n', 'utf-8'), stderr: Buffer.alloc(0) });
    const svc = new WslService({ exec });

    expect(await svc.toWslPath('Ubuntu', 'C:\\Users\\khang')).toBe('/mnt/c/Users/khang');
    expect(await svc.toWslPath('Ubuntu', 'C:\\Users\\khang')).toBe('/mnt/c/Users/khang');

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'wslpath', '-u', 'C:\\Users\\khang'],
      expect.anything()
    );
  });

  it('toWinPath shells out to wslpath -w', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: Buffer.from('C:\\Users\\khang\r\n', 'utf-8'), stderr: Buffer.alloc(0) });
    const svc = new WslService({ exec });

    expect(await svc.toWinPath('Ubuntu', '/mnt/c/Users/khang')).toBe('C:\\Users\\khang');
    expect(exec).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'wslpath', '-w', '/mnt/c/Users/khang'],
      expect.anything()
    );
  });

  it('throws on wslpath failure (caller decides what to do)', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('wslpath: ENOENT'));
    const svc = new WslService({ exec });
    await expect(svc.toWslPath('Ubuntu', 'C:\\nope')).rejects.toThrow('wslpath');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/wsl-service.test.ts`
Expected: FAIL — "toWslPath is not a function"

- [ ] **Step 3: Implement**

Append to the `WslService` class:

```ts
  private toWslPathCache = new Map<string, string>();
  private toWinPathCache = new Map<string, string>();

  async toWslPath(distro: string, winPath: string): Promise<string> {
    const key = `${distro}:${winPath}`;
    const cached = this.toWslPathCache.get(key);
    if (cached !== undefined) return cached;

    const { stdout } = await this.exec(
      'wsl.exe',
      ['-d', distro, '--exec', 'wslpath', '-u', winPath]
    );
    const out = stdout.toString('utf-8').trim();
    this.toWslPathCache.set(key, out);
    return out;
  }

  async toWinPath(distro: string, wslPath: string): Promise<string> {
    const key = `${distro}:${wslPath}`;
    const cached = this.toWinPathCache.get(key);
    if (cached !== undefined) return cached;

    const { stdout } = await this.exec(
      'wsl.exe',
      ['-d', distro, '--exec', 'wslpath', '-w', wslPath]
    );
    const out = stdout.toString('utf-8').trim();
    this.toWinPathCache.set(key, out);
    return out;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/wsl-service.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/wsl-service.ts src/main/__tests__/wsl-service.test.ts
git commit -m "feat(wsl): add wslpath translation with caching"
```

---

## Task 10: WslService — `status` from `--list --running`

**Files:**
- Modify: `src/main/wsl-service.ts`
- Modify: `src/main/__tests__/wsl-service.test.ts`

- [ ] **Step 1: Append failing test**

```ts
describe('WslService.status', () => {
  it('returns running when distro is in --list --running output', async () => {
    const utf8 = '  NAME      STATE     VERSION\r\n* Ubuntu    Running   2\r\n';
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf8, 'utf16le')]);
    const exec = vi.fn().mockResolvedValue({ stdout: utf16le, stderr: Buffer.alloc(0) });
    const svc = new WslService({ exec });

    expect(await svc.status('Ubuntu')).toBe('running');
    expect(exec).toHaveBeenCalledWith('wsl.exe', ['--list', '--running', '--verbose'], expect.anything());
  });

  it('returns stopped when distro is not in running list but is registered', async () => {
    const runningOut = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('There are no running distributions.\r\n', 'utf16le')]);
    const verboseOut = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('  NAME    STATE     VERSION\r\n  Ubuntu  Stopped   2\r\n', 'utf16le')]);

    const exec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('--running')) return Promise.resolve({ stdout: runningOut, stderr: Buffer.alloc(0) });
      return Promise.resolve({ stdout: verboseOut, stderr: Buffer.alloc(0) });
    });
    const svc = new WslService({ exec });

    expect(await svc.status('Ubuntu')).toBe('stopped');
  });

  it('returns error when wsl.exe fails', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('service down'));
    const svc = new WslService({ exec });
    expect(await svc.status('Ubuntu')).toBe('error');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/wsl-service.test.ts`
Expected: FAIL — "svc.status is not a function"

- [ ] **Step 3: Implement**

Append to the `WslService` class:

```ts
  async status(distro: string): Promise<WslDistroState> {
    try {
      const { stdout } = await this.exec('wsl.exe', ['--list', '--running', '--verbose']);
      const running = parseListVerbose(stdout);
      if (running.some((d) => d.name === distro)) return 'running';
      const all = await this.listDistros();
      const found = all.find((d) => d.name === distro);
      return found ? found.state : 'error';
    } catch {
      return 'error';
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/wsl-service.test.ts`
Expected: PASS — 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/wsl-service.ts src/main/__tests__/wsl-service.test.ts
git commit -m "feat(wsl): add WslService.status"
```

---

## Task 11: WslService — `warmUp` fire-and-forget

**Files:**
- Modify: `src/main/wsl-service.ts`
- Modify: `src/main/__tests__/wsl-service.test.ts`

- [ ] **Step 1: Append failing test**

```ts
describe('WslService.warmUp', () => {
  it('spawns wsl -d <distro> --exec true and swallows errors', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    const svc = new WslService({ exec });

    svc.warmUp('Ubuntu');
    // Allow microtask queue to drain
    await Promise.resolve();
    await Promise.resolve();

    expect(exec).toHaveBeenCalledWith('wsl.exe', ['-d', 'Ubuntu', '--exec', 'true'], expect.anything());
  });

  it('does not throw when exec rejects', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('cold start failed'));
    const svc = new WslService({ exec });

    expect(() => svc.warmUp('Ubuntu')).not.toThrow();
    await Promise.resolve();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/wsl-service.test.ts`
Expected: FAIL — "svc.warmUp is not a function"

- [ ] **Step 3: Implement**

Append to the `WslService` class:

```ts
  warmUp(distro: string): void {
    void this.exec('wsl.exe', ['-d', distro, '--exec', 'true']).catch(() => {
      // Intentional: warmUp is best-effort
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/wsl-service.test.ts`
Expected: PASS — 15 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/wsl-service.ts src/main/__tests__/wsl-service.test.ts
git commit -m "feat(wsl): add WslService.warmUp"
```

---

## Task 12: ShellProfileRegistry — enumerate at startup

**Files:**
- Create: `src/main/shell-profiles.ts`
- Create: `src/main/__tests__/shell-profiles.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/__tests__/shell-profiles.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ShellProfileRegistry } from '../shell-profiles';
import type { WslService } from '../wsl-service';

function fakeWsl(distros: Array<{ name: string; isDefault?: boolean }>): Partial<WslService> {
  return {
    listDistros: vi.fn().mockResolvedValue(
      distros.map((d) => ({ name: d.name, version: 2 as const, isDefault: !!d.isDefault, state: 'stopped' as const }))
    )
  };
}

describe('ShellProfileRegistry', () => {
  it('emits a single posix profile from SHELL on darwin', async () => {
    const reg = new ShellProfileRegistry({
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      wslService: fakeWsl([]) as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    const profiles = await reg.enumerate();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      id: 'posix.zsh',
      kind: 'system',
      command: '/bin/zsh',
      pathContext: 'posix'
    });
  });

  it('emits PowerShell, cmd, and one profile per WSL distro on win32', async () => {
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: {},
      wslService: fakeWsl([
        { name: 'Ubuntu-22.04', isDefault: true },
        { name: 'Debian' }
      ]) as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    const profiles = await reg.enumerate();
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain('windows.powershell');
    expect(ids).toContain('windows.cmd');
    expect(ids).toContain('wsl.Ubuntu-22.04');
    expect(ids).toContain('wsl.Debian');

    const ubuntu = profiles.find((p) => p.id === 'wsl.Ubuntu-22.04')!;
    expect(ubuntu.pathContext).toEqual({ kind: 'wsl', distro: 'Ubuntu-22.04' });
    expect(ubuntu.command).toBe('wsl.exe');
    expect(ubuntu.args).toEqual(['-d', 'Ubuntu-22.04']);
  });

  it('includes Git Bash on win32 only when the binary is present', async () => {
    const fileExists = vi.fn().mockImplementation((p: string) => p.includes('Git\\bin\\bash.exe'));
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: { 'ProgramFiles': 'C:\\Program Files' },
      wslService: fakeWsl([]) as WslService,
      fileExists
    });
    const profiles = await reg.enumerate();
    expect(profiles.some((p) => p.id === 'windows.git-bash')).toBe(true);
  });

  it('does not include Git Bash when the binary is absent', async () => {
    const reg = new ShellProfileRegistry({
      platform: 'win32',
      env: { 'ProgramFiles': 'C:\\Program Files' },
      wslService: fakeWsl([]) as WslService,
      fileExists: vi.fn().mockReturnValue(false)
    });
    const profiles = await reg.enumerate();
    expect(profiles.some((p) => p.id === 'windows.git-bash')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/shell-profiles.test.ts`
Expected: FAIL — "Cannot find module '../shell-profiles'"

- [ ] **Step 3: Implement**

```ts
// src/main/shell-profiles.ts
import { basename as pathBasename, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ShellProfile } from '../shared/shell-profiles';
import type { WslService } from './wsl-service';

export type RegistryDeps = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  wslService: WslService;
  fileExists: (p: string) => boolean;
};

export class ShellProfileRegistry {
  constructor(private deps: RegistryDeps) {}

  async enumerate(): Promise<ShellProfile[]> {
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
      const gitBash = join(programFiles, 'Git', 'bin', 'bash.exe');
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

export const defaultFileExists = (p: string): boolean => existsSync(p);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/shell-profiles.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/shell-profiles.ts src/main/__tests__/shell-profiles.test.ts
git commit -m "feat(main): add ShellProfileRegistry"
```

---

## Task 13: IPC channels — add five new constants

**Files:**
- Modify: `src/shared/ipc-channels.ts`

- [ ] **Step 1: Add the constants**

Inside the `IPC_CHANNELS` object literal in `src/shared/ipc-channels.ts`, after the existing `SHELL_OPEN_EXTERNAL` line (currently line 43), add:

```ts
  SHELL_PROFILES_LIST: 'shell:profiles:list',
  WSL_STATUS: 'wsl:status',
  WSL_TO_WSL_PATH: 'wsl:to-wsl-path',
  WSL_TO_WIN_PATH: 'wsl:to-win-path',
  WSL_HOME_DIR: 'wsl:home-dir',
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc-channels.ts
git commit -m "feat(ipc): add channels for shell profiles and WSL service"
```

---

## Task 14: IPC API types

**Files:**
- Modify: `src/shared/ipc-api.ts`

- [ ] **Step 1: Add the import at the top of the file**

In `src/shared/ipc-api.ts`, the file currently begins with:

```ts
import type { Workspace, NotificationEvent, ActivityState } from './types';
```

Add a second import line immediately below it:

```ts
import type { ShellProfile, WslDistroState } from './shell-profiles';
```

- [ ] **Step 2: Append the request/response types**

At the end of `src/shared/ipc-api.ts`, append:

```ts
export type ShellProfilesListResponse = {
  profiles: ShellProfile[];
};

export type WslStatusRequest = {
  distro: string;
};

export type WslStatusResponse = {
  state: WslDistroState;
};

export type WslPathRequest = {
  distro: string;
  path: string;
};

export type WslPathResponse = {
  translated: string;
};

export type WslHomeDirRequest = {
  distro: string;
};

export type WslHomeDirResponse = {
  homeDir: string;
};
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-api.ts
git commit -m "feat(ipc): add request/response types for shell profiles and WSL"
```

---

## Task 15: Register IPC handlers in main process

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Locate the existing `registerIpcHandlers` signature**

Open `src/main/ipc-handlers.ts` and read the top of the file (around lines 1–80) to identify the existing parameter shape for `registerIpcHandlers`. Add the new services to it:

```ts
// Add to imports at top of file
import type { ShellProfileRegistry } from './shell-profiles';
import type { WslService } from './wsl-service';
import type {
  ShellProfilesListResponse,
  WslHomeDirRequest,
  WslHomeDirResponse,
  WslPathRequest,
  WslPathResponse,
  WslStatusRequest,
  WslStatusResponse
} from '../shared/ipc-api';
```

Extend the parameter object passed into `registerIpcHandlers` to include:

```ts
{
  // ...existing
  shellProfileRegistry: ShellProfileRegistry,
  wslService: WslService
}
```

- [ ] **Step 2: Register the five handlers**

At the bottom of `registerIpcHandlers` (just before the closing brace), add:

```ts
  ipcMain.handle(IPC_CHANNELS.SHELL_PROFILES_LIST, async (): Promise<ShellProfilesListResponse> => {
    const profiles = await shellProfileRegistry.enumerate();
    return { profiles };
  });

  ipcMain.handle(IPC_CHANNELS.WSL_STATUS, async (_event, req: WslStatusRequest): Promise<WslStatusResponse> => {
    const state = await wslService.status(req.distro);
    return { state };
  });

  ipcMain.handle(IPC_CHANNELS.WSL_TO_WSL_PATH, async (_event, req: WslPathRequest): Promise<WslPathResponse> => {
    const translated = await wslService.toWslPath(req.distro, req.path);
    return { translated };
  });

  ipcMain.handle(IPC_CHANNELS.WSL_TO_WIN_PATH, async (_event, req: WslPathRequest): Promise<WslPathResponse> => {
    const translated = await wslService.toWinPath(req.distro, req.path);
    return { translated };
  });

  ipcMain.handle(IPC_CHANNELS.WSL_HOME_DIR, async (_event, req: WslHomeDirRequest): Promise<WslHomeDirResponse> => {
    const homeDir = await wslService.homeDir(req.distro);
    return { homeDir };
  });
```

- [ ] **Step 3: Update the call site in `src/main/index.ts`**

Find the existing `registerIpcHandlers({...})` call in `src/main/index.ts`. Before it, add:

```ts
import { WslService } from './wsl-service';
import { ShellProfileRegistry, defaultFileExists } from './shell-profiles';

// ...in the app-ready / boot block, before registerIpcHandlers:
const wslService = new WslService();
const shellProfileRegistry = new ShellProfileRegistry({
  platform: process.platform,
  env: process.env,
  wslService,
  fileExists: defaultFileExists
});
```

Then extend the `registerIpcHandlers({...})` arguments to include `wslService` and `shellProfileRegistry`.

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Verify dev server boots cleanly**

Run: `npm run dev` (then Ctrl+C after the window appears and the log line "registered IPC handlers" prints — or your closest existing equivalent).
Expected: no startup errors; app window opens normally.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/index.ts
git commit -m "feat(main): wire ShellProfileRegistry and WslService into IPC"
```

---

## Task 16: Preload bridge — expose `window.fleet.shellProfiles` and `window.fleet.wsl`

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add imports for the new types**

Near the top of `src/preload/index.ts`, in the import block from `'../shared/ipc-api'`, add:

```ts
import type {
  // ...existing
  ShellProfilesListResponse,
  WslStatusResponse,
  WslPathResponse,
  WslHomeDirResponse
} from '../shared/ipc-api';
import type { ShellProfile, WslDistroState } from '../shared/shell-profiles';
```

- [ ] **Step 2: Add the bridge functions to the `fleetApi` object**

Inside the `fleetApi` object literal (which currently ends around line 380 with `piEnv: {...}`), add two new top-level sections (preserve the trailing comma on `piEnv`):

```ts
  shellProfiles: {
    list: async (): Promise<ShellProfile[]> => {
      const res = await typedInvoke<ShellProfilesListResponse>(IPC_CHANNELS.SHELL_PROFILES_LIST);
      return res.profiles;
    }
  },
  wsl: {
    status: async (distro: string): Promise<WslDistroState> => {
      const res = await typedInvoke<WslStatusResponse>(IPC_CHANNELS.WSL_STATUS, { distro });
      return res.state;
    },
    toWslPath: async (distro: string, path: string): Promise<string> => {
      const res = await typedInvoke<WslPathResponse>(IPC_CHANNELS.WSL_TO_WSL_PATH, { distro, path });
      return res.translated;
    },
    toWinPath: async (distro: string, path: string): Promise<string> => {
      const res = await typedInvoke<WslPathResponse>(IPC_CHANNELS.WSL_TO_WIN_PATH, { distro, path });
      return res.translated;
    },
    homeDir: async (distro: string): Promise<string> => {
      const res = await typedInvoke<WslHomeDirResponse>(IPC_CHANNELS.WSL_HOME_DIR, { distro });
      return res.homeDir;
    }
  }
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Smoke-test the bridge from devtools**

Run: `npm run dev`
Once the window appears, open the renderer devtools (Cmd/Ctrl+Shift+I). In the console:

```js
await window.fleet.shellProfiles.list()
```

Expected on macOS/Linux: `[ { id: 'posix.zsh', kind: 'system', ... } ]`
Expected on Windows: `[ { id: 'windows.powershell', ... }, ..., { id: 'wsl.Ubuntu-22.04', ... } ]`

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(preload): expose shellProfiles and wsl bridges"
```

---

## Task 17: Full verification

**Files:**
- (none — verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all new tests + all pre-existing tests still pass.

- [ ] **Step 2: Run the full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run the linter**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Build the app**

Run: `npm run build`
Expected: PASS (no errors). This proves the production bundles type-check and lint clean.

- [ ] **Step 5: Manual smoke**

Run: `npm run dev`
- App window opens normally.
- Existing terminal panes still spawn and work (no regression — we have not changed PtyManager).
- In devtools console: `await window.fleet.shellProfiles.list()` returns at least one profile.

- [ ] **Step 6: Commit any final cleanup** (only if anything changed during verification)

```bash
git status
# if clean → skip commit
# if not clean → fix and commit
```

---

## Self-Review Notes

This plan covers, from the spec:

- Spec §"Data model" → Task 1
- Spec §"Module map" / `path-platform.ts` → Tasks 2–5
- Spec §"Path translation: WslService" → Tasks 6–11
- Spec §"ShellProfileRegistry" (under Module map) → Task 12
- Spec §"Architecture" IPC requirements (`getShellProfiles`, `getWslStatus`, `toWslPath`, `toWinPath`, `getWslHome`) → Tasks 13–16
- Spec §"Pitfalls" UTF-16LE handling → Task 6 (explicitly tested with BOM fixture)
- Spec §"Pitfalls" `wslpath` as the translator → Tasks 9
- Spec §"Goals" "No regressions for macOS/Linux/Win-without-WSL" → Task 17 step 5

Out of scope (deferred to later phases):

- `pty-manager` integration (Phase 2)
- `cwd-poller` Windows + WSL paths (Phase 3)
- Picker UI, overlay, status bar (Phases 3–6)
- CLI / hook installation inside WSL (Phase 5)
