# Kanban PM Board Projects & Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Kanban PM agent project (code) context and board knowledge (PRDs, memory, artifact flowback), with tickets routed to the right repo.

**Architecture:** A per-board `projects` registry (SQLite) with one default project; project paths injected into the PM's generated `AGENTS.md` so it reads code with rune's native file tools; a `project` param on PM create tools resolves to `repoPath`. Board knowledge lives as files in the PM's cwd (`~/.fleet/kanban/pm/<boardId>/`): `MEMORY.md` (injected each turn) and `docs/` (PM-authored PRDs, referenced by a new `docs` field on tasks and inlined into worker prompts at dispatch). Flowback reuses the existing artifact system via PM read access.

**Tech Stack:** Electron main process (TypeScript, better-sqlite3, zod), vitest, React + Tailwind renderer.

**Spec:** `docs/superpowers/specs/2026-06-09-kanban-pm-projects-and-knowledge-design.md`

---

## File Structure

| File | Change |
|---|---|
| `src/main/kanban/schema.ts` | v10: `projects` table + `tasks.docs` column |
| `src/shared/kanban-types.ts` | `Project` type; `docs` on Task/CreateTaskInput/UpdateTaskFields |
| `src/main/kanban/kanban-store.ts` | project CRUD + default promotion; `docs` through create/update/rowToTask; deleteBoard cleanup |
| `src/main/kanban/kanban-commands.ts` | validated project commands |
| `src/main/kanban/pm-paths.ts` | **new** — PM dir paths + `loadTaskDocs` |
| `src/main/kanban/pm-agents.ts` | **new** — pure `buildPmAgentsMd` generator |
| `src/main/kanban/pm-chat-service.ts` | use generator; ensure docs dir; read MEMORY.md |
| `src/main/kanban/kanban-mcp-server.ts` | PM tools: project_list/add/remove, artifact_read; `project`+`docs` params; artifacts in kanban_show; `setKanbanHome` |
| `src/main/kanban/spawn-worker.ts` | `docs` in BuildWorkerInput, inlined into work prompt |
| `src/main/index.ts` | wire docs loading, `getProjects`, `setKanbanHome` |
| `src/shared/ipc-channels.ts`, `src/shared/ipc-api.ts`, `src/preload/index.ts` | 4 new project IPC endpoints |
| `src/main/kanban/kanban-ipc.ts` | project IPC handlers |
| `src/renderer/src/components/kanban/ProjectsModal.tsx` | **new** — Projects dialog |
| `src/renderer/src/components/kanban/KanbanBoard.tsx` | Projects toolbar button |
| Tests | `kanban-store.test.ts`, `kanban-commands.test.ts`, `kanban-mcp-server.test.ts`, `pm-agents.test.ts` (new), `pm-paths.test.ts` (new), `kanban-spawn.test.ts` (new or existing) |

---

### Task 0: Pre-flight — can headless rune read absolute paths outside its cwd?

This decides approach A (native file tools, the plan as written) vs fallback B (scoped MCP read tools). Everything else in the plan is unaffected by the outcome.

- [ ] **Step 1: Run the probe**

```bash
mkdir -p /tmp/pm-preflight && cd /tmp/pm-preflight && rune --prompt 'Read the file /Users/khangnguyen/Development/fleet/package.json and reply with ONLY the value of its "name" field. If you cannot read files outside your working directory, reply with exactly CANNOT-READ.'
```

Expected: output contains `fleet`.

- [ ] **Step 2: Record the outcome**

If the probe prints `fleet`: proceed with the plan as written.
If it prints `CANNOT-READ` (or errors on file access): **STOP and report to the user.** Tasks 7's prompt text would change ("use kanban_read_file/kanban_grep" instead of "use your file tools") and two scoped read tools must be added to PM_TOOLS. Do not improvise that pivot — surface it.

---

### Task 1: Schema v10 + shared types

**Files:**
- Modify: `src/main/kanban/schema.ts`
- Modify: `src/shared/kanban-types.ts`
- Modify: `src/main/kanban/kanban-store.ts` (migration block only)
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Write the failing test** (append to `kanban-store.test.ts`, inside the top-level describe or as a new one mirroring the file's existing style — it builds a `KanbanStore` against a tmp dir):

```ts
describe('projects schema (v10)', () => {
  // TEST_DIR / store setup identical to the existing describe blocks in this file
  it('migrates to v10 with a projects table and tasks.docs column', () => {
    expect(store.schemaVersion()).toBe(10);
    const t = store.createTask({ title: 'x' });
    expect(t.docs).toEqual([]);
    expect(store.listProjects('default')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`listProjects` not a function / `docs` undefined):

```bash
npx vitest run src/main/__tests__/kanban-store.test.ts
```

- [ ] **Step 3: Bump schema.** In `src/main/kanban/schema.ts`:
  - `export const SCHEMA_VERSION = 10;`
  - In the `tasks` table DDL, after `skills TEXT NOT NULL DEFAULT '[]',` add:
    ```sql
    docs TEXT NOT NULL DEFAULT '[]',
    ```
  - Append to `SCHEMA_SQL` (before the closing backtick):
    ```sql
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      description TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_board_name ON projects(board_id, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_board_path ON projects(board_id, path);
    ```

- [ ] **Step 4: Migration block.** In `kanban-store.ts` `migrate()`, after the `if (current < 9)` block:

```ts
if (current < 10) {
  // Additive: DBs created before v10 lack the projects table + per-task docs column.
  // The projects table is in SCHEMA_SQL for fresh installs; CREATE IF NOT EXISTS is
  // idempotent so existing DBs gain it here.
  this.addColumnIfMissing('tasks', 'docs', "TEXT NOT NULL DEFAULT '[]'");
}
```

(The `projects` table + indexes are created by `SCHEMA_SQL` itself, which runs first and is idempotent — same pattern as `features` for fresh installs; no `ALTER` needed since it's a new table.)

- [ ] **Step 5: Shared types.** In `src/shared/kanban-types.ts`:
  - New interface near `Board`:
    ```ts
    /** A project folder registered on a board. The PM reads code here; tickets route to it. */
    export interface Project {
      id: string;
      boardId: string;
      name: string;
      path: string;
      description: string | null;
      isDefault: boolean;
      createdAt: number;
      updatedAt: number;
    }
    ```
  - `Task` gains (next to `skills: string[]`):
    ```ts
    /** Board docs (filenames under the board's PM docs/ dir) inlined into worker prompts. */
    docs: string[];
    ```
  - `CreateTaskInput` gains `docs?: string[];`
  - `UpdateTaskFields` gains `docs?: string[];`

- [ ] **Step 6: Store plumbing for `docs` + stub `listProjects`.** In `kanban-store.ts`:
  - `rowToTask`: after the `skills` line add
    ```ts
    docs: JSON.parse(String(r.docs ?? '[]')) as string[],
    ```
  - `createTask` INSERT: add `docs` to the column list (after `skills`), `@docs` to VALUES, and `docs: JSON.stringify(input.docs ?? [])` to the `.run({...})` object.
  - `updateTask`: add `docs=@docs` to the SET clause and `docs: fields.docs !== undefined ? JSON.stringify(fields.docs) : JSON.stringify(current.docs)` to the params.
  - Add (near `listBoards`):
    ```ts
    private rowToProject(r: Record<string, unknown>): Project {
      return {
        id: String(r.id),
        boardId: String(r.board_id),
        name: String(r.name),
        path: String(r.path),
        description: (r.description as string | null) ?? null,
        isDefault: Number(r.is_default) === 1,
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at)
      };
    }

    listProjects(boardId: string): Project[] {
      const rows = this.db
        .prepare('SELECT * FROM projects WHERE board_id=? ORDER BY created_at ASC, id ASC')
        .all(boardId) as Array<Record<string, unknown>>;
      return rows.map((r) => this.rowToProject(r));
    }
    ```
  - Import `Project` in the type import block.

- [ ] **Step 7: Run the test — expect PASS.** Then run the full store suite to catch regressions:

```bash
npx vitest run src/main/__tests__/kanban-store.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/main/kanban/schema.ts src/shared/kanban-types.ts src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): schema v10 — projects table and per-task docs column"
```

---

### Task 2: Store project CRUD + default promotion

**Files:**
- Modify: `src/main/kanban/kanban-store.ts`
- Test: `src/main/__tests__/kanban-store.test.ts`

- [ ] **Step 1: Failing tests** (same describe block as Task 1):

```ts
it('first project added becomes the default', () => {
  const p = store.addProject({ boardId: 'default', name: 'fleet', path: '/tmp/a' });
  expect(p.isDefault).toBe(true);
  const q = store.addProject({ boardId: 'default', name: 'site', path: '/tmp/b' });
  expect(q.isDefault).toBe(false);
});

it('setDefaultProject moves the default within a board', () => {
  const p = store.addProject({ boardId: 'default', name: 'fleet', path: '/tmp/a' });
  const q = store.addProject({ boardId: 'default', name: 'site', path: '/tmp/b' });
  store.setDefaultProject(q.id);
  const byName = Object.fromEntries(store.listProjects('default').map((x) => [x.name, x]));
  expect(byName.fleet.isDefault).toBe(false);
  expect(byName.site.isDefault).toBe(true);
});

it('removing the default promotes the oldest remaining project', () => {
  const p = store.addProject({ boardId: 'default', name: 'fleet', path: '/tmp/a' });
  const q = store.addProject({ boardId: 'default', name: 'site', path: '/tmp/b' });
  store.removeProject(p.id);
  const rest = store.listProjects('default');
  expect(rest).toHaveLength(1);
  expect(rest[0].name).toBe('site');
  expect(rest[0].isDefault).toBe(true);
});

it('getProjectByName resolves within the board only', () => {
  store.addProject({ boardId: 'default', name: 'fleet', path: '/tmp/a' });
  expect(store.getProjectByName('default', 'fleet')?.path).toBe('/tmp/a');
  expect(store.getProjectByName('other', 'fleet')).toBeNull();
});

it('deleteBoard removes the board projects', () => {
  const b = store.createBoard('Temp');
  store.addProject({ boardId: b.slug, name: 'x', path: '/tmp/x' });
  store.deleteBoard(b.slug);
  expect(store.listProjects(b.slug)).toEqual([]);
});
```

- [ ] **Step 2: Run — expect FAIL** (`addProject` not a function).

- [ ] **Step 3: Implement** in `kanban-store.ts` (after `listProjects`):

```ts
getProject(id: string): Project | null {
  const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? this.rowToProject(row) : null;
}

getProjectByName(boardId: string, name: string): Project | null {
  const row = this.db
    .prepare('SELECT * FROM projects WHERE board_id=? AND name=?')
    .get(boardId, name) as Record<string, unknown> | undefined;
  return row ? this.rowToProject(row) : null;
}

addProject(input: {
  boardId: string;
  name: string;
  path: string;
  description?: string | null;
}): Project {
  const id = randomUUID().slice(0, 8);
  const ts = this.now();
  return this.db.transaction(() => {
    const isFirst = this.listProjects(input.boardId).length === 0;
    this.db
      .prepare(
        `INSERT INTO projects (id, board_id, name, path, description, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.boardId, input.name, input.path, input.description ?? null, isFirst ? 1 : 0, ts, ts);
    const p = this.getProject(id);
    if (!p) throw new Error('addProject: failed to read back project');
    return p;
  })();
}

/** Remove a project; if it was the default, the oldest remaining project is promoted. */
removeProject(id: string): void {
  this.db.transaction(() => {
    const p = this.getProject(id);
    if (!p) return;
    this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
    if (p.isDefault) {
      const next = this.listProjects(p.boardId)[0];
      if (next) {
        this.db
          .prepare('UPDATE projects SET is_default=1, updated_at=? WHERE id=?')
          .run(this.now(), next.id);
      }
    }
  })();
}

setDefaultProject(id: string): void {
  this.db.transaction(() => {
    const p = this.getProject(id);
    if (!p) return;
    this.db.prepare('UPDATE projects SET is_default=0 WHERE board_id=?').run(p.boardId);
    this.db
      .prepare('UPDATE projects SET is_default=1, updated_at=? WHERE id=?')
      .run(this.now(), id);
  })();
}
```

In `deleteBoard`'s transaction, before `DELETE FROM boards`:

```ts
this.db.prepare('DELETE FROM projects WHERE board_id=?').run(s);
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-store.ts src/main/__tests__/kanban-store.test.ts
git commit -m "feat(kanban): project registry CRUD with default promotion"
```

---

### Task 3: Command-layer validation

**Files:**
- Modify: `src/main/kanban/kanban-commands.ts`
- Test: `src/main/__tests__/kanban-commands.test.ts`

- [ ] **Step 1: Failing tests** (mirror this file's existing setup — it constructs `KanbanStore` + `KanbanDispatcher` + `KanbanCommands` against a tmp dir; use `tmpdir()` for a real existing folder and a file path for the non-directory case):

```ts
import { writeFileSync } from 'fs';

describe('project commands', () => {
  it('addProject validates name, path existence, and duplicates', () => {
    const dir = TEST_DIR; // exists
    expect(() => commands.addProject({ boardId: 'default', name: '  ', path: dir })).toThrow(/name/i);
    expect(() =>
      commands.addProject({ boardId: 'default', name: 'x', path: join(TEST_DIR, 'nope') })
    ).toThrow(/does not exist|not a directory/i);
    const file = join(TEST_DIR, 'afile.txt');
    writeFileSync(file, 'x');
    expect(() => commands.addProject({ boardId: 'default', name: 'x', path: file })).toThrow(
      /not a directory/i
    );
    commands.addProject({ boardId: 'default', name: 'fleet', path: dir });
    expect(() => commands.addProject({ boardId: 'default', name: 'fleet', path: dir })).toThrow(
      /already/i
    );
  });

  it('addProject rejects an unknown board', () => {
    expect(() => commands.addProject({ boardId: 'ghost', name: 'x', path: TEST_DIR })).toThrow(
      /board not found/i
    );
  });

  it('removeProject / setDefaultProject require an existing project', () => {
    expect(() => commands.removeProject('nope')).toThrow(/not found/i);
    expect(() => commands.setDefaultProject('nope')).toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run — expect FAIL:**

```bash
npx vitest run src/main/__tests__/kanban-commands.test.ts
```

- [ ] **Step 3: Implement** in `kanban-commands.ts` (new section after the Features section; add `import { statSync } from 'fs';` and `Project` to the type imports):

```ts
// ---- Projects (board folder registry) ----

listProjects(boardId: string): Project[] {
  this.requireBoard(boardId);
  return this.store.listProjects(boardId);
}

addProject(input: {
  boardId: string;
  name: string;
  path: string;
  description?: string | null;
}): Project {
  this.requireBoard(input.boardId);
  const name = (input.name ?? '').trim();
  if (name === '') throw new CodedError('project requires a name', 'BAD_REQUEST');
  let stat;
  try {
    stat = statSync(input.path);
  } catch {
    throw new CodedError(`project path does not exist: ${input.path}`, 'BAD_REQUEST');
  }
  if (!stat.isDirectory()) {
    throw new CodedError(`project path is not a directory: ${input.path}`, 'BAD_REQUEST');
  }
  const existing = this.store.listProjects(input.boardId);
  if (existing.some((p) => p.name === name)) {
    throw new CodedError(`a project named "${name}" already exists on this board`, 'BAD_REQUEST');
  }
  if (existing.some((p) => p.path === input.path)) {
    throw new CodedError(`this folder is already registered on this board`, 'BAD_REQUEST');
  }
  const description = input.description?.trim() || null;
  return this.store.addProject({ boardId: input.boardId, name, path: input.path, description });
}

removeProject(id: string): void {
  if (!this.store.getProject(id)) throw new CodedError(`project not found: ${id}`, 'NOT_FOUND');
  this.store.removeProject(id);
}

setDefaultProject(id: string): void {
  if (!this.store.getProject(id)) throw new CodedError(`project not found: ${id}`, 'NOT_FOUND');
  this.store.setDefaultProject(id);
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-commands.ts src/main/__tests__/kanban-commands.test.ts
git commit -m "feat(kanban): validated project commands"
```

---

### Task 4: `pm-paths.ts` — PM dir layout + doc loading

**Files:**
- Create: `src/main/kanban/pm-paths.ts`
- Test: `src/main/__tests__/pm-paths.test.ts`

- [ ] **Step 1: Failing test** (new file):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pmBoardDir, pmDocsDir, loadTaskDocs, DOC_INLINE_CAP } from '../kanban/pm-paths';

const TEST_DIR = join(tmpdir(), `fleet-pm-paths-${Date.now()}`);

describe('pm-paths', () => {
  beforeEach(() => mkdirSync(join(TEST_DIR, 'pm', 'b1', 'docs'), { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('computes board and docs dirs', () => {
    expect(pmBoardDir(TEST_DIR, 'b1')).toBe(join(TEST_DIR, 'pm', 'b1'));
    expect(pmDocsDir(TEST_DIR, 'b1')).toBe(join(TEST_DIR, 'pm', 'b1', 'docs'));
  });

  it('loads referenced docs, capping oversized ones and skipping missing ones', () => {
    const dir = pmDocsDir(TEST_DIR, 'b1');
    writeFileSync(join(dir, 'prd.md'), '# PRD\ncontent');
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(DOC_INLINE_CAP + 100));
    const docs = loadTaskDocs(dir, ['prd.md', 'big.md', 'gone.md']);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toEqual({ filename: 'prd.md', content: '# PRD\ncontent', truncated: false });
    expect(docs[1].truncated).toBe(true);
    expect(docs[1].content).toHaveLength(DOC_INLINE_CAP);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing):

```bash
npx vitest run src/main/__tests__/pm-paths.test.ts
```

- [ ] **Step 3: Implement** `src/main/kanban/pm-paths.ts`:

```ts
import { readFileSync } from 'fs';
import { join } from 'path';

/** Per-doc cap when inlining board docs into a worker prompt. */
export const DOC_INLINE_CAP = 32 * 1024;

/** The PM's cwd for a board — also the board's knowledge home (AGENTS.md, MEMORY.md, docs/). */
export function pmBoardDir(kanbanHome: string, boardId: string): string {
  return join(kanbanHome, 'pm', boardId);
}

/** PM-authored living docs (PRDs/specs) for a board. */
export function pmDocsDir(kanbanHome: string, boardId: string): string {
  return join(pmBoardDir(kanbanHome, boardId), 'docs');
}

export interface InlinedDoc {
  filename: string;
  content: string;
  truncated: boolean;
}

/**
 * Read a task's referenced board docs for prompt inlining. Missing files are
 * skipped (a deleted doc must never break dispatch); oversized ones are capped.
 */
export function loadTaskDocs(docsDir: string, names: string[]): InlinedDoc[] {
  const out: InlinedDoc[] = [];
  for (const name of names) {
    let raw: string;
    try {
      raw = readFileSync(join(docsDir, name), 'utf-8');
    } catch {
      continue;
    }
    const truncated = raw.length > DOC_INLINE_CAP;
    out.push({ filename: name, content: truncated ? raw.slice(0, DOC_INLINE_CAP) : raw, truncated });
  }
  return out;
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/pm-paths.ts src/main/__tests__/pm-paths.test.ts
git commit -m "feat(kanban): pm-paths helpers for board knowledge dir and doc inlining"
```

---

### Task 5: `pm-agents.ts` — generated PM persona (projects + memory)

**Files:**
- Create: `src/main/kanban/pm-agents.ts`
- Test: `src/main/__tests__/pm-agents.test.ts`

- [ ] **Step 1: Failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { buildPmAgentsMd } from '../kanban/pm-agents';
import type { Project } from '../../shared/kanban-types';

const proj = (over: Partial<Project>): Project => ({
  id: 'p1',
  boardId: 'default',
  name: 'fleet',
  path: '/Users/me/fleet',
  description: null,
  isDefault: false,
  createdAt: 0,
  updatedAt: 0,
  ...over
});

describe('buildPmAgentsMd', () => {
  it('omits the projects section when none are registered', () => {
    const md = buildPmAgentsMd({ projects: [], memory: null });
    expect(md).toContain('# Fleet board PM');
    expect(md).not.toContain('## Projects on this board');
  });

  it('lists projects with the default marked and read-only instructions', () => {
    const md = buildPmAgentsMd({
      projects: [
        proj({ name: 'fleet', isDefault: true, description: 'the app' }),
        proj({ id: 'p2', name: 'site', path: '/Users/me/site' })
      ],
      memory: null
    });
    expect(md).toContain('## Projects on this board');
    expect(md).toContain('- fleet → /Users/me/fleet — the app (default)');
    expect(md).toContain('- site → /Users/me/site');
    expect(md).toMatch(/read-only/i);
    expect(md).toMatch(/project/i);
  });

  it('injects board memory verbatim', () => {
    const md = buildPmAgentsMd({ projects: [], memory: '- we decided X' });
    expect(md).toContain('## Board memory');
    expect(md).toContain('- we decided X');
  });
});
```

- [ ] **Step 2: Run — expect FAIL:**

```bash
npx vitest run src/main/__tests__/pm-agents.test.ts
```

- [ ] **Step 3: Implement** `src/main/kanban/pm-agents.ts`:

```ts
import type { Project } from '../../shared/kanban-types';

/**
 * Rune appends the cwd's AGENTS.md to its system prompt, so the PM persona lives
 * in the PM workspace dir. Regenerated every turn from the board's project
 * registry and MEMORY.md (moved here from pm-chat-service for testability).
 */
const PM_BASE = `# Fleet board PM

You are the product manager for this Fleet kanban board. The user chats with you
to shape work: turning ideas into well-scoped tickets, splitting features,
prioritizing, and keeping the board tidy.

- Use the kanban MCP tools for every board change (kanban_create, kanban_update,
  kanban_set_status, kanban_link, kanban_feature_create, kanban_assign_feature,
  kanban_comment). Never just describe a change — make it.
- Check the board first (kanban_list, kanban_show) so you don't create duplicates.
- Write tickets like a good PM: an outcome-focused title and a body with context,
  acceptance criteria, and any constraints the user mentioned.
- Ask at most one or two brief clarifying questions when the request is genuinely
  ambiguous; otherwise make a sensible call and say what you assumed.
- Group related tickets under a feature (kanban_feature_create) when the user
  describes a multi-ticket effort, and link dependencies with kanban_link.
- New tickets default to todo; use triage for raw ideas that need refinement.
- Keep replies short and conversational; end with the task ids you touched.
- Your job is the board and its knowledge files — never write code. Project
  folders are strictly read-only; your own docs/ and MEMORY.md are yours to maintain.

## Board knowledge

Your working directory is this board's knowledge home:

- \`MEMORY.md\` — durable decisions, constraints, and learnings. Keep it curated
  and under ~200 lines: record choices and why, things that failed, discovered
  constraints. Not a log. Update it whenever something durable is decided or learned.
- \`docs/\` — living documents (PRDs, specs) you author and maintain with your
  file tools. When shaping a multi-ticket effort, write a PRD here and reference
  it from each ticket via the docs parameter of kanban_create/kanban_update
  (filenames relative to docs/). Fleet shows referenced docs to the workers that
  execute those tickets, so keep them current.
- Finished tickets may have artifacts (worker outputs). kanban_show lists them;
  read one with kanban_artifact_read and distill anything durable into MEMORY.md
  or the relevant doc.
`;

function projectsSection(projects: Project[]): string {
  if (projects.length === 0) return '';
  const lines = projects.map((p) => {
    const desc = p.description ? ` — ${p.description}` : '';
    return `- ${p.name} → ${p.path}${desc}${p.isDefault ? ' (default)' : ''}`;
  });
  return `
## Projects on this board

${lines.join('\n')}

Read code in these folders with your file tools (absolute paths) to ground
tickets in reality. They are read-only: never edit or create files in project
folders. When creating tickets or features, pass the relevant project name via
the project parameter; assume the default project unless the ticket clearly
belongs elsewhere. Manage this list with kanban_project_list / kanban_project_add /
kanban_project_remove.
`;
}

function memorySection(memory: string | null): string {
  if (!memory || memory.trim() === '') return '';
  return `
## Board memory

${memory.trim()}
`;
}

export function buildPmAgentsMd(input: { projects: Project[]; memory: string | null }): string {
  return PM_BASE + projectsSection(input.projects) + memorySection(input.memory);
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/pm-agents.ts src/main/__tests__/pm-agents.test.ts
git commit -m "feat(kanban): generated PM persona with projects and board memory"
```

---

### Task 6: Wire the PM service to the generator + knowledge dir

**Files:**
- Modify: `src/main/kanban/pm-chat-service.ts`
- Modify: `src/main/index.ts` (PmChatService construction, ~line 1045)

No new unit test (the service spawns rune; its logic delta is thin glue over tested units). Verified by typecheck + the existing suite + Task 13's manual run.

- [ ] **Step 1: Edit `pm-chat-service.ts`:**
  - Remove the `PM_AGENTS_MD` constant (it moved to `pm-agents.ts`).
  - Add imports:
    ```ts
    import { buildPmAgentsMd } from './pm-agents';
    import { pmBoardDir, pmDocsDir } from './pm-paths';
    import type { Project } from '../../shared/kanban-types';
    ```
  - `PmChatServiceOptions` gains:
    ```ts
    /** Board project registry, injected into the PM persona each turn. */
    getProjects: (boardId: string) => Project[];
    ```
  - Add a constant near `OUTPUT_CAP`:
    ```ts
    /** Defensive cap on MEMORY.md injection (persona asks for ~200 lines). */
    const MEMORY_INJECT_CAP = 16 * 1024;
    ```
  - In `sendMessage`, replace
    ```ts
    const dir = join(this.opts.kanbanHome, 'pm', boardId);
    const runeDir = join(dir, '.rune');
    mkdirSync(runeDir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), PM_AGENTS_MD);
    ```
    with
    ```ts
    const dir = pmBoardDir(this.opts.kanbanHome, boardId);
    const runeDir = join(dir, '.rune');
    mkdirSync(runeDir, { recursive: true });
    mkdirSync(pmDocsDir(this.opts.kanbanHome, boardId), { recursive: true });
    let memory: string | null = null;
    try {
      memory = readFileSync(join(dir, 'MEMORY.md'), 'utf-8').slice(0, MEMORY_INJECT_CAP);
    } catch {
      // no memory yet — first turn or never written
    }
    let projects: Project[] = [];
    try {
      projects = this.opts.getProjects(boardId);
    } catch {
      // registry unavailable must never block the chat turn
    }
    writeFileSync(join(dir, 'AGENTS.md'), buildPmAgentsMd({ projects, memory }));
    ```

- [ ] **Step 2: Wire in `src/main/index.ts`** — the `new PmChatService({...})` call gains:

```ts
getProjects: (boardId) => kanbanCommands!.listProjects(boardId),
```

- [ ] **Step 3: Verify:**

```bash
npm run typecheck
```

Expected: clean (same pre-existing state as before the change).

- [ ] **Step 4: Commit**

```bash
git add src/main/kanban/pm-chat-service.ts src/main/index.ts
git commit -m "feat(kanban): PM turns regenerate persona with projects and MEMORY.md"
```

---

### Task 7: MCP — PM project tools + `project` routing on create

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts`
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

- [ ] **Step 1: Failing tests** (append to the existing PM describe block, which already has `store`, `commands`, `server`, `base`, token `pmtok`; the commands instance is in scope as a local — hoist it to the describe scope if needed):

```ts
it('kanban_project_add / list / remove manage the board registry', async () => {
  const add = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_project_add',
    arguments: { name: 'fleet', path: TEST_DIR, description: 'the app' }
  });
  expect(add.result.content[0].text).toMatch(/registered/i);
  const list = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_project_list',
    arguments: {}
  });
  expect(list.result.content[0].text).toContain('fleet');
  expect(list.result.content[0].text).toContain('(default)');
  const rm = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_project_remove',
    arguments: { name: 'fleet' }
  });
  expect(rm.result.content[0].text).toMatch(/removed/i);
  expect(store.listProjects('default')).toHaveLength(0);
});

it('kanban_create routes to the default project when project is omitted', async () => {
  store.addProject({ boardId: 'default', name: 'fleet', path: TEST_DIR });
  const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_create',
    arguments: { title: 'routed' }
  });
  const t = store.getTask(r.result.content[0].text)!;
  expect(t.repoPath).toBe(TEST_DIR);
  expect(t.workspaceKind).toBe('worktree');
});

it('kanban_create with an explicit project name and rejects unknown names', async () => {
  store.addProject({ boardId: 'default', name: 'fleet', path: TEST_DIR });
  const bad = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_create',
    arguments: { title: 'x', project: 'ghost' }
  });
  expect(String(bad.error.message)).toMatch(/unknown project/i);
  expect(String(bad.error.message)).toContain('fleet');
  const ok = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_create',
    arguments: { title: 'x', project: 'fleet' }
  });
  expect(store.getTask(ok.result.content[0].text)!.repoPath).toBe(TEST_DIR);
});

it('kanban_create leaves zero-project boards scratch (no registry, no routing)', async () => {
  const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_create',
    arguments: { title: 'plain' }
  });
  expect(store.getTask(r.result.content[0].text)!.workspaceKind).toBe('scratch');
});

it('feature repo wins over the default project and conflicting project is rejected', async () => {
  store.addProject({ boardId: 'default', name: 'fleet', path: TEST_DIR });
  const f = store.createFeature({ boardId: 'default', name: 'F', repoPath: '/elsewhere' });
  const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_create',
    arguments: { title: 'member', feature_id: f.id }
  });
  expect(store.getTask(r.result.content[0].text)!.repoPath).toBe('/elsewhere');
  const bad = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_create',
    arguments: { title: 'member2', feature_id: f.id, project: 'fleet' }
  });
  expect(String(bad.error.message)).toMatch(/conflicts/i);
});

it('kanban_feature_create accepts a project name for its repo', async () => {
  store.addProject({ boardId: 'default', name: 'fleet', path: TEST_DIR });
  const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_feature_create',
    arguments: { name: 'F2', project: 'fleet' }
  });
  expect(store.getFeature(r.result.content[0].text)!.repoPath).toBe(TEST_DIR);
});
```

Note: `commands.addProject` validates the path exists, hence `TEST_DIR`. The store-level `addProject` in tests skips validation deliberately.

- [ ] **Step 2: Run — expect FAIL:**

```bash
npx vitest run src/main/__tests__/kanban-mcp-server.test.ts
```

- [ ] **Step 3: Implement in `kanban-mcp-server.ts`:**

Add three tools to `PM_TOOLS`:

```ts
{
  name: 'kanban_project_list',
  description: 'List this board registered project folders (name, path, description, default).',
  inputSchema: { type: 'object', properties: {} }
},
{
  name: 'kanban_project_add',
  description:
    'Register a project folder on this board. The first project becomes the default; ' +
    'tickets route to the default unless another project is named.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      path: { type: 'string' }, // absolute folder path
      description: { type: 'string' }
    },
    required: ['name', 'path']
  }
},
{
  name: 'kanban_project_remove',
  description: 'Remove a registered project by name. Existing tickets keep their repo path.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name']
  }
},
```

Extend the `kanban_create` tool schema `properties` with `project: { type: 'string' }` and append to its description: `' Pass project (a registered project name) to route the ticket to that repo; omitted, the board default project applies.'`. Extend `kanban_feature_create` schema with `project: { type: 'string' }`.

In `handlePmToolCall`, add cases (before `default:`):

```ts
case 'kanban_project_list': {
  const projects = this.store.listProjects(scope.boardId);
  const lines = projects.map((p) => {
    const desc = p.description ? ` — ${p.description}` : '';
    return `- ${p.name} → ${p.path}${desc}${p.isDefault ? ' (default)' : ''}`;
  });
  return this.text(res, rpcReq.id, lines.join('\n') || '(no projects registered)');
}
case 'kanban_project_add': {
  const a = z
    .object({ name: z.string(), path: z.string(), description: z.string().optional() })
    .parse(args);
  const p = commands.addProject({
    boardId: scope.boardId,
    name: a.name,
    path: a.path,
    description: a.description ?? null
  });
  return this.text(
    res,
    rpcReq.id,
    `Project "${p.name}" registered${p.isDefault ? ' as the default' : ''}.`
  );
}
case 'kanban_project_remove': {
  const a = z.object({ name: z.string() }).parse(args);
  const p = this.store.getProjectByName(scope.boardId, a.name);
  if (!p) return this.rpcError(res, rpcReq.id, `project not found on this board: ${a.name}`);
  commands.removeProject(p.id);
  return this.text(res, rpcReq.id, `Project "${a.name}" removed.`);
}
```

In the `kanban_create` case: add `project: z.string().optional()` to the zod object, then replace the workspace-resolution block (the `let workspace` + feature lookup) with:

```ts
// Workspace routing precedence: feature repo (keeps the group integrable) >
// explicit project > board default project > scratch.
let workspace: Partial<Pick<CreateTaskInput, 'workspaceKind' | 'repoPath' | 'baseBranch'>> = {
  workspaceKind: 'scratch'
};
let featureRepo: string | null = null;
if (a.feature_id) {
  const feature = this.store.getFeature(a.feature_id);
  if (!feature || feature.boardId !== scope.boardId) {
    return this.rpcError(res, rpcReq.id, `feature not found on this board: ${a.feature_id}`);
  }
  if (feature.repoPath) {
    featureRepo = feature.repoPath;
    workspace = {
      workspaceKind: 'worktree',
      repoPath: feature.repoPath,
      baseBranch: feature.baseBranch
    };
  }
}
const projects = this.store.listProjects(scope.boardId);
let proj = a.project !== undefined ? (projects.find((p) => p.name === a.project) ?? null) : null;
if (a.project !== undefined && !proj) {
  const names = projects.map((p) => p.name).join(', ') || '(none registered)';
  return this.rpcError(res, rpcReq.id, `unknown project "${a.project}". Registered: ${names}`);
}
if (proj && featureRepo && proj.path !== featureRepo) {
  return this.rpcError(
    res,
    rpcReq.id,
    `project "${proj.name}" conflicts with the feature repo (${featureRepo}); omit project or match it`
  );
}
if (!proj && !featureRepo) proj = projects.find((p) => p.isDefault) ?? null;
if (proj && !featureRepo) {
  workspace = { workspaceKind: 'worktree', repoPath: proj.path };
}
```

In the `kanban_feature_create` case: add `project: z.string().optional()` to the zod object and before `commands.createFeature`:

```ts
let repoPath = a.repo_path ?? null;
if (a.project !== undefined) {
  if (repoPath) return this.rpcError(res, rpcReq.id, 'pass either project or repo_path, not both');
  const p = this.store.getProjectByName(scope.boardId, a.project);
  if (!p) return this.rpcError(res, rpcReq.id, `unknown project: ${a.project}`);
  repoPath = p.path;
}
```

…and use `repoPath` in the `createFeature` call instead of `a.repo_path ?? null`.

- [ ] **Step 4: Run — expect PASS** (full mcp-server file).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-mcp-server.test.ts
git commit -m "feat(kanban): PM project tools and project-based ticket routing"
```

---

### Task 8: MCP — `docs` param on kanban_create / kanban_update

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts`
- Modify: `src/main/index.ts` (call `setKanbanHome`)
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

- [ ] **Step 1: Failing tests** (PM describe block; it needs a kanban home with a docs dir — create one in the test):

```ts
it('kanban_create accepts docs that exist in the board docs dir and rejects others', async () => {
  const home = join(TEST_DIR, 'home');
  mkdirSync(join(home, 'pm', 'default', 'docs'), { recursive: true });
  writeFileSync(join(home, 'pm', 'default', 'docs', 'prd.md'), '# PRD');
  server.setKanbanHome(home);

  const bad = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_create',
    arguments: { title: 'x', docs: ['missing.md'] }
  });
  expect(String(bad.error.message)).toMatch(/doc not found/i);

  const traversal = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_create',
    arguments: { title: 'x', docs: ['../AGENTS.md'] }
  });
  expect(String(traversal.error.message)).toMatch(/invalid doc name/i);

  const ok = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_create',
    arguments: { title: 'x', docs: ['prd.md'] }
  });
  expect(store.getTask(ok.result.content[0].text)!.docs).toEqual(['prd.md']);
});

it('kanban_update can set docs', async () => {
  const home = join(TEST_DIR, 'home2');
  mkdirSync(join(home, 'pm', 'default', 'docs'), { recursive: true });
  writeFileSync(join(home, 'pm', 'default', 'docs', 'spec.md'), '# spec');
  server.setKanbanHome(home);
  const t = store.createTask({ title: 'x' });
  await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_update',
    arguments: { task_id: t.id, docs: ['spec.md'] }
  });
  expect(store.getTask(t.id)!.docs).toEqual(['spec.md']);
});
```

(Add `writeFileSync`/`mkdirSync` to the test file's `fs` import if missing.)

- [ ] **Step 2: Run — expect FAIL** (`setKanbanHome` not a function).

- [ ] **Step 3: Implement in `kanban-mcp-server.ts`:**
  - Imports: `import { existsSync } from 'fs';` and `import { join } from 'path';` and `import { pmDocsDir } from './pm-paths';`
  - Field + setter on the class (next to `setCommands`):
    ```ts
    private kanbanHome: string | null = null;

    /** Inject the kanban home so PM doc references can be validated against pm/<board>/docs. */
    setKanbanHome(home: string): void {
      this.kanbanHome = home;
    }
    ```
  - Private helper:
    ```ts
    /** Returns an error message, or null when every doc name is safe and present. */
    private validateDocs(boardId: string, docs: string[]): string | null {
      if (!this.kanbanHome) return 'board docs are unavailable';
      for (const name of docs) {
        if (name.startsWith('/') || name.includes('..')) return `invalid doc name: ${name}`;
        if (!existsSync(join(pmDocsDir(this.kanbanHome, boardId), name))) {
          return `doc not found in the board docs folder: ${name}`;
        }
      }
      return null;
    }
    ```
  - `kanban_create` tool schema gains `docs: { type: 'array', items: { type: 'string' } }`; description gains `' Pass docs (filenames in your docs/ folder) to show those documents to the executing worker.'`. Same `docs` property on `kanban_update`'s schema.
  - `kanban_create` case: add `docs: z.array(z.string()).optional()` to zod; before `commands.create`:
    ```ts
    if (a.docs && a.docs.length > 0) {
      const docErr = this.validateDocs(scope.boardId, a.docs);
      if (docErr) return this.rpcError(res, rpcReq.id, docErr);
    }
    ```
    and pass `docs: a.docs ?? []` in the `commands.create({...})` input.
  - `kanban_update` case: add `docs: z.array(z.string()).optional()` to zod; same validation guard; pass `...(a.docs !== undefined ? { docs: a.docs } : {})` into `commands.update`.

- [ ] **Step 4: Wire `src/main/index.ts`** — next to `kanbanMcp.setCommands(kanbanCommands);` add:

```ts
kanbanMcp.setKanbanHome(KANBAN_HOME);
```

- [ ] **Step 5: Run — expect PASS.**

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/index.ts src/main/__tests__/kanban-mcp-server.test.ts
git commit -m "feat(kanban): docs references on tasks via PM tools"
```

---

### Task 9: Worker prompt — inline referenced docs

**Files:**
- Modify: `src/main/kanban/spawn-worker.ts`
- Modify: `src/main/index.ts` (spawn site, ~line 981)
- Test: `src/main/__tests__/kanban-spawn.test.ts` (create if absent; if a spawn-worker test file already exists, append there)

- [ ] **Step 1: Failing test** — `buildWorkerInvocation` returns the prompt in `args[1]`; it writes `.rune/mcp.json` so give it a tmp workspace:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildWorkerInvocation } from '../kanban/spawn-worker';

const TEST_DIR = join(tmpdir(), `fleet-spawn-docs-${Date.now()}`);

describe('worker prompt doc inlining', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  const base = {
    task: { id: 't1', title: 'T', body: 'B', assignee: null, modelOverride: null },
    workspace: TEST_DIR,
    mcpPort: 1234,
    runToken: 'tok',
    logPath: join(TEST_DIR, 'log'),
    mode: 'work' as const
  };

  it('appends referenced docs to the work prompt', () => {
    const inv = buildWorkerInvocation({
      ...base,
      docs: [{ filename: 'prd.md', content: '# PRD\ngoals', truncated: false }]
    });
    const prompt = inv.args[1];
    expect(prompt).toContain('## Reference doc: prd.md');
    expect(prompt).toContain('# PRD\ngoals');
  });

  it('marks truncated docs and omits the section when there are none', () => {
    const inv = buildWorkerInvocation({
      ...base,
      docs: [{ filename: 'big.md', content: 'x', truncated: true }]
    });
    expect(inv.args[1]).toContain('## Reference doc: big.md (truncated)');
    const none = buildWorkerInvocation(base);
    expect(none.args[1]).not.toContain('## Reference doc');
  });
});
```

- [ ] **Step 2: Run — expect FAIL:**

```bash
npx vitest run src/main/__tests__/kanban-spawn.test.ts
```

- [ ] **Step 3: Implement in `spawn-worker.ts`:**
  - Import: `import type { InlinedDoc } from './pm-paths';`
  - `BuildWorkerInput` gains:
    ```ts
    /** Board docs referenced by the task, pre-loaded for prompt inlining. */
    docs?: InlinedDoc[];
    ```
  - Next to `attachmentsSection`:
    ```ts
    function docsSection(input: BuildWorkerInput): string {
      const docs = input.docs ?? [];
      if (docs.length === 0) return '';
      return docs
        .map(
          (d) =>
            `\n\n## Reference doc: ${d.filename}${d.truncated ? ' (truncated)' : ''}\n\n${d.content}`
        )
        .join('');
    }
    ```
  - In `buildPrompt`, the `work` return becomes:
    ```ts
    return (
      `work kanban task ${task.id}: ${task.title}\n\n${task.body}` +
      attachmentsSection(input) +
      docsSection(input) +
      `\n\nIf you produce any durable output files (docs, research, data), register each with the ` +
      `kanban_artifact tool (path relative to your working directory) so the user can find them.`
    );
    ```

- [ ] **Step 4: Wire `src/main/index.ts`** — in the `spawnRuneWorker` input (after the `attachments:` entry):

```ts
docs: loadTaskDocs(pmDocsDir(KANBAN_HOME, task.boardId), task.docs),
```

with imports `import { loadTaskDocs, pmDocsDir } from './kanban/pm-paths';`. Note: the dispatcher's `task` here is the full `Task` (it has `boardId` and `docs`).

- [ ] **Step 5: Run tests + typecheck — expect PASS:**

```bash
npx vitest run src/main/__tests__/kanban-spawn.test.ts && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/main/kanban/spawn-worker.ts src/main/index.ts src/main/__tests__/kanban-spawn.test.ts
git commit -m "feat(kanban): inline referenced board docs into worker prompts"
```

---

### Task 10: MCP — PM artifact visibility (`kanban_show` + `kanban_artifact_read`)

**Files:**
- Modify: `src/main/kanban/kanban-mcp-server.ts`
- Test: `src/main/__tests__/kanban-mcp-server.test.ts`

- [ ] **Step 1: Failing tests** (PM describe block; `store.addArtifact` needs a real file in a workspace dir):

```ts
it('kanban_show lists kept artifacts and kanban_artifact_read returns text content', async () => {
  const t = store.createTask({ title: 'with art' });
  const ws = join(TEST_DIR, 'ws-art');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'report.md'), '# findings\nstuff');
  const art = store.addArtifact({
    taskId: t.id,
    runId: null,
    boardId: 'default',
    workspaceRoot: ws,
    relPath: 'report.md',
    kind: 'document'
  });

  const show = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_show',
    arguments: { task_id: t.id }
  });
  expect(show.result.content[0].text).toContain('## Artifacts');
  expect(show.result.content[0].text).toContain(art.id);

  const read = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_artifact_read',
    arguments: { artifact_id: art.id }
  });
  expect(read.result.content[0].text).toContain('# findings');
});

it('kanban_artifact_read rejects artifacts from other boards', async () => {
  const b = store.createBoard('Other');
  const t = store.createTask({ title: 'foreign', boardId: b.slug });
  const ws = join(TEST_DIR, 'ws-art2');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'x.md'), 'x');
  const art = store.addArtifact({
    taskId: t.id, runId: null, boardId: b.slug, workspaceRoot: ws, relPath: 'x.md'
  });
  const r = await rpc(`${base}?run=pmtok`, 'tools/call', {
    name: 'kanban_artifact_read',
    arguments: { artifact_id: art.id }
  });
  expect(String(r.error.message)).toMatch(/not found on this board/i);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement:**
  - Import `readArtifactPreview` from `./artifact-files`.
  - Add to `PM_TOOLS`:
    ```ts
    {
      name: 'kanban_artifact_read',
      description:
        'Read the text content of a task artifact on this board (ids come from kanban_show). ' +
        'Use it to review finished work and distill durable knowledge into MEMORY.md or docs/.',
      inputSchema: {
        type: 'object',
        properties: { artifact_id: { type: 'string' } },
        required: ['artifact_id']
      }
    },
    ```
  - In the PM `kanban_show` case, extend the `lines` array (after the prior-runs entries):
    ```ts
    const kept = detail.artifacts.filter((x) => x.state === 'kept');
    ```
    and append to `lines`:
    ```ts
    kept.length ? '## Artifacts' : '',
    ...kept.map(
      (x) => `- ${x.id}: ${x.filename}${x.title ? ` — ${x.title}` : ''} (${x.kind}, ${x.size} bytes)`
    )
    ```
    (destructure `artifacts` out of `detail` alongside `task, comments, runs` — `commands.show` already returns them).
  - New case:
    ```ts
    case 'kanban_artifact_read': {
      const a = z.object({ artifact_id: z.string() }).parse(args);
      const art = this.store.getArtifact(a.artifact_id);
      if (!art || art.boardId !== scope.boardId) {
        return this.rpcError(res, rpcReq.id, `artifact not found on this board: ${a.artifact_id}`);
      }
      const preview = readArtifactPreview(art.storedPath, 64 * 1024);
      if (!preview.previewable) {
        return this.rpcError(res, rpcReq.id, preview.reason ?? 'artifact is not readable as text');
      }
      const suffix = preview.truncated ? '\n\n…(truncated)' : '';
      return this.text(res, rpcReq.id, (preview.text ?? '') + suffix);
    }
    ```

- [ ] **Step 4: Run — expect PASS** (full mcp-server suite).

- [ ] **Step 5: Commit**

```bash
git add src/main/kanban/kanban-mcp-server.ts src/main/__tests__/kanban-mcp-server.test.ts
git commit -m "feat(kanban): PM artifact visibility — show listing and artifact_read tool"
```

---

### Task 11: IPC + preload for the Projects dialog

**Files:**
- Modify: `src/shared/ipc-channels.ts`, `src/shared/ipc-api.ts`, `src/main/kanban/kanban-ipc.ts`, `src/preload/index.ts` (+ its `FleetApi` type declaration — follow where `pmSend` etc. are declared)

No unit test (thin IPC glue over tested commands); verified by typecheck and Task 13's manual run.

- [ ] **Step 1: Channels** — in `ipc-channels.ts` after `KANBAN_PM_TRANSCRIPT`:

```ts
KANBAN_LIST_PROJECTS: 'kanban:list-projects',
KANBAN_ADD_PROJECT: 'kanban:add-project',
KANBAN_REMOVE_PROJECT: 'kanban:remove-project',
KANBAN_SET_DEFAULT_PROJECT: 'kanban:set-default-project',
```

- [ ] **Step 2: API types** — in `ipc-api.ts` (near the other Kanban request types):

```ts
export interface KanbanAddProjectRequest {
  boardId: string;
  name: string;
  path: string;
  description?: string | null;
}
```

- [ ] **Step 3: Handlers** — in `kanban-ipc.ts` (before the PM handlers):

```ts
// ---- Projects ----

ipcMain.handle(IPC_CHANNELS.KANBAN_LIST_PROJECTS, (_e, boardId: string) =>
  commands.listProjects(boardId)
);
ipcMain.handle(IPC_CHANNELS.KANBAN_ADD_PROJECT, (_e, req: KanbanAddProjectRequest) =>
  commands.addProject(req)
);
ipcMain.handle(IPC_CHANNELS.KANBAN_REMOVE_PROJECT, (_e, id: string) => {
  commands.removeProject(id);
});
ipcMain.handle(IPC_CHANNELS.KANBAN_SET_DEFAULT_PROJECT, (_e, id: string) => {
  commands.setDefaultProject(id);
});
```

(import `KanbanAddProjectRequest` in the type import block.)

- [ ] **Step 4: Preload** — in `preload/index.ts` kanban section (after `pruneMergedWorktrees`), plus matching entries in the preload API type definition file the other kanban methods are declared in (search for `pmSend` to find it):

```ts
listProjects: async (boardId: string): Promise<Project[]> =>
  typedInvoke<Project[]>(IPC_CHANNELS.KANBAN_LIST_PROJECTS, boardId),
addProject: async (req: KanbanAddProjectRequest): Promise<Project> =>
  typedInvoke<Project>(IPC_CHANNELS.KANBAN_ADD_PROJECT, req),
removeProject: async (id: string): Promise<void> =>
  typedInvoke<void>(IPC_CHANNELS.KANBAN_REMOVE_PROJECT, id),
setDefaultProject: async (id: string): Promise<void> =>
  typedInvoke<void>(IPC_CHANNELS.KANBAN_SET_DEFAULT_PROJECT, id),
```

(import `Project` and `KanbanAddProjectRequest` where the other kanban types are imported.)

- [ ] **Step 5: Verify + commit**

```bash
npm run typecheck
git add src/shared/ipc-channels.ts src/shared/ipc-api.ts src/main/kanban/kanban-ipc.ts src/preload/index.ts
git commit -m "feat(kanban): project registry IPC endpoints"
```

(Also stage the preload type declaration file if it's separate.)

---

### Task 12: Projects dialog UI

**Files:**
- Create: `src/renderer/src/components/kanban/ProjectsModal.tsx`
- Modify: `src/renderer/src/components/kanban/KanbanBoard.tsx`

- [ ] **Step 1: Modal component.** Match the board's tailwind idiom (neutral-950/800 surfaces, `text-xs`, `rounded`). Look at `SwarmModal.tsx`'s outer overlay markup first and reuse its overlay/container classes if they differ from below:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { FolderGit2, Plus, Star, Trash2, X } from 'lucide-react';
import type { Project } from '@shared/kanban-types';
import { useWorkspaceStore } from '../../store/workspace-store';

interface ProjectsModalProps {
  boardSlug: string;
  onClose: () => void;
}

/** Manage the board's registered project folders (PM code context + ticket routing). */
export function ProjectsModal({ boardSlug, onClose }: ProjectsModalProps): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const addRecentFolder = useWorkspaceStore((s) => s.addRecentFolder);

  const refresh = useCallback(async () => {
    setProjects(await window.fleet.kanban.listProjects(boardSlug));
  }, [boardSlug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleAdd(): Promise<void> {
    setError(null);
    const path = await window.fleet.showFolderPicker();
    if (!path) return;
    const name = path.split('/').filter(Boolean).pop() ?? path;
    try {
      await window.fleet.kanban.addProject({ boardId: boardSlug, name, path });
      addRecentFolder(path);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add project');
    }
  }

  async function handleRemove(id: string): Promise<void> {
    setError(null);
    try {
      await window.fleet.kanban.removeProject(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove project');
    }
  }

  async function handleSetDefault(id: string): Promise<void> {
    setError(null);
    await window.fleet.kanban.setDefaultProject(id);
    await refresh();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[480px] max-w-[90vw] rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-neutral-200">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <FolderGit2 size={14} /> Board Projects
          </div>
          <button onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-neutral-800">
            <X size={14} />
          </button>
        </div>
        <p className="mb-3 text-xs text-neutral-500">
          Folders the board PM can read for code context. New tickets route to the default
          project unless another is named.
        </p>
        <div className="mb-3 flex flex-col gap-1">
          {projects.length === 0 && (
            <div className="rounded border border-dashed border-neutral-800 px-3 py-4 text-center text-xs text-neutral-500">
              No projects registered yet.
            </div>
          )}
          {projects.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="font-medium">{p.name}</span>
                  {p.isDefault && (
                    <span className="rounded bg-emerald-900/60 px-1 text-[10px] text-emerald-300">
                      default
                    </span>
                  )}
                </div>
                <div className="truncate text-[10px] text-neutral-500" title={p.path}>
                  {p.path}
                </div>
              </div>
              {!p.isDefault && (
                <button
                  onClick={() => void handleSetDefault(p.id)}
                  title="Make default"
                  className="rounded p-1 text-neutral-400 transition hover:bg-neutral-800"
                >
                  <Star size={12} />
                </button>
              )}
              <button
                onClick={() => void handleRemove(p.id)}
                title="Remove project"
                className="rounded p-1 text-neutral-400 transition hover:bg-neutral-800 hover:text-red-400"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
        {error && <div className="mb-2 text-xs text-red-400">{error}</div>}
        <button
          onClick={() => void handleAdd()}
          className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs text-white transition active:scale-[0.97] hover:bg-blue-500"
        >
          <Plus size={12} /> Add Folder…
        </button>
      </div>
    </div>
  );
}
```

(If the repo aliases `@shared` differently in the renderer, match how `KanbanBoard.tsx` imports shared kanban types.)

- [ ] **Step 2: Toolbar button** in `KanbanBoard.tsx`:
  - State: `const [projectsOpen, setProjectsOpen] = useState(false);`
  - Import `{ FolderGit2 }` from `lucide-react` (extend the existing import) and `{ ProjectsModal }` from `./ProjectsModal`.
  - Insert a button before the PM button (the `togglePm` one, ~line 362):
    ```tsx
    <button
      onClick={() => setProjectsOpen(true)}
      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-400 transition active:scale-[0.97] hover:bg-neutral-800"
      title="Manage the board's project folders (PM code context + ticket routing)"
    >
      <FolderGit2 size={12} /> Projects
    </button>
    ```
  - Render the modal near the other modals at the bottom of the component:
    ```tsx
    {projectsOpen && (
      <ProjectsModal boardSlug={activeBoardSlug} onClose={() => setProjectsOpen(false)} />
    )}
    ```

- [ ] **Step 3: Verify + commit**

```bash
npm run typecheck && npm run lint
git add src/renderer/src/components/kanban/ProjectsModal.tsx src/renderer/src/components/kanban/KanbanBoard.tsx
git commit -m "feat(kanban): Projects dialog for the board folder registry"
```

(Lint is pre-existing-red in places — only ensure no NEW errors in touched files.)

---

### Task 13: Full verification

- [ ] **Step 1: Full test suite + typecheck + build**

```bash
npx vitest run && npm run typecheck && npm run build
```

Expected: all pass (vitest does not typecheck — run both).

- [ ] **Step 2: Manual smoke** (launch dev app):
  1. Kanban tab → Projects → Add Folder → pick `~/Development/fleet`. Row appears with `default` badge.
  2. Open PM chat, ask: *"Look at the fleet project and tell me what the copilot mascot system is."* — PM should read real code and answer concretely (proves Task 0's finding holds end-to-end).
  3. Ask the PM to create a ticket; confirm the new card's drawer shows the repo path (routed via default project).
  4. Ask the PM: *"Write a short PRD for X in your docs folder and create a ticket referencing it."* — confirm `~/.fleet/kanban/pm/<board>/docs/` has the file and the ticket's `docs` is set (check via drawer or `kanban_show`).
  5. Ask the PM to remember a decision; confirm `MEMORY.md` exists and a follow-up turn (after Reset) still knows it.

- [ ] **Step 3: Commit any fixes; report results** (including any deviation from spec) to the user.

---

## Self-review notes (already applied)

- Spec coverage: registry (T1–3), PM tools + routing (T7), prompt injection (T5–6), UI (T12), knowledge dir + memory (T5–6), docs field + worker inlining (T8–9), artifact flowback (T10), pre-flight (T0), IPC (T11), verification (T13). Deferred items in the spec are deliberately absent.
- Routing precedence (feature > explicit project > default > scratch) is specified in code in T7 and matches the spec's feature-inheritance behavior.
- `docs` naming is consistent: `Task.docs` / `CreateTaskInput.docs` / `UpdateTaskFields.docs` (T1), tool param `docs` (T8), `InlinedDoc`/`loadTaskDocs` (T4), `BuildWorkerInput.docs` (T9).
