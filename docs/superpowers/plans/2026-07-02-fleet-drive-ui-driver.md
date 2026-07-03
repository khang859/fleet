# fleet-drive UI Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent attach to the live `npm run dev` Fleet window over CDP and screenshot, snapshot, click, type, send key chords, and evaluate JavaScript in the renderer, closing the UI feedback loop.

**Architecture:** The dev-mode Electron process enables a per-checkout Chrome DevTools Protocol port and writes a discovery file. A `tsx` CLI (`scripts/drive/`) connects over CDP via Playwright, positively resolves this checkout's main window, runs one verb, and disconnects. No daemon; the running dev app is the persistent session.

**Tech Stack:** Electron 39, electron-vite, React 19, zustand, TypeScript, Playwright (dev-only, CDP attach), sharp (blank-frame detection), vitest, tsx.

## Global Constraints

- Dev-only: every capability is gated on `IS_FLEET_DEV` (main) or `import.meta.env.DEV` (renderer). Nothing ships in a packaged build.
- The debug port binds to loopback only; never expose it beyond `127.0.0.1`.
- No unsafe type assertions in `src/**` (repo eslint bans `as` casts); use zod/validation or typed parsing. `as` is allowed only in test files.
- Match existing code style. Sentences in Markdown docs each go on their own line.
- Verification commands: `npm run typecheck`, `npm run lint`, `npm test`.
- Do not hand-edit `CHANGELOG.md`.
- Reference spec: `docs/superpowers/specs/2026-07-02-fleet-drive-ui-driver-design.md`.

## File Structure

- `src/shared/drive-session.ts` (new) — pure helpers shared by main and the CLI: `deriveDebugPort`, `sessionFilePath`, `DriveSession` type. No IO, no fs.
- `src/main/index.ts` (modify) — append the debug-port switch before app-ready, set `backgroundThrottling: false` on the dev window, write the discovery file on load.
- `scripts/drive/core.ts` (new) — CDP connect + positive main-window resolution.
- `scripts/drive/selectors.ts` (new) — thin selector resolver (`testid=` mapping + pass-through).
- `scripts/drive/verbs.ts` (new) — verb implementations (screenshot/snapshot/click/type/keys/eval) + blank-frame detection.
- `scripts/drive/cli.ts` (new) — arg parsing + dispatch, run via tsx.
- `scripts/drive/README.md` (new) — usage.
- `src/renderer/src/main.tsx` (modify) — dev-only `window.__FLEET__` store bridge.
- `src/renderer/src/env.d.ts` (modify) — `Window.__FLEET__` type.
- `package.json` (modify) — `playwright` devDep, `drive` script.
- `.gitignore` (modify) — ignore `.fleet-drive/`.

---

### Task 1: Shared session helper + main-process debug port & discovery file

**Files:**
- Create: `src/shared/drive-session.ts`
- Test: `src/shared/__tests__/drive-session.test.ts`
- Modify: `src/main/index.ts` (imports; module-level switch after `app.setName('Fleet')` ~line 318; `webPreferences` in `createWindow` ~line 242; end of `createWindow` ~line 314)

**Interfaces:**
- Produces: `deriveDebugPort(appPath: string, override?: string): number`, `sessionFilePath(cwd: string): string`, `interface DriveSession { port: number; rendererUrl: string; pid: number }`.

- [ ] **Step 1: Write the failing test**

Create `src/shared/__tests__/drive-session.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveDebugPort, sessionFilePath } from '../drive-session';

describe('deriveDebugPort', () => {
  it('returns a valid override port verbatim', () => {
    expect(deriveDebugPort('/any/path', '9333')).toBe(9333);
  });

  it('ignores an empty override and derives from the path', () => {
    const port = deriveDebugPort('/Users/x/fleet', '');
    expect(port).toBeGreaterThanOrEqual(41000);
    expect(port).toBeLessThan(61000);
  });

  it('ignores a non-numeric override', () => {
    const port = deriveDebugPort('/Users/x/fleet', 'not-a-port');
    expect(port).toBeGreaterThanOrEqual(41000);
  });

  it('is deterministic for the same path', () => {
    expect(deriveDebugPort('/a/b/c')).toBe(deriveDebugPort('/a/b/c'));
  });

  it('differs across worktree paths', () => {
    expect(deriveDebugPort('/wt/one')).not.toBe(deriveDebugPort('/wt/two'));
  });
});

describe('sessionFilePath', () => {
  it('places the session file under .fleet-drive', () => {
    expect(sessionFilePath('/repo')).toBe('/repo/.fleet-drive/session.json');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/__tests__/drive-session.test.ts`
Expected: FAIL with "Cannot find module '../drive-session'".

- [ ] **Step 3: Write the implementation**

Create `src/shared/drive-session.ts`:

```ts
import { join } from 'path';

export interface DriveSession {
  port: number;
  rendererUrl: string;
  pid: number;
}

const PORT_BASE = 41000;
const PORT_SPAN = 20000;

/**
 * Choose a CDP debug port. Honors a valid FLEET_DEBUG_PORT override, otherwise
 * derives a stable per-checkout port from the app path so parallel dev
 * worktrees do not collide on a shared 9222.
 */
export function deriveDebugPort(appPath: string, override?: string): number {
  if (override && override.trim() !== '') {
    const n = Number(override);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  let hash = 0;
  for (let i = 0; i < appPath.length; i++) {
    hash = (hash * 31 + appPath.charCodeAt(i)) & 0x7fffffff;
  }
  return PORT_BASE + (hash % PORT_SPAN);
}

export function sessionFilePath(cwd: string): string {
  return join(cwd, '.fleet-drive', 'session.json');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/shared/__tests__/drive-session.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire the debug port into the main process**

In `src/main/index.ts`, extend the existing fs import (line 12) to include `writeFileSync`:

```ts
import { existsSync, statSync, mkdirSync, writeFileSync } from 'fs';
```

Add an import near the other `../shared/constants` import (line 26):

```ts
import { deriveDebugPort, sessionFilePath, type DriveSession } from '../shared/drive-session';
```

Immediately after `app.setName('Fleet');` (line ~318) add the module-level switch (before `app.whenReady()` at line ~346):

```ts
// fleet-drive: enable CDP so `npm run drive` can attach to this dev window.
// Dev-only, loopback-only, per-checkout port. Never present in packaged builds.
let fleetDrivePort = 0;
if (IS_FLEET_DEV) {
  fleetDrivePort = deriveDebugPort(process.cwd(), process.env.FLEET_DEBUG_PORT);
  app.commandLine.appendSwitch('remote-debugging-port', String(fleetDrivePort));
}
```

- [ ] **Step 6: Keep dev screenshots live and write the discovery file**

In `createWindow`, inside the `webPreferences` object (line ~242), add:

```ts
      backgroundThrottling: !IS_FLEET_DEV,
```

At the end of `createWindow`, right after the `loadURL`/`loadFile` block (line ~314, before the closing `}`), add:

```ts
  if (IS_FLEET_DEV && process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    mainWindow.webContents.once('did-finish-load', () => {
      try {
        const file = sessionFilePath(process.cwd());
        mkdirSync(dirname(file), { recursive: true });
        const session: DriveSession = { port: fleetDrivePort, rendererUrl, pid: process.pid };
        writeFileSync(file, JSON.stringify(session, null, 2));
      } catch (err) {
        log.warn('failed to write fleet-drive session', { error: String(err) });
      }
    });
  }
```

(`dirname` is already imported on line 15; `log` already exists in this file.)

- [ ] **Step 7: Add `.fleet-drive/` to .gitignore**

In `.gitignore`, add under the existing worktree ignores:

```
.fleet-drive/
```

- [ ] **Step 8: Typecheck and manually verify**

Run: `npm run typecheck`
Expected: PASS.

Run `npm run dev` in one terminal. In another, from the repo root:

Run: `cat .fleet-drive/session.json`
Expected: JSON with a `port` in [41000, 61000), the dev `rendererUrl`, and a `pid`.

Run: `curl -s http://127.0.0.1:$(node -e "console.log(require('./.fleet-drive/session.json').port)")/json/version`
Expected: JSON including a `Browser` field (Chrome/Electron) — confirms CDP is listening.

- [ ] **Step 9: Commit**

```bash
git add src/shared/drive-session.ts src/shared/__tests__/drive-session.test.ts src/main/index.ts .gitignore
git commit -m "feat(drive): enable dev CDP port and session discovery file"
```

---

### Task 2: Driver core — CDP attach, window resolution, selectors, `status`

**Files:**
- Create: `scripts/drive/core.ts`, `scripts/drive/selectors.ts`, `scripts/drive/cli.ts`
- Test: `scripts/drive/__tests__/selectors.test.ts`
- Modify: `package.json` (devDependency + `drive` script)

**Interfaces:**
- Consumes: `sessionFilePath`, `DriveSession` from `src/shared/drive-session`.
- Produces:
  - `attach(): Promise<{ browser: Browser; page: Page }>` (core.ts)
  - `resolveLocator(page: Page, sel: string): Locator` (selectors.ts)

- [ ] **Step 1: Install Playwright as a dev dependency**

Run: `npm install --save-dev playwright`
Expected: `playwright` added to `devDependencies`. (No browser download is needed for CDP attach; do not run `playwright install`.)

- [ ] **Step 2: Add the `drive` script to package.json**

In `package.json` `scripts`, add:

```json
    "drive": "tsx scripts/drive/cli.ts",
```

- [ ] **Step 3: Write the failing selector test**

Create `scripts/drive/__tests__/selectors.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { resolveLocator } from '../selectors';
import type { Page } from 'playwright';

function fakePage() {
  const getByTestId = vi.fn((id: string) => ({ kind: 'testid', id }));
  const locator = vi.fn((s: string) => ({ kind: 'locator', s }));
  return { getByTestId, locator } as unknown as Page & {
    getByTestId: typeof getByTestId;
    locator: typeof locator;
  };
}

describe('resolveLocator', () => {
  it('maps testid= to getByTestId', () => {
    const page = fakePage();
    resolveLocator(page, 'testid=chat-input');
    expect(page.getByTestId).toHaveBeenCalledWith('chat-input');
  });

  it('passes role= selectors through to page.locator', () => {
    const page = fakePage();
    resolveLocator(page, 'role=button[name="Chat"]');
    expect(page.locator).toHaveBeenCalledWith('role=button[name="Chat"]');
  });

  it('passes raw CSS through to page.locator', () => {
    const page = fakePage();
    resolveLocator(page, '.sidebar button');
    expect(page.locator).toHaveBeenCalledWith('.sidebar button');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run scripts/drive/__tests__/selectors.test.ts`
Expected: FAIL with "Cannot find module '../selectors'".

- [ ] **Step 5: Implement the selector resolver**

Create `scripts/drive/selectors.ts`:

```ts
import type { Page, Locator } from 'playwright';

/**
 * Resolve a compact selector to a Playwright Locator.
 * Playwright's page.locator() already parses `role=`, `text=`, and CSS, so the
 * only mapping we add is `testid=<id>` -> getByTestId for future use.
 */
export function resolveLocator(page: Page, sel: string): Locator {
  const testid = /^testid=(.+)$/.exec(sel);
  if (testid) return page.getByTestId(testid[1]);
  return page.locator(sel);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run scripts/drive/__tests__/selectors.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Implement the CDP core**

Create `scripts/drive/core.ts`:

```ts
import { readFileSync } from 'fs';
import { chromium, type Browser, type Page } from 'playwright';
import { sessionFilePath, type DriveSession } from '../../src/shared/drive-session';

export interface Attached {
  browser: Browser;
  page: Page;
}

function readSession(): DriveSession {
  const file = sessionFilePath(process.cwd());
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `No fleet-drive session at ${file}. Start \`npm run dev\` in this checkout first.`
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).port !== 'number' ||
    typeof (parsed as Record<string, unknown>).rendererUrl !== 'string'
  ) {
    throw new Error(`Malformed session file at ${file}`);
  }
  return parsed as DriveSession;
}

/**
 * Connect to this checkout's dev window over CDP and positively resolve the
 * main Fleet window (matching the dev renderer URL and the "Fleet" title),
 * excluding the copilot window, DevTools, and web-fetch windows.
 */
export async function attach(): Promise<Attached> {
  const session = readSession();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.port}`);
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (!page.url().startsWith(session.rendererUrl)) continue;
      if ((await page.title()) === 'Fleet') return { browser, page };
    }
  }
  await browser.close();
  throw new Error(
    `Connected to CDP on port ${session.port} but found no Fleet window at ${session.rendererUrl}. ` +
      `Another process may own that port, or the window is not ready.`
  );
}
```

- [ ] **Step 8: Implement the CLI skeleton with `status`**

Create `scripts/drive/cli.ts`:

```ts
import { attach } from './core';

async function main(): Promise<void> {
  const [verb] = process.argv.slice(2);

  if (!verb || verb === 'help') {
    console.log('Usage: npm run drive -- <status|screenshot|snapshot|click|type|keys|eval> [args]');
    return;
  }

  const { browser, page } = await attach();
  try {
    switch (verb) {
      case 'status': {
        console.log(`Attached to: ${page.url()} (title: ${await page.title()})`);
        break;
      }
      default:
        throw new Error(`Unknown verb: ${verb}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 9: Typecheck and manually verify**

Run: `npm run typecheck`
Expected: PASS.

With `npm run dev` running, from the repo root:

Run: `npm run drive -- status`
Expected: `Attached to: http://localhost:<port>/ (title: Fleet)`.

Stop `npm run dev` and re-run `npm run drive -- status`.
Expected: a clear error mentioning no session / dev not running (exit 1), not a stack trace.

- [ ] **Step 10: Commit**

```bash
git add scripts/drive/core.ts scripts/drive/selectors.ts scripts/drive/cli.ts scripts/drive/__tests__/selectors.test.ts package.json package-lock.json
git commit -m "feat(drive): CDP attach, window resolution, selectors, status verb"
```

---

### Task 3: Capture verbs — `screenshot` and `snapshot`

**Files:**
- Create: `scripts/drive/verbs.ts`
- Test: `scripts/drive/__tests__/verbs.test.ts`
- Modify: `scripts/drive/cli.ts`

**Interfaces:**
- Consumes: `resolveLocator` (selectors.ts), `Page` (playwright), `sharp`.
- Produces:
  - `isLikelyBlank(png: Buffer): Promise<boolean>`
  - `screenshot(page: Page, opts: { selector?: string; out?: string }): Promise<string>`
  - `snapshot(page: Page): Promise<string>`

- [ ] **Step 1: Write the failing blank-detection test**

Create `scripts/drive/__tests__/verbs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { isLikelyBlank } from '../verbs';

async function solidPng(): Promise<Buffer> {
  return sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .png()
    .toBuffer();
}

async function noisyPng(): Promise<Buffer> {
  const pixels = Buffer.alloc(32 * 32 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 97) % 256;
  return sharp(pixels, { raw: { width: 32, height: 32, channels: 3 } }).png().toBuffer();
}

describe('isLikelyBlank', () => {
  it('flags a solid single-color image as blank', async () => {
    expect(await isLikelyBlank(await solidPng())).toBe(true);
  });

  it('does not flag a varied image as blank', async () => {
    expect(await isLikelyBlank(await noisyPng())).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/drive/__tests__/verbs.test.ts`
Expected: FAIL with "Cannot find module '../verbs'".

- [ ] **Step 3: Implement the capture verbs**

Create `scripts/drive/verbs.ts`:

```ts
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import sharp from 'sharp';
import type { Page } from 'playwright';
import { resolveLocator } from './selectors';

/** A frame is "blank" when every channel has near-zero variation. */
export async function isLikelyBlank(png: Buffer): Promise<boolean> {
  try {
    const { channels } = await sharp(png).stats();
    return channels.every((c) => c.stdev < 1);
  } catch {
    return false;
  }
}

function defaultShotPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(process.cwd(), '.fleet-drive', 'screenshots', `${stamp}.png`);
}

export async function screenshot(
  page: Page,
  opts: { selector?: string; out?: string }
): Promise<string> {
  const out = opts.out ?? defaultShotPath();
  mkdirSync(dirname(out), { recursive: true });
  const buf = opts.selector
    ? await resolveLocator(page, opts.selector).screenshot()
    : await page.screenshot();
  writeFileSync(out, buf);
  if (await isLikelyBlank(buf)) {
    console.error('Warning: screenshot looks blank — the window may be minimized. Un-minimize and retry.');
  }
  return out;
}

export async function snapshot(page: Page): Promise<string> {
  return page.locator('body').ariaSnapshot();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/drive/__tests__/verbs.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the verbs into the CLI**

In `scripts/drive/cli.ts`, add the import at the top:

```ts
import { screenshot, snapshot } from './verbs';
```

Add a tiny flag parser above `main` (used for `--out`/`--selector`):

```ts
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}
```

Add these `case`s to the switch (before `default`):

```ts
      case 'screenshot': {
        const rest = process.argv.slice(3);
        const out = await screenshot(page, {
          selector: flag(rest, 'selector'),
          out: flag(rest, 'out')
        });
        console.log(out);
        break;
      }
      case 'snapshot': {
        console.log(await snapshot(page));
        break;
      }
```

- [ ] **Step 6: Typecheck and manually verify**

Run: `npm run typecheck`
Expected: PASS.

With `npm run dev` running:

Run: `npm run drive -- screenshot`
Expected: prints a path under `.fleet-drive/screenshots/`; opening the PNG shows the current Fleet UI. (The agent then reads that PNG.)

Run: `npm run drive -- snapshot`
Expected: a YAML accessibility tree with recognizable roles/names from the current screen.

- [ ] **Step 7: Commit**

```bash
git add scripts/drive/verbs.ts scripts/drive/__tests__/verbs.test.ts scripts/drive/cli.ts
git commit -m "feat(drive): screenshot and snapshot verbs with blank-frame detection"
```

---

### Task 4: Interaction verbs — `click`, `type`, `keys`, `eval`

**Files:**
- Modify: `scripts/drive/verbs.ts`, `scripts/drive/cli.ts`

**Interfaces:**
- Produces:
  - `click(page: Page, sel: string): Promise<void>`
  - `type(page: Page, sel: string, text: string): Promise<void>`
  - `keys(page: Page, chord: string): Promise<void>`
  - `evalExpr(page: Page, expr: string): Promise<string>`

- [ ] **Step 1: Implement the interaction verbs**

Append to `scripts/drive/verbs.ts`:

```ts
export async function click(page: Page, sel: string): Promise<void> {
  await resolveLocator(page, sel).click();
}

export async function type(page: Page, sel: string, text: string): Promise<void> {
  await resolveLocator(page, sel).fill(text);
}

export async function keys(page: Page, chord: string): Promise<void> {
  await page.keyboard.press(chord);
}

export async function evalExpr(page: Page, expr: string): Promise<string> {
  return page.evaluate((e) => {
    const value: unknown = (0, eval)(e);
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }, expr);
}
```

- [ ] **Step 2: Wire the verbs into the CLI**

In `scripts/drive/cli.ts`, extend the verbs import:

```ts
import { screenshot, snapshot, click, type, keys, evalExpr } from './verbs';
```

Add these `case`s before `default`:

```ts
      case 'click': {
        const sel = process.argv[3];
        if (!sel) throw new Error('click requires a selector');
        await click(page, sel);
        console.log(`clicked: ${sel}`);
        break;
      }
      case 'type': {
        const sel = process.argv[3];
        const text = process.argv[4];
        if (!sel || text === undefined) throw new Error('type requires <selector> <text>');
        await type(page, sel, text);
        console.log(`typed into: ${sel}`);
        break;
      }
      case 'keys': {
        const chord = process.argv[3];
        if (!chord) throw new Error('keys requires a chord, e.g. Meta+K');
        await keys(page, chord);
        console.log(`pressed: ${chord}`);
        break;
      }
      case 'eval': {
        const expr = process.argv[3];
        if (!expr) throw new Error('eval requires a JS expression');
        console.log(await evalExpr(page, expr));
        break;
      }
```

- [ ] **Step 3: Typecheck and manually verify**

Run: `npm run typecheck`
Expected: PASS.

With `npm run dev` running:

Run: `npm run drive -- keys "Meta+K"` then `npm run drive -- screenshot`
Expected: the second screenshot shows the ⌘K command palette open.

Run: `npm run drive -- keys "Escape"` then `npm run drive -- eval "document.title"`
Expected: prints `"Fleet"`.

- [ ] **Step 4: Commit**

```bash
git add scripts/drive/verbs.ts scripts/drive/cli.ts
git commit -m "feat(drive): click, type, keys, and eval verbs"
```

---

### Task 5: Renderer dev-store bridge + usage docs

**Files:**
- Modify: `src/renderer/src/main.tsx` (add dev-only bridge before the render block)
- Modify: `src/renderer/src/env.d.ts` (Window type)
- Create: `scripts/drive/README.md`

**Interfaces:**
- Produces: `window.__FLEET__ = { stores: { workspace, chat, settings, kanban, sessions } }` in dev only, each value a zustand store hook exposing `.getState()`.

- [ ] **Step 1: Add the Window type**

In `src/renderer/src/env.d.ts`, add:

```ts
interface Window {
  __FLEET__?: {
    stores: Record<string, { getState: () => unknown }>;
  };
}
```

- [ ] **Step 2: Add the dev-only store bridge**

In `src/renderer/src/main.tsx`, add these imports at the top (after the existing imports):

```ts
import { useWorkspaceStore } from './store/workspace-store';
import { useChatStore } from './store/chat-store';
import { useSettingsStore } from './store/settings-store';
import { useKanbanStore } from './store/kanban-store';
import { useSessionsStore } from './store/sessions-store';
```

Then, immediately before the final `void Promise.race([...])` render block, add:

```ts
// fleet-drive: expose store state to `npm run drive -- eval` in dev only.
// Note: theme is React state (see hooks/use-app-theme.ts), not a store — read
// it from the DOM instead. Never present in a packaged build.
if (import.meta.env.DEV) {
  window.__FLEET__ = {
    stores: {
      workspace: useWorkspaceStore,
      chat: useChatStore,
      settings: useSettingsStore,
      kanban: useKanbanStore,
      sessions: useSessionsStore
    }
  };
}
```

- [ ] **Step 3: Typecheck the web bundle**

Run: `npm run typecheck:web`
Expected: PASS (the `__FLEET__` reference resolves against the new Window type).

- [ ] **Step 4: Write usage docs**

Create `scripts/drive/README.md`:

```markdown
# fleet-drive

Attach to the live `npm run dev` Fleet window over CDP and drive its UI.
Dev-only (`IS_FLEET_DEV`); never present in packaged builds.

## Usage

Start the app: `npm run dev`. Then from the repo root:

```

npm run drive -- status                         # confirm attach + which window
npm run drive -- screenshot [--selector <sel>] [--out <path>]
npm run drive -- snapshot                       # ARIA YAML tree of the page
npm run drive -- click '<sel>'
npm run drive -- type '<sel>' '<text>'
npm run drive -- keys 'Meta+K'                  # renderer shortcuts only
npm run drive -- eval '<js expression>'

```

Screenshots default to `.fleet-drive/screenshots/<timestamp>.png` (gitignored).

## Selectors

`page.locator()` syntax: `role=button[name="Chat"]`, `text=Settings`, raw CSS,
or `testid=<id>` (maps to getByTestId).

## eval

Runs in the renderer. In dev, `window.__FLEET__.stores` exposes zustand stores:
`npm run drive -- eval "__FLEET__.stores.workspace.getState().activeTabId"`.
Theme is React state, not a store — read it from the DOM.

## Notes

- Each checkout uses a stable per-checkout debug port (override: `FLEET_DEBUG_PORT`).
  Parallel dev worktrees do not collide.
- `keys` reaches renderer DOM handlers only (e.g. ⌘K), not native menu
  accelerators or `globalShortcut`.
- Terminal-pane input stays the `fleet` socket CLI's job.
```

- [ ] **Step 5: Manually verify the bridge**

With `npm run dev` running:

Run: `npm run drive -- eval "__FLEET__.stores.workspace.getState().activeTabId"`
Expected: prints the active tab id (or `null`), not `undefined`/an error.

- [ ] **Step 6: Full verification suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/main.tsx src/renderer/src/env.d.ts scripts/drive/README.md
git commit -m "feat(drive): dev-only store bridge and usage docs"
```

---

## Self-Review Notes

- **Spec coverage:** connection model (Task 1 port + Task 2 attach), main-process change incl. `backgroundThrottling` (Task 1), per-checkout port + discovery + positive target match (Tasks 1–2), all six verbs + `status` (Tasks 2–4), `ariaSnapshot` not deprecated API (Task 3), in-page `JSON.stringify` for `eval` (Task 4), store-map bridge with real hooks and the theme caveat (Task 5), gitignore + dev gates + loopback + security posture (Tasks 1, docs), blank-frame detection (Task 3), test-later note (docs/spec). Covered.
- **Deferred by design (out of scope this plan):** `_electron.launch` CI suite and main-process control — documented in the spec as future work.
- **Type consistency:** `DriveSession`, `deriveDebugPort`, `sessionFilePath`, `attach`, `resolveLocator`, `isLikelyBlank`, `screenshot`, `snapshot`, `click`, `type`, `keys`, `evalExpr` used with consistent signatures across tasks.
