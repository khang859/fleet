# Env Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone "Edit .env" toolbar feature that opens a master–detail modal for editing `.env` files in a folder (grouped nested-file navigator + hybrid structured/raw editor), with explicit save, secret masking, full file management, and NN/g-grounded micro-interactions.

**Architecture:** A self-contained feature mirroring the existing env-sync structure. A shared zod-typed contract + a shared round-trip env parser, a main-process filesystem module exposed over new IPC channels, and a renderer modal composed of small focused components. No shared runtime state with env-sync; only shared styling/parsing conventions.

**Tech Stack:** Electron (ESM main/preload `.mjs`), React + TypeScript, Tailwind, lucide-react icons, zod, Vitest (main/shared only — renderer is not unit-tested in this repo), Zustand toast store.

**Spec:** `docs/superpowers/specs/2026-06-07-env-editor-design.md`

---

## File Structure

**New files**
- `src/shared/env-editor-types.ts` — zod schemas + inferred types for the IPC contract.
- `src/shared/env-parse.ts` — round-trip parser (`text → EnvLine[] → text`) + edit helpers. Shared so main (scanner `varCount`) and renderer (form editing) use one implementation.
- `src/main/env-editor/env-editor-fs.ts` — filesystem ops: list/read/write(atomic)/create/rename/soft-delete/restore.
- `src/renderer/src/components/env-editor/EnvEditorModal.tsx` — modal shell, state owner, save logic.
- `src/renderer/src/components/env-editor/FileNavigator.tsx` — grouped file list, filter, new-file/rename/delete controls, empty state (presentational).
- `src/renderer/src/components/env-editor/EnvForm.tsx` — structured KEY=VALUE rows (incl. the row component, kept inline to stay focused), masking, inline validation, add/remove.
- `src/renderer/src/components/env-editor/EnvRawEditor.tsx` — raw-text `<textarea>` editor.
- `src/renderer/src/components/env-editor/NewFileDialog.tsx` — create-file dialog.
- `src/main/__tests__/env-editor-fs.test.ts`, `src/shared/__tests__/env-parse.test.ts`, `src/shared/__tests__/env-editor-types.test.ts` — tests.

**Modified files**
- `src/shared/ipc-channels.ts` — new `ENV_EDITOR_*` channel constants.
- `src/main/ipc-handlers.ts` — register `env-editor:*` handlers.
- `src/preload/index.ts` — `window.fleet.envEditor.*` binding + `FleetApi` export (already auto-derived).
- `src/renderer/src/components/PaneToolbar.tsx` — `onEnvEditor` prop + `FilePenLine` button.
- `src/renderer/src/components/TerminalPane.tsx` and `PiTab.tsx` — dispatch `fleet:toggle-env-editor`.
- `src/renderer/src/App.tsx` — modal open state, toggle listener, render `<EnvEditorModal>`.

**Decision locked at plan time** (resolving the spec's open items):
- Use a **fresh** `src/shared/env-parse.ts` (env-sync's `parseEnv` discards comments/order, so it can't round-trip). Do not modify env-sync's parser.
- Large-file raw-only threshold: **256 KB**.
- `EnvRow` is folded into `EnvForm.tsx` (small, changes together) rather than a separate file.

---

## Task 1: Shared IPC types (zod)

**Files:**
- Create: `src/shared/env-editor-types.ts`
- Test: `src/shared/__tests__/env-editor-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/__tests__/env-editor-types.test.ts
import { describe, it, expect } from 'vitest';
import {
  EnvFileEntrySchema,
  EnvReadResultSchema,
  EnvWriteResultSchema
} from '../env-editor-types';

describe('env-editor-types', () => {
  it('parses a valid EnvFileEntry', () => {
    const entry = {
      absPath: '/repo/.env',
      relPath: '.env',
      group: '·root',
      name: '.env',
      isTemplate: false,
      varCount: 3,
      readable: true
    };
    expect(EnvFileEntrySchema.parse(entry)).toEqual(entry);
  });

  it('rejects an EnvFileEntry with a missing field', () => {
    expect(() => EnvFileEntrySchema.parse({ absPath: '/x' })).toThrow();
  });

  it('parses read and write results', () => {
    expect(EnvReadResultSchema.parse({ text: 'A=1', mtimeMs: 10 }).text).toBe('A=1');
    const w = EnvWriteResultSchema.parse({ ok: true, mtimeMs: 11 });
    expect(w.ok).toBe(true);
    const ext = EnvWriteResultSchema.parse({ ok: false, externalChange: true, mtimeMs: 12 });
    expect(ext.externalChange).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/__tests__/env-editor-types.test.ts`
Expected: FAIL — `Cannot find module '../env-editor-types'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/shared/env-editor-types.ts
import { z } from 'zod';

/** A discovered .env file, relative to the active scan root. */
export const EnvFileEntrySchema = z.object({
  absPath: z.string(),
  relPath: z.string(),
  /** Folder path used for grouping; '·root' for top-level files. */
  group: z.string(),
  name: z.string(),
  /** True for .example/.sample/.template/.dist/.defaults files. */
  isTemplate: z.boolean(),
  varCount: z.number(),
  /** False when the file could not be read (shown disabled). */
  readable: z.boolean()
});
export type EnvFileEntry = z.infer<typeof EnvFileEntrySchema>;

export const EnvReadResultSchema = z.object({
  text: z.string(),
  mtimeMs: z.number()
});
export type EnvReadResult = z.infer<typeof EnvReadResultSchema>;

/** ok:false + externalChange:true means the file changed on disk since read. */
export const EnvWriteResultSchema = z.object({
  ok: z.boolean(),
  externalChange: z.boolean().optional(),
  mtimeMs: z.number()
});
export type EnvWriteResult = z.infer<typeof EnvWriteResultSchema>;

export const EnvPathResultSchema = z.object({ absPath: z.string() });
export type EnvPathResult = z.infer<typeof EnvPathResultSchema>;

export const EnvTrashResultSchema = z.object({ trashPath: z.string() });
export type EnvTrashResult = z.infer<typeof EnvTrashResultSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/__tests__/env-editor-types.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/env-editor-types.ts src/shared/__tests__/env-editor-types.test.ts
git commit -m "feat(env-editor): add shared IPC types"
```

---

## Task 2: Round-trip env parser

**Files:**
- Create: `src/shared/env-parse.ts`
- Test: `src/shared/__tests__/env-parse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/__tests__/env-parse.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseEnvFile,
  serializeEnvFile,
  formatVarLine,
  updateVarLine,
  newVarLine
} from '../env-parse';

const SAMPLE = `# Database
DATABASE_URL=postgres://localhost:5432/app

export API_KEY="sk_live_3f9a"
PORT=3000
EMPTY=
`;

describe('env-parse', () => {
  it('round-trips text byte-for-byte when unedited', () => {
    const parsed = parseEnvFile(SAMPLE);
    expect(serializeEnvFile(parsed)).toBe(SAMPLE);
  });

  it('classifies lines', () => {
    const { lines } = parseEnvFile(SAMPLE);
    expect(lines[0]).toMatchObject({ kind: 'comment' });
    expect(lines[1]).toMatchObject({ kind: 'var', key: 'DATABASE_URL' });
    expect(lines[2]).toMatchObject({ kind: 'blank' });
    expect(lines[3]).toMatchObject({ kind: 'var', key: 'API_KEY', value: 'sk_live_3f9a' });
    expect(lines[5]).toMatchObject({ kind: 'var', key: 'EMPTY', value: '' });
  });

  it('preserves comments and ordering when one value changes', () => {
    const parsed = parseEnvFile(SAMPLE);
    const idx = parsed.lines.findIndex((l) => l.kind === 'var' && l.key === 'PORT');
    parsed.lines[idx] = updateVarLine(parsed.lines[idx] as never, 'PORT', '4000');
    const out = serializeEnvFile(parsed);
    expect(out).toContain('# Database');
    expect(out).toContain('PORT=4000');
    expect(out).toContain('export API_KEY="sk_live_3f9a"'); // untouched line preserved verbatim
  });

  it('quotes values with spaces or # and keeps the export prefix', () => {
    expect(formatVarLine('K', 'a b')).toBe('K="a b"');
    expect(formatVarLine('K', 'a#b')).toBe('K="a#b"');
    expect(formatVarLine('K', 'plain')).toBe('K=plain');
    expect(formatVarLine('K', 'x', 'export K=old')).toBe('export K=x');
  });

  it('creates a new var line', () => {
    expect(newVarLine('NEW', 'v')).toMatchObject({ kind: 'var', key: 'NEW', value: 'v', raw: 'NEW=v' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/__tests__/env-parse.test.ts`
Expected: FAIL — `Cannot find module '../env-parse'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/shared/env-parse.ts

/** One physical line, preserved for round-trip fidelity. */
export type EnvLine =
  | { kind: 'var'; key: string; value: string; raw: string }
  | { kind: 'comment'; raw: string }
  | { kind: 'blank' };

export type VarLine = Extract<EnvLine, { kind: 'var' }>;

export type ParsedEnvFile = { lines: EnvLine[]; trailingNewline: boolean };

/** Parse .env text into ordered lines. Splits on '\n' only so CRLF is kept in raw. */
export function parseEnvFile(text: string): ParsedEnvFile {
  const trailingNewline = text.endsWith('\n');
  const raws = text.split('\n');
  if (trailingNewline) raws.pop();
  const lines: EnvLine[] = raws.map((raw) => {
    const trimmed = raw.trim();
    if (trimmed === '') return { kind: 'blank' };
    if (trimmed.startsWith('#')) return { kind: 'comment', raw };
    const body = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eq = body.indexOf('=');
    if (eq === -1) return { kind: 'comment', raw }; // not KEY=VAL → preserve verbatim
    const key = body.slice(0, eq).trim();
    if (!key) return { kind: 'comment', raw };
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return { kind: 'var', key, value, raw };
  });
  return { lines, trailingNewline };
}

export function serializeEnvFile(parsed: ParsedEnvFile): string {
  const body = parsed.lines
    .map((l) => (l.kind === 'blank' ? '' : l.raw))
    .join('\n');
  return parsed.trailingNewline ? `${body}\n` : body;
}

/** Build a `KEY=value` line, quoting when needed and keeping any `export ` prefix. */
export function formatVarLine(key: string, value: string, originalRaw?: string): string {
  const exportPrefix = originalRaw?.trim().startsWith('export ') ? 'export ' : '';
  const needsQuotes = /\s/.test(value) || value.includes('#');
  const body = needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value;
  return `${exportPrefix}${key}=${body}`;
}

export function updateVarLine(line: VarLine, key: string, value: string): VarLine {
  return { kind: 'var', key, value, raw: formatVarLine(key, value, line.raw) };
}

export function newVarLine(key: string, value: string): VarLine {
  return { kind: 'var', key, value, raw: formatVarLine(key, value) };
}

export function countVars(text: string): number {
  return parseEnvFile(text).lines.filter((l) => l.kind === 'var').length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/__tests__/env-parse.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/env-parse.ts src/shared/__tests__/env-parse.test.ts
git commit -m "feat(env-editor): add round-trip env parser"
```

---

## Task 3: Filesystem module — scanner

**Files:**
- Create: `src/main/env-editor/env-editor-fs.ts`
- Test: `src/main/__tests__/env-editor-fs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/__tests__/env-editor-fs.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listEnvFiles } from '../env-editor/env-editor-fs';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'env-editor-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listEnvFiles', () => {
  it('finds nested env files, groups them, and flags templates', () => {
    writeFileSync(join(root, '.env'), 'A=1\nB=2\n');
    writeFileSync(join(root, '.env.example'), 'A=\n');
    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    writeFileSync(join(root, 'apps', 'web', '.env'), 'C=3\n');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', '.env'), 'IGNORED=1\n');

    const entries = listEnvFiles(root);
    const names = entries.map((e) => e.relPath);
    expect(names).toContain('.env');
    expect(names).toContain('.env.example');
    expect(names).toContain('apps/web/.env');
    expect(names).not.toContain('node_modules/pkg/.env'); // excluded dir

    const rootEnv = entries.find((e) => e.relPath === '.env')!;
    expect(rootEnv.group).toBe('·root');
    expect(rootEnv.varCount).toBe(2);
    expect(rootEnv.isTemplate).toBe(false);

    expect(entries.find((e) => e.relPath === '.env.example')!.isTemplate).toBe(true);
    expect(entries.find((e) => e.relPath === 'apps/web/.env')!.group).toBe('apps/web');
  });

  it('sorts ·root group first', () => {
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', '.env'), '');
    writeFileSync(join(root, '.env'), '');
    expect(listEnvFiles(root)[0].group).toBe('·root');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/env-editor-fs.test.ts`
Expected: FAIL — `Cannot find module '../env-editor/env-editor-fs'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/main/env-editor/env-editor-fs.ts
import {
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdtempSync
} from 'node:fs';
import { join, relative, sep, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnvFile } from '../../shared/env-parse';
import type { EnvFileEntry } from '../../shared/env-editor-types';

const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'out',
  'coverage'
]);
const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist', '.defaults'];

function isEnvName(name: string): boolean {
  return name.startsWith('.env');
}
function isTemplateName(name: string): boolean {
  return TEMPLATE_SUFFIXES.some((s) => name.endsWith(s));
}

function toEntry(root: string, full: string): EnvFileEntry {
  const rel = relative(root, full).split(sep).join('/');
  const slash = rel.lastIndexOf('/');
  const dir = slash === -1 ? '' : rel.slice(0, slash);
  let varCount = 0;
  let readable = true;
  try {
    varCount = parseEnvFile(readFileSync(full, 'utf8')).lines.filter(
      (l) => l.kind === 'var'
    ).length;
  } catch {
    readable = false;
  }
  return {
    absPath: full,
    relPath: rel,
    group: dir === '' ? '·root' : dir,
    name: basename(full),
    isTemplate: isTemplateName(basename(full)),
    varCount,
    readable
  };
}

function sortEntries(entries: EnvFileEntry[]): EnvFileEntry[] {
  return entries.sort((a, b) => {
    if (a.group !== b.group) {
      if (a.group === '·root') return -1;
      if (b.group === '·root') return 1;
      return a.group.localeCompare(b.group);
    }
    return a.name.localeCompare(b.name);
  });
}

/** Recursively find all .env* files under root (templates included). */
export function listEnvFiles(root: string, maxDepth = 4): EnvFileEntry[] {
  const out: EnvFileEntry[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!EXCLUDE_DIRS.has(name)) walk(full, depth + 1);
      } else if (isEnvName(name)) {
        out.push(toEntry(root, full));
      }
    }
  };
  walk(root, 0);
  return sortEntries(out);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/env-editor-fs.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/env-editor/env-editor-fs.ts src/main/__tests__/env-editor-fs.test.ts
git commit -m "feat(env-editor): add env-file scanner"
```

---

## Task 4: Filesystem module — read/write/create/rename/delete

**Files:**
- Modify: `src/main/env-editor/env-editor-fs.ts`
- Modify: `src/main/__tests__/env-editor-fs.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/main/__tests__/env-editor-fs.test.ts`:

```ts
import {
  readEnvFile,
  writeEnvFile,
  createEnvFile,
  renameEnvFile,
  softDeleteEnvFile,
  restoreEnvFile
} from '../env-editor/env-editor-fs';

describe('env-editor fs ops', () => {
  it('reads and writes atomically, returning a new mtime', () => {
    const p = join(root, '.env');
    writeFileSync(p, 'A=1\n');
    const read = readEnvFile(p);
    expect(read.text).toBe('A=1\n');
    const res = writeEnvFile(p, 'A=2\n');
    expect(res.ok).toBe(true);
    expect(readEnvFile(p).text).toBe('A=2\n');
  });

  it('detects external change via mtime', () => {
    const p = join(root, '.env');
    writeFileSync(p, 'A=1\n');
    const stale = readEnvFile(p).mtimeMs - 1000;
    writeFileSync(p, 'A=changed\n'); // simulate external edit (newer mtime)
    const res = writeEnvFile(p, 'A=2\n', stale);
    expect(res.ok).toBe(false);
    expect(res.externalChange).toBe(true);
  });

  it('creates a file, rejecting non-.env names and collisions', () => {
    const { absPath } = createEnvFile(root, '.env.local');
    expect(existsSync(absPath)).toBe(true);
    expect(() => createEnvFile(root, 'notenv')).toThrow();
    expect(() => createEnvFile(root, '.env.local')).toThrow();
  });

  it('renames with collision protection', () => {
    const a = join(root, '.env');
    writeFileSync(a, 'A=1\n');
    const { absPath } = renameEnvFile(a, '.env.bak');
    expect(basename(absPath)).toBe('.env.bak');
    expect(existsSync(a)).toBe(false);
  });

  it('soft-deletes and restores', () => {
    const p = join(root, '.env');
    writeFileSync(p, 'A=1\n');
    const { trashPath } = softDeleteEnvFile(p);
    expect(existsSync(p)).toBe(false);
    restoreEnvFile(trashPath, p);
    expect(readEnvFile(p).text).toBe('A=1\n');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/__tests__/env-editor-fs.test.ts`
Expected: FAIL — the new functions are not exported.

- [ ] **Step 3: Implement the ops**

Append to `src/main/env-editor/env-editor-fs.ts`:

```ts
import type { EnvReadResult, EnvWriteResult, EnvPathResult, EnvTrashResult } from '../../shared/env-editor-types';

let tmpCounter = 0;

export function readEnvFile(absPath: string): EnvReadResult {
  return { text: readFileSync(absPath, 'utf8'), mtimeMs: statSync(absPath).mtimeMs };
}

/** Atomic write (temp + rename). If expectedMtimeMs is given and the file is newer, refuse. */
export function writeEnvFile(
  absPath: string,
  text: string,
  expectedMtimeMs?: number
): EnvWriteResult {
  if (expectedMtimeMs !== undefined && existsSync(absPath)) {
    const current = statSync(absPath).mtimeMs;
    if (current > expectedMtimeMs) {
      return { ok: false, externalChange: true, mtimeMs: current };
    }
  }
  const tmp = `${absPath}.fleet-tmp-${process.pid}-${tmpCounter++}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, absPath);
  return { ok: true, mtimeMs: statSync(absPath).mtimeMs };
}

function assertEnvName(name: string): void {
  if (!name.startsWith('.env')) throw new Error('File name must start with ".env"');
}

export function createEnvFile(dir: string, name: string): EnvPathResult {
  assertEnvName(name);
  const full = join(dir, name);
  if (existsSync(full)) throw new Error('A file with that name already exists');
  writeFileSync(full, '', 'utf8');
  return { absPath: full };
}

export function renameEnvFile(absPath: string, newName: string): EnvPathResult {
  assertEnvName(newName);
  const next = join(dirname(absPath), newName);
  if (existsSync(next)) throw new Error('A file with that name already exists');
  renameSync(absPath, next);
  return { absPath: next };
}

export function softDeleteEnvFile(absPath: string): EnvTrashResult {
  const trashDir = mkdtempSync(join(tmpdir(), 'fleet-env-trash-'));
  const trashPath = join(trashDir, basename(absPath));
  renameSync(absPath, trashPath);
  return { trashPath };
}

export function restoreEnvFile(trashPath: string, absPath: string): { ok: true } {
  renameSync(trashPath, absPath);
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/__tests__/env-editor-fs.test.ts`
Expected: PASS (all tests, including Task 3's).

- [ ] **Step 5: Commit**

```bash
git add src/main/env-editor/env-editor-fs.ts src/main/__tests__/env-editor-fs.test.ts
git commit -m "feat(env-editor): add read/write/create/rename/delete fs ops"
```

---

## Task 5: IPC channels, handlers, and preload binding

**Files:**
- Modify: `src/shared/ipc-channels.ts:199` (add constants before the closing `}`)
- Modify: `src/main/ipc-handlers.ts:857` (add handlers after the Env Sync block)
- Modify: `src/preload/index.ts:639` (add `envEditor` binding after `envSync`)

- [ ] **Step 1: Add channel constants**

In `src/shared/ipc-channels.ts`, change the end of the `KANBAN_PRUNE_MERGED_WORKTREES` line to add a comma and append the new block before `} as const;`:

```ts
  KANBAN_PRUNE_MERGED_WORKTREES: 'kanban:prune-merged-worktrees',
  // Env Editor
  ENV_EDITOR_LIST: 'env-editor:list',
  ENV_EDITOR_READ: 'env-editor:read',
  ENV_EDITOR_WRITE: 'env-editor:write',
  ENV_EDITOR_CREATE: 'env-editor:create',
  ENV_EDITOR_RENAME: 'env-editor:rename',
  ENV_EDITOR_DELETE: 'env-editor:delete',
  ENV_EDITOR_RESTORE: 'env-editor:restore'
} as const;
```

- [ ] **Step 2: Register handlers**

In `src/main/ipc-handlers.ts`, add this import near the env-sync imports at the top of the file (find the existing `from './env-sync/...'` imports and add alongside):

```ts
import {
  listEnvFiles,
  readEnvFile,
  writeEnvFile,
  createEnvFile,
  renameEnvFile,
  softDeleteEnvFile,
  restoreEnvFile
} from './env-editor/env-editor-fs';
```

Then, immediately after the Env Sync handler block (after the `ENV_SYNC_ENCRYPTION_AVAILABLE` handler closes at line ~857, before the function's closing `}`), add:

```ts
  // ── Env Editor ──────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.ENV_EDITOR_LIST, (_e, root: string) => listEnvFiles(root));

  ipcMain.handle(IPC_CHANNELS.ENV_EDITOR_READ, (_e, absPath: string) => readEnvFile(absPath));

  ipcMain.handle(
    IPC_CHANNELS.ENV_EDITOR_WRITE,
    (_e, absPath: string, text: string, expectedMtimeMs?: number) =>
      writeEnvFile(absPath, text, expectedMtimeMs)
  );

  ipcMain.handle(IPC_CHANNELS.ENV_EDITOR_CREATE, (_e, dir: string, name: string) =>
    createEnvFile(dir, name)
  );

  ipcMain.handle(IPC_CHANNELS.ENV_EDITOR_RENAME, (_e, absPath: string, newName: string) =>
    renameEnvFile(absPath, newName)
  );

  ipcMain.handle(IPC_CHANNELS.ENV_EDITOR_DELETE, (_e, absPath: string) =>
    softDeleteEnvFile(absPath)
  );

  ipcMain.handle(IPC_CHANNELS.ENV_EDITOR_RESTORE, (_e, trashPath: string, absPath: string) =>
    restoreEnvFile(trashPath, absPath)
  );
```

- [ ] **Step 3: Add the preload binding**

In `src/preload/index.ts`, add these imports to the existing type import from the shared env-editor types (top of file, near other `import type` lines):

```ts
import type {
  EnvFileEntry,
  EnvReadResult,
  EnvWriteResult,
  EnvPathResult,
  EnvTrashResult
} from '../shared/env-editor-types';
```

Then change the `envSync` object's closing `}` (line ~639) to `},` and append after it (before the closing `}` of `fleetApi`):

```ts
  envEditor: {
    list: async (root: string): Promise<EnvFileEntry[]> =>
      typedInvoke<EnvFileEntry[]>(IPC_CHANNELS.ENV_EDITOR_LIST, root),
    read: async (absPath: string): Promise<EnvReadResult> =>
      typedInvoke<EnvReadResult>(IPC_CHANNELS.ENV_EDITOR_READ, absPath),
    write: async (
      absPath: string,
      text: string,
      expectedMtimeMs?: number
    ): Promise<EnvWriteResult> =>
      typedInvoke<EnvWriteResult>(IPC_CHANNELS.ENV_EDITOR_WRITE, absPath, text, expectedMtimeMs),
    create: async (dir: string, name: string): Promise<EnvPathResult> =>
      typedInvoke<EnvPathResult>(IPC_CHANNELS.ENV_EDITOR_CREATE, dir, name),
    rename: async (absPath: string, newName: string): Promise<EnvPathResult> =>
      typedInvoke<EnvPathResult>(IPC_CHANNELS.ENV_EDITOR_RENAME, absPath, newName),
    delete: async (absPath: string): Promise<EnvTrashResult> =>
      typedInvoke<EnvTrashResult>(IPC_CHANNELS.ENV_EDITOR_DELETE, absPath),
    restore: async (trashPath: string, absPath: string): Promise<{ ok: true }> =>
      typedInvoke<{ ok: true }>(IPC_CHANNELS.ENV_EDITOR_RESTORE, trashPath, absPath)
  }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no new errors). The `window.fleet.envEditor` API is now typed via `FleetApi`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/ipc-handlers.ts src/preload/index.ts
git commit -m "feat(env-editor): wire IPC channels, handlers, and preload binding"
```

---

## Task 6: Toolbar button + App wiring (with a stub modal)

**Files:**
- Modify: `src/renderer/src/components/PaneToolbar.tsx`
- Modify: `src/renderer/src/components/TerminalPane.tsx`
- Modify: `src/renderer/src/components/PiTab.tsx`
- Modify: `src/renderer/src/App.tsx`
- Create: `src/renderer/src/components/env-editor/EnvEditorModal.tsx` (stub, fleshed out in later tasks)

- [ ] **Step 1: Create a stub modal so wiring compiles and is verifiable**

```tsx
// src/renderer/src/components/env-editor/EnvEditorModal.tsx
import { X } from 'lucide-react';

export function EnvEditorModal({
  isOpen,
  onClose,
  cwd
}: {
  isOpen: boolean;
  onClose: () => void;
  cwd: string | undefined;
}): React.JSX.Element | null {
  if (!isOpen) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-[820px] flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-100">Env Editor</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-white active:scale-90"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-6 text-sm text-neutral-400">cwd: {cwd ?? '(none)'}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the toolbar button**

In `src/renderer/src/components/PaneToolbar.tsx`:
- Add `FilePenLine` to the lucide-react import block (line 1-13).
- Add `onEnvEditor?: () => void;` to `PaneToolbarProps` (after `onEnvSync?` at line 59).
- Add `onEnvEditor` to the destructured props in the `PaneToolbar` function signature (after `onEnvSync`).
- Find the existing Env Sync button (`{onEnvSync && (` ... `<FolderSync size={14} />` ... `)}`) and add this directly after it:

```tsx
        {onEnvEditor && (
          <ToolbarTooltip label="Edit .env">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEnvEditor();
              }}
              className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors active:scale-90"
            >
              <FilePenLine size={14} />
            </button>
          </ToolbarTooltip>
        )}
```

- [ ] **Step 3: Dispatch the toggle event from the panes**

In `src/renderer/src/components/TerminalPane.tsx`, find where `onEnvSync={...}` is passed to `<PaneToolbar` and add directly below it:

```tsx
            onEnvEditor={() =>
              document.dispatchEvent(new CustomEvent('fleet:toggle-env-editor'))
            }
```

Do the same in `src/renderer/src/components/PiTab.tsx` (find its `<PaneToolbar ... onEnvSync=` usage and add the identical `onEnvEditor` prop).

- [ ] **Step 4: Wire modal state in App.tsx**

In `src/renderer/src/App.tsx`:
- Add the import near the `EnvSyncModal` import (line 31): `import { EnvEditorModal } from './components/env-editor/EnvEditorModal';`
- Add state near `envSyncOpen` (line 146): `const [envEditorOpen, setEnvEditorOpen] = useState(false);`
- Add a toggle listener. Find the `useEffect` that registers `fleet:toggle-env-sync` (lines ~238-242) and add a sibling effect right after it:

```tsx
  useEffect(() => {
    const handler = (): void => setEnvEditorOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-env-editor', handler);
    return () => document.removeEventListener('fleet:toggle-env-editor', handler);
  }, []);
```

- Render the modal right after `<EnvSyncModal ... />` (line ~991-995):

```tsx
      <EnvEditorModal
        isOpen={envEditorOpen}
        onClose={() => setEnvEditorOpen(false)}
        cwd={focusedPaneCwd}
      />
```

- [ ] **Step 5: Typecheck, then manually verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run dev` and in the app: focus a terminal pane, hover the toolbar, click the new pen icon (tooltip "Edit .env"). Expected: a modal titled "Env Editor" appears showing the cwd; clicking the backdrop or X closes it.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/PaneToolbar.tsx src/renderer/src/components/TerminalPane.tsx src/renderer/src/components/PiTab.tsx src/renderer/src/App.tsx src/renderer/src/components/env-editor/EnvEditorModal.tsx
git commit -m "feat(env-editor): add toolbar button and modal wiring"
```

---

## Task 7: File navigator (list, grouping, filter, selection, empty state)

**Files:**
- Create: `src/renderer/src/components/env-editor/FileNavigator.tsx`
- Modify: `src/renderer/src/components/env-editor/EnvEditorModal.tsx`

- [ ] **Step 1: Create the navigator component**

```tsx
// src/renderer/src/components/env-editor/FileNavigator.tsx
import { Fragment, useMemo, useState } from 'react';
import { Search, Plus, FilePlus2 } from 'lucide-react';
import type { EnvFileEntry } from '../../../../shared/env-editor-types';

type Props = {
  files: EnvFileEntry[];
  selectedPath: string | null;
  dirtyPaths: Set<string>;
  onSelect: (file: EnvFileEntry) => void;
  onNewFile: () => void;
};

export function FileNavigator({
  files,
  selectedPath,
  dirtyPaths,
  onSelect,
  onNewFile
}: Props): React.JSX.Element {
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? files.filter((f) => f.relPath.toLowerCase().includes(q))
      : files;
    const byGroup = new Map<string, EnvFileEntry[]>();
    for (const f of filtered) {
      const arr = byGroup.get(f.group) ?? [];
      arr.push(f);
      byGroup.set(f.group, arr);
    }
    return Array.from(byGroup.entries());
  }, [files, filter]);

  return (
    <div className="flex w-[230px] shrink-0 flex-col border-r border-neutral-800 bg-neutral-900">
      <div className="border-b border-neutral-800 p-2">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files…"
            className="w-full rounded-md border border-neutral-700 bg-neutral-800 py-1.5 pl-7 pr-2 text-xs text-neutral-200 transition-colors focus:border-neutral-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {groups.length === 0 ? (
          <p className="px-3 py-4 text-xs text-neutral-500">
            {filter ? 'No files match the filter.' : 'No .env files found.'}
          </p>
        ) : (
          groups.map(([group, entries]) => (
            <Fragment key={group}>
              <div className="px-3 pb-1 pt-3 text-[9px] font-medium uppercase tracking-wider text-neutral-600">
                {group === '·root' ? '· root' : group}
              </div>
              {entries.map((f) => {
                const selected = f.absPath === selectedPath;
                const dirty = dirtyPaths.has(f.absPath);
                return (
                  <button
                    key={f.absPath}
                    onClick={() => onSelect(f)}
                    disabled={!f.readable}
                    title={f.readable ? f.relPath : 'Cannot read this file'}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs transition-colors ${
                      selected
                        ? 'bg-blue-950/50 font-semibold text-white shadow-[inset_3px_0_0_0_#3b82f6]'
                        : 'text-neutral-300 hover:bg-neutral-800'
                    } ${f.isTemplate ? 'italic text-neutral-500' : ''} disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    <span className="truncate">{f.name}</span>
                    {dirty && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.6)]"
                        aria-label="unsaved changes"
                      />
                    )}
                    <span className="ml-auto shrink-0 text-[9px] text-neutral-600">{f.varCount}</span>
                  </button>
                );
              })}
            </Fragment>
          ))
        )}
      </div>

      <div className="border-t border-neutral-800 p-2">
        <button
          onClick={onNewFile}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-neutral-800 py-1.5 text-xs text-neutral-200 transition hover:bg-neutral-700 active:scale-[0.98]"
        >
          <FilePlus2 size={13} /> New .env file
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Load files and render the navigator in the modal**

Replace the body of `src/renderer/src/components/env-editor/EnvEditorModal.tsx` with:

```tsx
// src/renderer/src/components/env-editor/EnvEditorModal.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Folder, ChevronDown } from 'lucide-react';
import { FileNavigator } from './FileNavigator';
import type { EnvFileEntry } from '../../../../shared/env-editor-types';

export function EnvEditorModal({
  isOpen,
  onClose,
  cwd
}: {
  isOpen: boolean;
  onClose: () => void;
  cwd: string | undefined;
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<string | undefined>(cwd);
  const [files, setFiles] = useState<EnvFileEntry[]>([]);
  const [selected, setSelected] = useState<EnvFileEntry | null>(null);

  useEffect(() => {
    if (isOpen) setRoot(cwd);
  }, [isOpen, cwd]);

  const reload = useCallback(async () => {
    if (!root) {
      setFiles([]);
      return;
    }
    const list = await window.fleet.envEditor.list(root);
    setFiles(list);
  }, [root]);

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload]);

  useEffect(() => {
    if (isOpen) panelRef.current?.focus();
  }, [isOpen]);

  const pickFolder = useCallback(async () => {
    const dir = await window.fleet.showFolderPicker();
    if (dir) {
      setSelected(null);
      setRoot(dir);
    }
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[85vh] w-[860px] flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-neutral-800 px-5 py-3">
          <h2 className="text-base font-semibold text-neutral-100">Env Editor</h2>
          <button
            onClick={pickFolder}
            title={root}
            className="flex items-center gap-1.5 rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300 transition hover:bg-neutral-700 active:scale-[0.98]"
          >
            <Folder size={13} />
            <span className="max-w-[260px] truncate">{root ? basenameOf(root) : 'Pick folder'}</span>
            <ChevronDown size={13} className="text-neutral-500" />
          </button>
          <button
            onClick={onClose}
            className="ml-auto rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-white active:scale-90"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <FileNavigator
            files={files}
            selectedPath={selected?.absPath ?? null}
            dirtyPaths={new Set()}
            onSelect={setSelected}
            onNewFile={() => {
              /* implemented in Task 11 */
            }}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            {selected ? (
              <div className="p-6 text-sm text-neutral-400">Selected: {selected.relPath}</div>
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-sm text-neutral-500">
                {files.length === 0
                  ? 'No .env files in this folder yet.'
                  : 'Select a file to edit.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function basenameOf(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}
```

Note: ensure the React import line is exactly `import { useCallback, useEffect, useRef, useState } from 'react';` — `useCallback` is added here (the stub from Task 6 only imported nothing from react).

- [ ] **Step 3: Typecheck and manually verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run dev`. Open the Env Editor in a project that has `.env` files. Expected: left navigator lists files grouped by folder (·root first), with a working filter box, var-count on the right, templates dimmed/italic, and a "New .env file" button. Selecting a file shows "Selected: <path>" on the right. The folder button in the header opens a picker and re-scans.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/env-editor/FileNavigator.tsx src/renderer/src/components/env-editor/EnvEditorModal.tsx
git commit -m "feat(env-editor): add grouped file navigator with filter"
```

---

## Task 8: Structured form editor (rows, masking, validation, add/remove)

**Files:**
- Create: `src/renderer/src/components/env-editor/EnvForm.tsx`
- Modify: `src/renderer/src/components/env-editor/EnvEditorModal.tsx`

- [ ] **Step 1: Create the form component**

```tsx
// src/renderer/src/components/env-editor/EnvForm.tsx
import { useMemo } from 'react';
import { Eye, EyeOff, Trash2, Plus } from 'lucide-react';
import type { EnvLine, VarLine } from '../../../../shared/env-parse';
import { updateVarLine, newVarLine } from '../../../../shared/env-parse';

type Props = {
  lines: EnvLine[];
  revealAll: boolean;
  revealed: Set<number>;
  onToggleReveal: (index: number) => void;
  onChange: (lines: EnvLine[]) => void;
};

export function EnvForm({
  lines,
  revealAll,
  revealed,
  onToggleReveal,
  onChange
}: Props): React.JSX.Element {
  // Indices of var lines, in order, for rendering + duplicate detection.
  const varIndices = useMemo(
    () => lines.map((l, i) => (l.kind === 'var' ? i : -1)).filter((i) => i >= 0),
    [lines]
  );

  const dupKeys = useMemo(() => {
    const seen = new Map<string, number>();
    const dups = new Set<string>();
    for (const i of varIndices) {
      const key = (lines[i] as VarLine).key;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if ((seen.get(key) ?? 0) > 1 && key) dups.add(key);
    }
    return dups;
  }, [lines, varIndices]);

  const setLine = (index: number, next: EnvLine): void => {
    const copy = lines.slice();
    copy[index] = next;
    onChange(copy);
  };

  const removeLine = (index: number): void => {
    onChange(lines.filter((_, i) => i !== index));
  };

  const addVar = (): void => {
    onChange([...lines, newVarLine('', '')]);
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-3">
      {varIndices.length === 0 && (
        <p className="px-2 py-3 text-xs text-neutral-500">
          No variables yet. Add one below, or switch to Raw to add comments.
        </p>
      )}
      {varIndices.map((index) => {
        const line = lines[index] as VarLine;
        const reveal = revealAll || revealed.has(index);
        const isDup = Boolean(line.key) && dupKeys.has(line.key);
        return (
          <div
            key={index}
            className="group flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-neutral-800/60 focus-within:bg-neutral-800/80 focus-within:shadow-[inset_0_0_0_1px_#2563eb]"
          >
            <input
              value={line.key}
              onChange={(e) => setLine(index, updateVarLine(line, e.target.value, line.value))}
              placeholder="KEY"
              spellCheck={false}
              className={`w-[40%] rounded border bg-neutral-900 px-2 py-1 font-mono text-xs text-sky-300 outline-none transition-colors focus:border-blue-500 ${
                isDup ? 'border-red-600' : 'border-transparent focus:border-blue-500'
              }`}
            />
            <span className="text-neutral-600">=</span>
            <input
              value={line.value}
              type={reveal ? 'text' : 'password'}
              onChange={(e) => setLine(index, updateVarLine(line, line.key, e.target.value))}
              placeholder="value"
              spellCheck={false}
              className="flex-1 rounded border border-transparent bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-200 outline-none transition-colors focus:border-blue-500"
            />
            <button
              onClick={() => onToggleReveal(index)}
              title={reveal ? 'Hide value' : 'Reveal value'}
              className="rounded p-1 text-neutral-500 opacity-0 transition hover:text-neutral-200 group-hover:opacity-100 active:scale-90"
            >
              {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <button
              onClick={() => removeLine(index)}
              title="Remove variable"
              className="rounded p-1 text-neutral-500 opacity-0 transition hover:text-red-400 group-hover:opacity-100 active:scale-90"
            >
              <Trash2 size={13} />
            </button>
          </div>
        );
      })}

      {dupKeys.size > 0 && (
        <p className="mt-2 px-2 text-[11px] text-red-400">
          Duplicate keys: {Array.from(dupKeys).join(', ')} — the last value wins.
        </p>
      )}

      <button
        onClick={addVar}
        className="mt-2 flex w-fit items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-blue-400 transition hover:bg-blue-500/10 active:scale-[0.98]"
      >
        <Plus size={14} /> Add variable
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Hold parsed state and render the form in the modal**

In `EnvEditorModal.tsx`:
- Add imports:

```tsx
import { parseEnvFile, serializeEnvFile, type EnvLine, type ParsedEnvFile } from '../../../../shared/env-parse';
```

- Add state (near the other `useState` calls):

```tsx
  const [parsed, setParsed] = useState<ParsedEnvFile | null>(null);
  const [originalText, setOriginalText] = useState('');
  const [mtimeMs, setMtimeMs] = useState(0);
  const [revealAll, setRevealAll] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
```

- Add a loader that runs when `selected` changes:

```tsx
  useEffect(() => {
    let cancelled = false;
    setRevealed(new Set());
    setRevealAll(false);
    if (!selected) {
      setParsed(null);
      setOriginalText('');
      return;
    }
    void window.fleet.envEditor.read(selected.absPath).then((res) => {
      if (cancelled) return;
      setOriginalText(res.text);
      setMtimeMs(res.mtimeMs);
      setParsed(parseEnvFile(res.text));
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const setLines = useCallback(
    (lines: EnvLine[]) => setParsed((p) => (p ? { ...p, lines } : p)),
    []
  );

  const toggleReveal = useCallback((index: number) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const dirty = parsed !== null && serializeEnvFile(parsed) !== originalText;
```

- Replace the right-hand `{selected ? (...) : (...)}` block with:

```tsx
            {selected && parsed ? (
              <EnvForm
                lines={parsed.lines}
                revealAll={revealAll}
                revealed={revealed}
                onToggleReveal={toggleReveal}
                onChange={setLines}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-sm text-neutral-500">
                {files.length === 0
                  ? 'No .env files in this folder yet.'
                  : 'Select a file to edit.'}
              </div>
            )}
```

- Add `import { EnvForm } from './EnvForm';` at the top.
- Pass real dirty state to the navigator: change `dirtyPaths={new Set()}` to `dirtyPaths={dirty && selected ? new Set([selected.absPath]) : new Set()}`.

- [ ] **Step 3: Typecheck and manually verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run dev`. Select a file. Expected: each variable shows as a row (key in sky-blue, value masked as dots). Hovering a row reveals the eye and trash icons; the eye toggles that row's value; typing in a value un-masks while focused if revealed. Adding a duplicate key turns the key border red and shows the duplicate warning. "Add variable" appends an empty row. The navigator shows an amber dirty dot once you edit.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/env-editor/EnvForm.tsx src/renderer/src/components/env-editor/EnvEditorModal.tsx
git commit -m "feat(env-editor): add structured form with masking and validation"
```

---

## Task 9: Raw editor + Form/Raw toggle + reveal-all

**Files:**
- Create: `src/renderer/src/components/env-editor/EnvRawEditor.tsx`
- Modify: `src/renderer/src/components/env-editor/EnvEditorModal.tsx`

- [ ] **Step 1: Create the raw editor**

```tsx
// src/renderer/src/components/env-editor/EnvRawEditor.tsx
type Props = {
  text: string;
  onChange: (text: string) => void;
};

export function EnvRawEditor({ text, onChange }: Props): React.JSX.Element {
  return (
    <textarea
      value={text}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      className="flex-1 resize-none bg-neutral-950 p-4 font-mono text-xs leading-relaxed text-neutral-200 outline-none"
      placeholder="# KEY=value"
    />
  );
}
```

- [ ] **Step 2: Add the toggle, reveal-all button, and an editor header in the modal**

In `EnvEditorModal.tsx`:
- Add imports: `import { Table, Code, Eye, EyeOff } from 'lucide-react';` (merge into the existing lucide import line) and `import { EnvRawEditor } from './EnvRawEditor';`.
- Add state: `const [mode, setMode] = useState<'form' | 'raw'>('form');` and `const RAW_ONLY_BYTES = 256 * 1024;`
- Compute a large-file guard after `originalText` is known:

```tsx
  const rawOnly = originalText.length > RAW_ONLY_BYTES;
  const effectiveMode = rawOnly ? 'raw' : mode;
```

- When switching **to** raw, sync the textarea from the parsed lines; when switching **back** to form, re-parse the raw text. Implement a single derived `rawText` that lives in state and is kept in sync. Add:

```tsx
  const [rawText, setRawText] = useState('');

  // Keep raw text in sync when entering raw mode or when a new file loads.
  useEffect(() => {
    if (parsed && effectiveMode === 'raw') setRawText(serializeEnvFile(parsed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveMode, selected]);

  const onRawChange = useCallback((text: string) => {
    setRawText(text);
    setParsed(parseEnvFile(text));
  }, []);
```

(Note: the eslint-disable is acceptable here per repo conventions; alternatively list `parsed` if lint is clean. Confirm with `npm run lint`.)

- Insert an editor header above the form/raw area (inside the right column, before the conditional editor):

```tsx
            {selected && (
              <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
                <span className="font-mono text-xs text-neutral-200">{selected.name}</span>
                {selected.isTemplate && (
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-neutral-500">
                    template
                  </span>
                )}
                {dirty && <span className="text-[10px] text-amber-400">● unsaved</span>}
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => setRevealAll((v) => !v)}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-300 transition hover:bg-neutral-800 active:scale-95"
                  >
                    {revealAll ? <EyeOff size={13} /> : <Eye size={13} />}
                    {revealAll ? 'Hide all' : 'Reveal all'}
                  </button>
                  {!rawOnly && (
                    <div className="flex overflow-hidden rounded-md border border-neutral-700 text-xs">
                      <button
                        onClick={() => setMode('form')}
                        className={`flex items-center gap-1 px-2.5 py-1 transition ${
                          mode === 'form' ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:bg-neutral-800'
                        }`}
                      >
                        <Table size={12} /> Form
                      </button>
                      <button
                        onClick={() => setMode('raw')}
                        className={`flex items-center gap-1 px-2.5 py-1 transition ${
                          mode === 'raw' ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:bg-neutral-800'
                        }`}
                      >
                        <Code size={12} /> Raw
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
```

- Change the editor conditional to switch on `effectiveMode`:

```tsx
            {selected && parsed ? (
              effectiveMode === 'raw' ? (
                <EnvRawEditor text={rawText} onChange={onRawChange} />
              ) : (
                <EnvForm
                  lines={parsed.lines}
                  revealAll={revealAll}
                  revealed={revealed}
                  onToggleReveal={toggleReveal}
                  onChange={setLines}
                />
              )
            ) : (
              /* empty state unchanged */
            )}
```

- [ ] **Step 3: Typecheck, lint, manually verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS (resolve any lint complaint about the effect deps as noted).

Run: `npm run dev`. Toggle Form↔Raw: edits made in form appear in raw and vice-versa; comments typed in raw survive a round-trip back to form (they don't appear as rows but are preserved on save in Task 10). "Reveal all" unmasks every value at once. A file > 256 KB shows raw only (no toggle).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/env-editor/EnvRawEditor.tsx src/renderer/src/components/env-editor/EnvEditorModal.tsx
git commit -m "feat(env-editor): add raw editor, form/raw toggle, reveal-all"
```

---

## Task 10: Save flow (Cmd+S, Save button, optimistic, external-change, unsaved guard)

**Files:**
- Modify: `src/renderer/src/components/env-editor/EnvEditorModal.tsx`

- [ ] **Step 1: Add save state and the save action**

In `EnvEditorModal.tsx`:
- Add imports: `import { Save, AlertTriangle, Loader2 } from 'lucide-react';` and `import { useToastStore } from '../../store/toast-store';`
- Add state:

```tsx
  const showToast = useToastStore((s) => s.show);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [externalChange, setExternalChange] = useState(false);
```

- Add the save function:

```tsx
  const save = useCallback(async () => {
    if (!selected || !parsed || saving) return;
    const text = serializeEnvFile(parsed);
    setSaving(true);
    setError(null);
    try {
      const res = await window.fleet.envEditor.write(selected.absPath, text, mtimeMs);
      if (!res.ok && res.externalChange) {
        setExternalChange(true);
        return;
      }
      setOriginalText(text);
      setMtimeMs(res.mtimeMs);
      setExternalChange(false);
      void reload(); // refresh var counts
      showToast('Saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }, [selected, parsed, mtimeMs, saving, reload, showToast]);
```

- Add a global Cmd/Ctrl+S handler (only while open):

```tsx
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, dirty, save]);
```

- [ ] **Step 2: Add the Save button to the header**

In the top header row (next to the Close button), insert before the `<button onClick={onClose}` (so it sits left of X):

```tsx
          <button
            onClick={() => void save()}
            disabled={!dirty || saving}
            title="Save (⌘S)"
            className="ml-auto inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition active:scale-[0.97] hover:bg-blue-500 disabled:bg-neutral-800 disabled:text-neutral-600 disabled:active:scale-100"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save
          </button>
```

Remove the `ml-auto` from the Close button if present so the Save button owns the right alignment (Close keeps its own styling without `ml-auto`).

- [ ] **Step 3: Add the external-change + error banners**

Directly above the editor header (inside the right column, before the `{selected && (` header block), add:

```tsx
            {error && (
              <div className="flex items-center gap-2 border-b border-red-800 bg-red-950/40 px-4 py-2 text-xs text-red-300">
                <AlertTriangle size={13} /> {error}
              </div>
            )}
            {externalChange && (
              <div className="flex items-center gap-2 border-b border-amber-800 bg-amber-950/40 px-4 py-2 text-xs text-amber-300">
                <AlertTriangle size={13} />
                This file changed on disk.
                <button
                  onClick={() => {
                    setExternalChange(false);
                    setSelected((s) => (s ? { ...s } : s)); // re-trigger the load effect
                  }}
                  className="font-medium underline"
                >
                  Reload
                </button>
                <button
                  onClick={() => {
                    setExternalChange(false);
                    void window.fleet.envEditor
                      .write(selected!.absPath, serializeEnvFile(parsed!))
                      .then((r) => {
                        setMtimeMs(r.mtimeMs);
                        setOriginalText(serializeEnvFile(parsed!));
                        showToast('Saved');
                      });
                  }}
                  className="font-medium underline"
                >
                  Overwrite
                </button>
              </div>
            )}
```

- [ ] **Step 4: Add the unsaved-changes guard on close and file-switch**

- Wrap close so it warns when dirty. Replace the `onClose` calls on the backdrop, Escape, and X button with `requestClose`:

```tsx
  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  }, [dirty, onClose]);
```

Use `requestClose` for: the backdrop `onClick`, the Escape handler, and the X button `onClick`.

- Guard file switching. Wrap `setSelected` from the navigator:

```tsx
  const selectFile = useCallback(
    (file: EnvFileEntry) => {
      if (dirty && !window.confirm('Discard unsaved changes to this file?')) return;
      setSelected(file);
    },
    [dirty]
  );
```

Pass `onSelect={selectFile}` to `<FileNavigator>`.

- [ ] **Step 5: Typecheck, lint, manually verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

Run: `npm run dev`. Edit a value → Save button activates (blue) and shows the dirty dot. Press ⌘S or click Save → spinner briefly, "Saved" toast, dot clears, file persists (verify with `cat`). Edit the file externally (`echo X=1 >> path`) then Save → amber "changed on disk" banner with Reload/Overwrite. Edit then try to close/switch files → confirm prompt. Trigger a write error (e.g. make the file read-only) → inline red error, no toast.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/env-editor/EnvEditorModal.tsx
git commit -m "feat(env-editor): add explicit save, external-change detection, unsaved guard"
```

---

## Task 11: File operations UI (create, rename, delete + undo)

**Files:**
- Create: `src/renderer/src/components/env-editor/NewFileDialog.tsx`
- Modify: `src/renderer/src/components/env-editor/FileNavigator.tsx`
- Modify: `src/renderer/src/components/env-editor/EnvEditorModal.tsx`

- [ ] **Step 1: Create the new-file dialog**

```tsx
// src/renderer/src/components/env-editor/NewFileDialog.tsx
import { useState } from 'react';

type Props = {
  groups: string[]; // distinct folder groups ('·root' for top level)
  onCancel: () => void;
  onCreate: (group: string, name: string) => void;
  error: string | null;
};

export function NewFileDialog({ groups, onCancel, onCreate, error }: Props): React.JSX.Element {
  const [group, setGroup] = useState(groups[0] ?? '·root');
  const [name, setName] = useState('.env');

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[360px] rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-2xl"
      >
        <h3 className="mb-3 text-sm font-semibold text-neutral-100">New .env file</h3>
        <label className="mb-1 block text-[10px] uppercase tracking-wide text-neutral-500">Folder</label>
        <select
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          className="mb-3 w-full rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-xs text-neutral-200 outline-none focus:border-neutral-500"
        >
          {groups.map((g) => (
            <option key={g} value={g}>
              {g === '·root' ? '· root' : g}
            </option>
          ))}
        </select>
        <label className="mb-1 block text-[10px] uppercase tracking-wide text-neutral-500">File name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCreate(group, name);
          }}
          spellCheck={false}
          className="w-full rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1.5 font-mono text-xs text-neutral-200 outline-none focus:border-blue-500"
        />
        {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-800 active:scale-95"
          >
            Cancel
          </button>
          <button
            onClick={() => onCreate(group, name)}
            disabled={!name.startsWith('.env')}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 active:scale-95 disabled:bg-neutral-800 disabled:text-neutral-600"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add rename + delete affordances to navigator rows**

In `FileNavigator.tsx`:
- Extend `Props` with `onRename: (file: EnvFileEntry, newName: string) => void;` and `onDelete: (file: EnvFileEntry) => void;`
- Add `Pencil` and `Trash2` to the lucide import.
- Add local state `const [renaming, setRenaming] = useState<string | null>(null);` and `const [draft, setDraft] = useState('');`
- Replace the file row's inner content so that when `renaming === f.absPath` it shows an inline input; otherwise it shows the name plus, on hover, a rename and delete button:

```tsx
                    {renaming === f.absPath ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            onRename(f, draft);
                            setRenaming(null);
                          } else if (e.key === 'Escape') {
                            setRenaming(null);
                          }
                        }}
                        onBlur={() => setRenaming(null)}
                        spellCheck={false}
                        className="w-full rounded border border-blue-500 bg-neutral-800 px-1 py-0.5 font-mono text-xs text-neutral-100 outline-none"
                      />
                    ) : (
                      <>
                        <span className="truncate">{f.name}</span>
                        {dirty && (
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.6)]"
                            aria-label="unsaved changes"
                          />
                        )}
                        <span className="ml-auto flex items-center gap-1">
                          <span className="text-[9px] text-neutral-600 group-hover:hidden">{f.varCount}</span>
                          <span className="hidden items-center gap-1 group-hover:flex">
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(e) => {
                                e.stopPropagation();
                                setDraft(f.name);
                                setRenaming(f.absPath);
                              }}
                              title="Rename"
                              className="rounded p-0.5 text-neutral-500 transition hover:text-neutral-200 active:scale-90"
                            >
                              <Pencil size={11} />
                            </span>
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(e) => {
                                e.stopPropagation();
                                onDelete(f);
                              }}
                              title="Delete"
                              className="rounded p-0.5 text-neutral-500 transition hover:text-red-400 active:scale-90"
                            >
                              <Trash2 size={11} />
                            </span>
                          </span>
                        </span>
                      </>
                    )}
```

Note: the file row is a `<button>`; nested interactive controls use `role="button"` spans with `stopPropagation` to avoid invalid nested-button markup. Add `className="group ..."` already present on the row. Wrap the row content in the conditional above (replacing the previous `<span className="truncate">…</span>` + dirty + count block).

- [ ] **Step 3: Wire the operations in the modal**

In `EnvEditorModal.tsx`:
- Add state: `const [newFileOpen, setNewFileOpen] = useState(false);` and `const [newFileError, setNewFileError] = useState<string | null>(null);`
- Add `import { NewFileDialog } from './NewFileDialog';`
- Compute distinct groups for the dialog: `const groups = Array.from(new Set(files.map((f) => f.group)));` (fallback to `['·root']` if empty — `const dialogGroups = groups.length ? groups : ['·root'];`).
- Add handlers:

```tsx
  const rootForGroup = (group: string): string =>
    group === '·root' ? root! : `${root}/${group}`;

  const createFile = useCallback(
    async (group: string, name: string) => {
      if (!root) return;
      setNewFileError(null);
      try {
        const { absPath } = await window.fleet.envEditor.create(rootForGroup(group), name);
        setNewFileOpen(false);
        await reload();
        const list = await window.fleet.envEditor.list(root);
        const created = list.find((f) => f.absPath === absPath) ?? null;
        if (created) setSelected(created);
      } catch (e) {
        setNewFileError(e instanceof Error ? e.message : 'Could not create file');
      }
    },
    [root, reload]
  );

  const renameFile = useCallback(
    async (file: EnvFileEntry, newName: string) => {
      if (newName === file.name || !newName.startsWith('.env')) return;
      try {
        const { absPath } = await window.fleet.envEditor.rename(file.absPath, newName);
        await reload();
        if (selected?.absPath === file.absPath) {
          const list = await window.fleet.envEditor.list(root!);
          setSelected(list.find((f) => f.absPath === absPath) ?? null);
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Could not rename file');
      }
    },
    [reload, root, selected, showToast]
  );

  const deleteFile = useCallback(
    async (file: EnvFileEntry) => {
      const { trashPath } = await window.fleet.envEditor.delete(file.absPath);
      if (selected?.absPath === file.absPath) setSelected(null);
      await reload();
      showToast(`Deleted ${file.name}`, {
        action: {
          label: 'Undo',
          onClick: () => {
            void window.fleet.envEditor.restore(trashPath, file.absPath).then(() => void reload());
          }
        }
      });
    },
    [reload, selected, showToast]
  );
```

- Pass the new handlers to `<FileNavigator ... onRename={renameFile} onDelete={deleteFile} onNewFile={() => { setNewFileError(null); setNewFileOpen(true); }} />`.
- Render the dialog inside the right column container (which must be `relative` so the dialog overlays the editor): add `className="relative flex min-h-0 flex-1 flex-col"` to that column, then before its closing tag:

```tsx
            {newFileOpen && (
              <NewFileDialog
                groups={dialogGroups}
                error={newFileError}
                onCancel={() => setNewFileOpen(false)}
                onCreate={createFile}
              />
            )}
```

- [ ] **Step 4: Typecheck, lint, manually verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

Run: `npm run dev`. "New .env file" → dialog with folder dropdown + name; creating with a colliding name shows the inline error; success selects the new file. Hover a row → rename (inline, Enter commits, Esc cancels, collision shows a toast) and delete (file disappears, "Deleted … Undo" toast; Undo restores it).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/env-editor/NewFileDialog.tsx src/renderer/src/components/env-editor/FileNavigator.tsx src/renderer/src/components/env-editor/EnvEditorModal.tsx
git commit -m "feat(env-editor): add create, rename, and soft-delete-with-undo"
```

---

## Task 12: Empty state, animations, reduced-motion, final verification

**Files:**
- Modify: `src/renderer/src/components/env-editor/EnvEditorModal.tsx`
- Modify: `src/renderer/src/components/env-editor/FileNavigator.tsx`

- [ ] **Step 1: Improve the right-pane empty/first-run state**

In `EnvEditorModal.tsx`, replace the right-pane empty state text block with a proper empty state (single primary action):

```tsx
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                <FilePlus2 size={28} className="text-neutral-600" />
                <p className="text-sm text-neutral-400">
                  {files.length === 0
                    ? 'No .env files in this folder.'
                    : 'Select a file from the left to edit it.'}
                </p>
                {files.length === 0 && (
                  <button
                    onClick={() => {
                      setNewFileError(null);
                      setNewFileOpen(true);
                    }}
                    className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 active:scale-[0.97]"
                  >
                    <FilePlus2 size={15} /> Create .env file
                  </button>
                )}
              </div>
```

Add `FilePlus2` to the modal's lucide import.

- [ ] **Step 2: Add modal enter animation honoring reduced-motion**

The repo uses Tailwind; verify an animation utility exists by checking `tailwind.config` / global CSS for `animate-in` or existing keyframes (search: `grep -rn "@keyframes\|animate-in\|tailwindcss-animate" src tailwind.config*`). 

- If `tailwindcss-animate` (the `animate-in fade-in zoom-in` utilities) is available, add to the panel `div` className: `animate-in fade-in zoom-in-95 duration-200 motion-reduce:animate-none` and to the backdrop: `animate-in fade-in duration-200 motion-reduce:animate-none`.
- If NOT available, add a scoped keyframe to the renderer global stylesheet (`src/renderer/src/assets/main.css` or the file imported by `main.tsx` — confirm via `grep -rn "import './assets" src/renderer/src/main.tsx`):

```css
@keyframes env-editor-pop {
  from { opacity: 0; transform: scale(0.97); }
  to { opacity: 1; transform: scale(1); }
}
.env-editor-pop { animation: env-editor-pop 200ms ease-out; }
@media (prefers-reduced-motion: reduce) {
  .env-editor-pop { animation: none; }
}
```

Then add `env-editor-pop` to the panel `div` className.

- [ ] **Step 3: Confirm press feedback is on every interactive control**

Review all buttons in `EnvEditorModal.tsx`, `FileNavigator.tsx`, `EnvForm.tsx`, and `NewFileDialog.tsx`: each `<button>` (and the `role="button"` spans) must include `active:scale-90` or `active:scale-[0.97]/[0.98]` and a `transition`. Add any that are missing. This satisfies the NN/g "click feedback under 100ms" requirement.

- [ ] **Step 4: Full verification suite**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run lint`
Expected: PASS (no new errors introduced by env-editor files).

Run: `npx vitest run src/shared/__tests__/env-parse.test.ts src/shared/__tests__/env-editor-types.test.ts src/main/__tests__/env-editor-fs.test.ts`
Expected: PASS (all env-editor tests).

Run: `npm run build`
Expected: completes (typecheck + electron-vite build succeed).

- [ ] **Step 5: Full manual acceptance pass**

Run `npm run dev` and verify end-to-end against the spec:
- Toolbar pen icon opens the modal; backdrop/Esc/X close it (with unsaved guard).
- Folder picker re-scans; nested files grouped correctly; templates dimmed; unreadable files disabled.
- Filter narrows the list; zero matches shows the empty message.
- Form editing: masked values, per-row reveal, reveal-all, duplicate-key warning, add/remove rows.
- Raw mode preserves comments/order; Form↔Raw stays in sync; >256 KB is raw-only.
- Save via ⌘S and button; "Saved" toast; dirty indicators; external-change banner; inline write errors.
- Create/rename/delete with undo all work.
- Animations play on open and respect `prefers-reduced-motion` (toggle via OS setting or DevTools "Emulate prefers-reduced-motion").
- No emoji anywhere; all icons are lucide-react.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/env-editor/EnvEditorModal.tsx src/renderer/src/components/env-editor/FileNavigator.tsx
git commit -m "feat(env-editor): add empty state, open animation, reduced-motion support"
```

---

## Final Notes for the Implementer

- **ESM:** main/preload are ESM — no `__dirname`; not relevant here but keep imports extension-less per existing files.
- **No `as` casts:** the repo bans unsafe assertions in `src/` (allowed in tests). The two `as VarLine`/`as never` usages are confined to the test file and the form's `lines[index] as VarLine` narrowing — if lint flags the latter, narrow with a type guard (`if (line.kind !== 'var') return null;`) instead.
- **Renderer has no unit harness:** rely on `npm run typecheck`, `npm run lint`, and the manual passes for renderer tasks; the pure logic (parser, fs) carries the automated coverage.
- **Toast errors:** never route errors through `showToast` except the rename-collision case (a transient, non-destructive nicety); destructive/critical feedback stays inline per the spec.
