# Automation Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Automation tab to Fleet that lets users create agent-powered automations (trigger + prompt), execute them via Vercel AI SDK, and browse output files.

**Architecture:** JSON files on disk (`~/.fleet/automations/`) as the persistence layer. Main process handles execution (Vercel AI SDK `generateText()` with tools), cron scheduling (`node-cron`), and file I/O. Renderer has a Zustand store for UI state, a sidebar section for the automation list, and a tab editor with logs/outputs panels. IPC bridges the two via typed channels.

**Tech Stack:** Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`), `node-cron`, Zustand, Zod, React, Tailwind, Radix UI, Lucide icons.

**Spec:** `docs/superpowers/specs/2026-03-25-automation-tab-design.md`

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `src/shared/automation-types.ts` | Zod schemas and TS types for automation config, run manifest, log events |
| `src/main/automation-store.ts` | CRUD for automation JSON files on disk, file watcher, run directory management |
| `src/main/automation-tools.ts` | Tool implementations for the agent (shell, read_file, write_file, fleet) |
| `src/main/automation-engine.ts` | Execution engine: Vercel AI SDK calls, cron scheduling, abort/cancellation, log streaming |
| `src/renderer/src/store/automation-store.ts` | Zustand store for automation list, run state, UI selection |
| `src/renderer/src/components/AutomationSidebar.tsx` | Sidebar section: collapsible list, status indicators, context menu, + button |
| `src/renderer/src/components/AutomationTab.tsx` | Tab editor: header, trigger config, agent config, tools checklist |
| `src/renderer/src/components/AutomationLogs.tsx` | Collapsible log panel with streaming log events |
| `src/renderer/src/components/AutomationOutputs.tsx` | Collapsible outputs panel: run groups, file list, actions |
| `src/main/__tests__/automation-store.test.ts` | Tests for automation file CRUD |
| `src/main/__tests__/automation-tools.test.ts` | Tests for tool implementations |
### Modified Files

| File | Change |
|------|--------|
| `package.json` | Add `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `node-cron`, `@types/node-cron` |
| `src/shared/types.ts` | Extend `Tab.type` and `PaneLeaf.paneType` unions, add `aiProviders` to `FleetSettings` |
| `src/shared/ipc-channels.ts` | Add `AUTOMATION_*` channel constants |
| `src/shared/ipc-api.ts` | Add automation request/response types |
| `src/main/ipc-handlers.ts` | Register automation IPC handlers |
| `src/preload/index.ts` | Add `automation` namespace to `fleetApi` |
| `src/renderer/src/components/Sidebar.tsx` | Insert `<AutomationSidebar />` between Star Command and tab list |
| `src/renderer/src/App.tsx` | Route `automation` tab type to `<AutomationTab />`, convert tab rendering ternary to if/else chain |
| `src/renderer/src/components/PaneGrid.tsx` | Add `automation` case to `PaneNodeRenderer` so it doesn't fall through to `<TerminalPane>` |
| `src/renderer/src/components/SettingsModal.tsx` | Add "AI Providers" settings tab |
| `src/main/index.ts` | Initialize automation engine on app startup, register cron jobs, handle crash recovery |
| `src/shared/constants.ts` | Add `DEFAULT_SETTINGS.aiProviders` default |

---

## Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install Vercel AI SDK packages**

```bash
npm install ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/google
```

- [ ] **Step 2: Install cron scheduler**

```bash
npm install node-cron
npm install -D @types/node-cron
```

- [ ] **Step 3: Verify install succeeded**

```bash
npm run typecheck
```

Expected: PASS (no type errors from new deps)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add vercel ai sdk and node-cron dependencies"
```

---

## Task 2: Shared Types and IPC Channels

**Files:**
- Create: `src/shared/automation-types.ts`
- Modify: `src/shared/types.ts:14` (Tab.type), `src/shared/types.ts:34` (PaneLeaf.paneType), `src/shared/types.ts:95-120` (FleetSettings)
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/shared/ipc-api.ts`
- Modify: `src/shared/constants.ts:16-62` (DEFAULT_SETTINGS)

- [ ] **Step 1: Create automation type definitions with Zod schemas**

Create `src/shared/automation-types.ts`:

```ts
import { z } from 'zod'

// --- Schedule presets ---
export const SCHEDULE_PRESETS = {
  'every-5m': { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  'every-15m': { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  'every-hour': { label: 'Every hour', cron: '0 * * * *' },
  'every-6h': { label: 'Every 6 hours', cron: '0 */6 * * *' },
  'daily-9am': { label: 'Daily at 9am', cron: '0 9 * * *' },
  'daily-midnight': { label: 'Daily at midnight', cron: '0 0 * * *' },
  'weekdays-9am': { label: 'Weekdays at 9am', cron: '0 9 * * MON-FRI' },
  'weekly-mon-9am': { label: 'Weekly Monday 9am', cron: '0 9 * * MON' },
  'monthly-1st-9am': { label: 'Monthly 1st at 9am', cron: '0 9 1 * *' },
  'monthly-1st-midnight': { label: 'First of month midnight', cron: '0 0 1 * *' },
} as const

export type SchedulePresetKey = keyof typeof SCHEDULE_PRESETS

// --- Schemas ---
export const TriggerSchema = z.object({
  manual: z.boolean().default(true),
  schedule: z.object({
    cron: z.string(),
    preset: z.string().optional(),
  }).optional(),
})

export const AUTOMATION_TOOLS = ['shell', 'read_file', 'write_file', 'fleet'] as const
export type AutomationTool = typeof AUTOMATION_TOOLS[number]

export const AgentConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  systemPrompt: z.string().optional().default(''),
  prompt: z.string().min(1),
  maxTokens: z.number().min(256).max(32768).default(8192),
  maxSteps: z.number().min(1).max(100).default(25),
  tools: z.array(z.enum(AUTOMATION_TOOLS)).min(1),
  shellTimeout: z.number().optional().default(60),
})

export const AutomationConfigSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
  trigger: TriggerSchema,
  agent: AgentConfigSchema,
})

export type AutomationConfig = z.infer<typeof AutomationConfigSchema>
export type TriggerConfig = z.infer<typeof TriggerSchema>
export type AgentConfig = z.infer<typeof AgentConfigSchema>

// --- Run manifest ---
export const RunManifestSchema = z.object({
  automationId: z.string(),
  runId: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  status: z.enum(['running', 'success', 'error', 'cancelled']),
  stepCount: z.number().default(0),
  error: z.string().nullable().default(null),
})

export type RunManifest = z.infer<typeof RunManifestSchema>

// --- Log events ---
export interface LogEvent {
  automationId: string
  runId: string
  type: 'text' | 'tool-call' | 'tool-result' | 'error' | 'status'
  timestamp: string
  content: string
  toolName?: string
}

// --- Meta for sidebar ---
export interface AutomationMeta {
  id: string
  name: string
  description: string
  status: 'idle' | 'running' | 'error' | 'cancelled'
  hasSchedule: boolean
}

// --- Run output info ---
export interface RunOutput {
  runId: string
  startedAt: string
  status: 'running' | 'success' | 'error' | 'cancelled'
  files: RunOutputFile[]
}

export interface RunOutputFile {
  name: string
  path: string
  sizeBytes: number
}
```

- [ ] **Step 2: Extend Tab.type and PaneLeaf.paneType in types.ts**

In `src/shared/types.ts`, add `'automation'` to the `Tab.type` union (line 14) and `PaneLeaf.paneType` union (line 34).

Tab.type: `'terminal' | 'star-command' | 'crew' | 'file' | 'image' | 'automation'`
PaneLeaf.paneType: `'terminal' | 'file' | 'image' | 'automation'`

- [ ] **Step 3: Add aiProviders to FleetSettings**

In `src/shared/types.ts`, add to the `FleetSettings` type:

```ts
aiProviders: Record<string, { apiKey: string; baseUrl?: string }>
```

In `src/shared/constants.ts`, add to `DEFAULT_SETTINGS`:

```ts
aiProviders: {},
```

- [ ] **Step 4: Add IPC channels**

In `src/shared/ipc-channels.ts`, add:

```ts
// Automation
AUTOMATION_LIST: 'automation:list',
AUTOMATION_READ: 'automation:read',
AUTOMATION_WRITE: 'automation:write',
AUTOMATION_DELETE: 'automation:delete',
AUTOMATION_RUN: 'automation:run',
AUTOMATION_STOP: 'automation:stop',
AUTOMATION_LOG: 'automation:log',
AUTOMATION_OUTPUTS: 'automation:outputs',
```

- [ ] **Step 5: Add IPC API types**

In `src/shared/ipc-api.ts`, add:

```ts
import type { AutomationConfig, AutomationMeta, LogEvent, RunOutput } from './automation-types'

export interface AutomationWriteRequest {
  config: AutomationConfig
}

export interface AutomationReadRequest {
  id: string
}

export interface AutomationDeleteRequest {
  id: string
}

export interface AutomationRunRequest {
  id: string
}

export interface AutomationRunResponse {
  runId: string
}

export interface AutomationStopRequest {
  id: string
}

export interface AutomationOutputsRequest {
  id: string
}

export interface AutomationOutputsResponse {
  runs: RunOutput[]
}

export interface AutomationListResponse {
  automations: AutomationMeta[]
}
```

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/automation-types.ts src/shared/types.ts src/shared/ipc-channels.ts src/shared/ipc-api.ts src/shared/constants.ts
git commit -m "feat(automation): add shared types, schemas, and IPC channels"
```

---

## Task 3: Automation File Store (Main Process)

**Files:**
- Create: `src/main/automation-store.ts`
- Create: `src/main/__tests__/automation-store.test.ts`

- [ ] **Step 1: Write tests for automation file store**

Create `src/main/__tests__/automation-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AutomationFileStore } from '../automation-store'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

describe('AutomationFileStore', () => {
  let store: AutomationFileStore
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'fleet-automation-test-'))
    store = new AutomationFileStore(testDir)
    await store.init()
  })

  afterEach(async () => {
    store.dispose()
    await rm(testDir, { recursive: true, force: true })
  })

  it('lists empty automations on fresh directory', async () => {
    const result = await store.list()
    expect(result).toEqual([])
  })

  it('writes and reads an automation', async () => {
    const config = makeConfig('test-1', 'My Automation')
    await store.write(config)
    const read = await store.read('test-1')
    expect(read).toEqual(config)
  })

  it('lists automations after write', async () => {
    await store.write(makeConfig('a1', 'First'))
    await store.write(makeConfig('a2', 'Second'))
    const list = await store.list()
    expect(list).toHaveLength(2)
    expect(list.map(m => m.name).sort()).toEqual(['First', 'Second'])
  })

  it('deletes an automation and its output directory', async () => {
    await store.write(makeConfig('del-1', 'Delete Me'))
    await store.delete('del-1')
    const read = await store.read('del-1')
    expect(read).toBeNull()
    const list = await store.list()
    expect(list).toHaveLength(0)
  })

  it('creates run directory with manifest', async () => {
    await store.write(makeConfig('run-1', 'Runner'))
    const runDir = await store.createRunDir('run-1')
    expect(runDir.runId).toBeTruthy()
    expect(runDir.outputDir).toContain('run-1')
  })

  it('lists run outputs', async () => {
    await store.write(makeConfig('out-1', 'Output Test'))
    const { runId, outputDir } = await store.createRunDir('out-1')
    // Write a fake output file
    const { writeFile } = await import('fs/promises')
    await writeFile(join(outputDir, 'report.csv'), 'a,b,c\n1,2,3')
    await store.updateRunManifest(outputDir, { status: 'success', completedAt: new Date().toISOString(), stepCount: 5 })
    const outputs = await store.listOutputs('out-1')
    expect(outputs).toHaveLength(1)
    expect(outputs[0].runId).toBe(runId)
    expect(outputs[0].files).toHaveLength(1)
    expect(outputs[0].files[0].name).toBe('report.csv')
  })

  it('recovers crashed runs on init', async () => {
    await store.write(makeConfig('crash-1', 'Crasher'))
    const { outputDir } = await store.createRunDir('crash-1')
    // Manifest says "running" — simulates crash
    store.dispose()
    // Re-init should mark it as error
    const store2 = new AutomationFileStore(testDir)
    await store2.init()
    const outputs = await store2.listOutputs('crash-1')
    expect(outputs[0].status).toBe('error')
    store2.dispose()
  })
})

function makeConfig(id: string, name: string) {
  return {
    id,
    name,
    description: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    trigger: { manual: true },
    agent: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      systemPrompt: '',
      prompt: 'Do something',
      maxTokens: 8192,
      maxSteps: 25,
      tools: ['shell'] as const,
      shellTimeout: 60,
    },
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/main/__tests__/automation-store.test.ts
```

Expected: FAIL (module not found)

- [ ] **Step 3: Implement AutomationFileStore**

Create `src/main/automation-store.ts`:

```ts
import { readdir, readFile, writeFile, mkdir, rm, stat } from 'fs/promises'
import { join } from 'path'
import { watch, type FSWatcher } from 'chokidar'
import { AutomationConfigSchema, RunManifestSchema, type AutomationConfig, type AutomationMeta, type RunOutput, type RunOutputFile, type RunManifest } from '../shared/automation-types'

export class AutomationFileStore {
  private watcher: FSWatcher | null = null
  private onChange: (() => void) | null = null

  constructor(private baseDir: string) {}

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    await this.recoverCrashedRuns()
    this.watcher = watch(this.baseDir, { depth: 0, ignoreInitial: true })
    this.watcher.on('all', () => this.onChange?.())
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = null
  }

  onChanged(cb: () => void): void {
    this.onChange = cb
  }

  async list(): Promise<AutomationMeta[]> {
    const entries = await readdir(this.baseDir)
    const metas: AutomationMeta[] = []

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const raw = await readFile(join(this.baseDir, entry), 'utf-8')
        const config = AutomationConfigSchema.parse(JSON.parse(raw))
        metas.push({
          id: config.id,
          name: config.name,
          description: config.description ?? '',
          status: 'idle',
          hasSchedule: !!config.trigger.schedule,
        })
      } catch {
        // Skip malformed files
      }
    }

    return metas
  }

  async read(id: string): Promise<AutomationConfig | null> {
    try {
      const raw = await readFile(join(this.baseDir, `${id}.json`), 'utf-8')
      return AutomationConfigSchema.parse(JSON.parse(raw))
    } catch {
      return null
    }
  }

  async write(config: AutomationConfig): Promise<void> {
    const validated = AutomationConfigSchema.parse(config)
    validated.updatedAt = new Date().toISOString()
    await writeFile(
      join(this.baseDir, `${validated.id}.json`),
      JSON.stringify(validated, null, 2),
      'utf-8'
    )
  }

  async delete(id: string): Promise<void> {
    const configPath = join(this.baseDir, `${id}.json`)
    const outputDir = join(this.baseDir, id)
    await rm(configPath, { force: true })
    await rm(outputDir, { recursive: true, force: true })
  }

  async createRunDir(automationId: string): Promise<{ runId: string; outputDir: string }> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const suffix = Math.random().toString(36).slice(2, 6)
    const runId = `${timestamp}-${suffix}`
    const outputDir = join(this.baseDir, automationId, runId)
    await mkdir(outputDir, { recursive: true })

    const manifest: RunManifest = {
      automationId,
      runId,
      startedAt: new Date().toISOString(),
      status: 'running',
      stepCount: 0,
      error: null,
    }
    await writeFile(join(outputDir, 'run.json'), JSON.stringify(manifest, null, 2), 'utf-8')
    return { runId, outputDir }
  }

  async updateRunManifest(outputDir: string, updates: Partial<RunManifest>): Promise<void> {
    const manifestPath = join(outputDir, 'run.json')
    const raw = await readFile(manifestPath, 'utf-8')
    const manifest = JSON.parse(raw) as RunManifest
    Object.assign(manifest, updates)
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  }

  async listOutputs(automationId: string): Promise<RunOutput[]> {
    const outputBaseDir = join(this.baseDir, automationId)
    let entries: string[]
    try {
      entries = await readdir(outputBaseDir)
    } catch {
      return []
    }

    const runs: RunOutput[] = []
    for (const entry of entries.sort().reverse()) {
      const runDir = join(outputBaseDir, entry)
      const manifestPath = join(runDir, 'run.json')
      try {
        const raw = await readFile(manifestPath, 'utf-8')
        const manifest = RunManifestSchema.parse(JSON.parse(raw))
        const allFiles = await readdir(runDir)
        const files: RunOutputFile[] = []
        for (const f of allFiles) {
          if (f === 'run.json') continue
          const fileStat = await stat(join(runDir, f))
          files.push({ name: f, path: join(runDir, f), sizeBytes: fileStat.size })
        }
        runs.push({
          runId: manifest.runId,
          startedAt: manifest.startedAt,
          status: manifest.status,
          files,
        })
      } catch {
        // Skip malformed run dirs
      }
    }
    return runs
  }

  private async recoverCrashedRuns(): Promise<void> {
    const entries = await readdir(this.baseDir).catch(() => [] as string[])
    for (const entry of entries) {
      if (entry.endsWith('.json')) continue
      const automationDir = join(this.baseDir, entry)
      let runDirs: string[]
      try {
        const s = await stat(automationDir)
        if (!s.isDirectory()) continue
        runDirs = await readdir(automationDir)
      } catch {
        continue
      }
      for (const runDir of runDirs) {
        const manifestPath = join(automationDir, runDir, 'run.json')
        try {
          const raw = await readFile(manifestPath, 'utf-8')
          const manifest = JSON.parse(raw) as RunManifest
          if (manifest.status === 'running') {
            manifest.status = 'error'
            manifest.error = 'Fleet crashed during execution'
            manifest.completedAt = new Date().toISOString()
            await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
          }
        } catch {
          // Skip
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/main/__tests__/automation-store.test.ts
```

Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/automation-store.ts src/main/__tests__/automation-store.test.ts
git commit -m "feat(automation): add file store with CRUD, run dirs, and crash recovery"
```

---

## Task 4: Automation Tools

**Files:**
- Create: `src/main/automation-tools.ts`
- Create: `src/main/__tests__/automation-tools.test.ts`

- [ ] **Step 1: Write tests for automation tools**

Create `src/main/__tests__/automation-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createShellTool, createReadFileTool, createWriteFileTool } from '../automation-tools'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

describe('shell tool', () => {
  it('executes a command and returns stdout', async () => {
    const tool = createShellTool({ timeoutSeconds: 10 })
    const result = await tool.execute({ args: { command: 'echo hello' } })
    expect(result).toContain('hello')
  })

  it('returns stderr on non-zero exit', async () => {
    const tool = createShellTool({ timeoutSeconds: 10 })
    const result = await tool.execute({ args: { command: 'ls /nonexistent-path-xyz' } })
    expect(result).toContain('No such file or directory')
  })

  it('times out on long-running commands', async () => {
    const tool = createShellTool({ timeoutSeconds: 1 })
    const result = await tool.execute({ args: { command: 'sleep 30' } })
    expect(result).toContain('timed out')
  })
})

describe('read_file tool', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'fleet-tools-test-'))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('reads a text file', async () => {
    const filePath = join(testDir, 'test.txt')
    await writeFile(filePath, 'hello world')
    const tool = createReadFileTool()
    const result = await tool.execute({ args: { path: filePath } })
    expect(result).toBe('hello world')
  })

  it('returns error for non-existent file', async () => {
    const tool = createReadFileTool()
    const result = await tool.execute({ args: { path: '/nonexistent/file.txt' } })
    expect(result).toContain('Error')
  })
})

describe('write_file tool', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'fleet-tools-test-'))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('writes a file with relative path', async () => {
    const tool = createWriteFileTool(testDir)
    const result = await tool.execute({ args: { path: 'output.txt', content: 'hello' } })
    expect(result).toContain('Written')
    const content = await readFile(join(testDir, 'output.txt'), 'utf-8')
    expect(content).toBe('hello')
  })

  it('writes a file with absolute path', async () => {
    const absPath = join(testDir, 'abs-output.txt')
    const tool = createWriteFileTool(testDir)
    const result = await tool.execute({ args: { path: absPath, content: 'absolute' } })
    expect(result).toContain('Written')
    const content = await readFile(absPath, 'utf-8')
    expect(content).toBe('absolute')
  })

  it('creates parent directories', async () => {
    const tool = createWriteFileTool(testDir)
    await tool.execute({ args: { path: 'sub/dir/file.txt', content: 'nested' } })
    const content = await readFile(join(testDir, 'sub/dir/file.txt'), 'utf-8')
    expect(content).toBe('nested')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/main/__tests__/automation-tools.test.ts
```

Expected: FAIL (module not found)

- [ ] **Step 3: Implement automation tools**

Create `src/main/automation-tools.ts`:

```ts
import { z } from 'zod'
import { tool } from 'ai'
import { exec } from 'child_process'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, isAbsolute, dirname } from 'path'
import type { FleetCommandHandler } from './socket-command-handler'

interface ShellToolOptions {
  timeoutSeconds: number
  abortSignal?: AbortSignal
}

export function createShellTool(opts: ShellToolOptions) {
  return tool({
    description: 'Execute a shell command and return stdout/stderr',
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
    }),
    execute: async ({ command }) => {
      return new Promise<string>((resolve) => {
        const child = exec(command, {
          timeout: opts.timeoutSeconds * 1000,
          maxBuffer: 10 * 1024 * 1024, // 10MB
        }, (error, stdout, stderr) => {
          if (error) {
            if (error.killed) {
              resolve(`Command timed out after ${opts.timeoutSeconds}s: ${command}`)
            } else {
              resolve(`Exit code ${error.code ?? 1}:\nstdout: ${stdout}\nstderr: ${stderr}`)
            }
          } else {
            resolve(stdout || stderr || '(no output)')
          }
        })

        opts.abortSignal?.addEventListener('abort', () => {
          child.kill('SIGTERM')
        })
      })
    },
  })
}

export function createReadFileTool() {
  return tool({
    description: 'Read a file from the filesystem',
    parameters: z.object({
      path: z.string().describe('Absolute path to the file'),
    }),
    execute: async ({ path }) => {
      try {
        return await readFile(path, 'utf-8')
      } catch (e) {
        return `Error reading ${path}: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  })
}

export function createWriteFileTool(outputDir: string) {
  return tool({
    description: 'Write content to a file. Relative paths resolve to the output directory.',
    parameters: z.object({
      path: z.string().describe('File path (relative to output dir, or absolute)'),
      content: z.string().describe('Content to write'),
    }),
    execute: async ({ path, content }) => {
      try {
        const resolvedPath = isAbsolute(path) ? path : join(outputDir, path)
        await mkdir(dirname(resolvedPath), { recursive: true })
        await writeFile(resolvedPath, content, 'utf-8')
        return `Written ${content.length} bytes to ${resolvedPath}`
      } catch (e) {
        return `Error writing ${path}: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  })
}

export function createFleetTool(commandHandler: FleetCommandHandler) {
  return tool({
    description: 'Execute a Fleet CLI command to control terminals, panes, and workspaces',
    parameters: z.object({
      command: z.string().describe('Fleet command name (e.g., new-tab, list-panes, send-input)'),
      args: z.record(z.unknown()).optional().describe('Command arguments as key-value pairs'),
    }),
    execute: async ({ command, args }) => {
      try {
        const socketCmd = { type: command, ...(args ?? {}) }
        const response = await commandHandler.handleCommand(socketCmd)
        return JSON.stringify(response)
      } catch (e) {
        return `Error executing fleet command '${command}': ${e instanceof Error ? e.message : String(e)}`
      }
    },
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/main/__tests__/automation-tools.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/automation-tools.ts src/main/__tests__/automation-tools.test.ts
git commit -m "feat(automation): add agent tool implementations (shell, read_file, write_file, fleet)"
```

---

## Task 5: Automation Engine

**Files:**
- Create: `src/main/automation-engine.ts`

- [ ] **Step 1: Implement the automation engine**

Create `src/main/automation-engine.ts`:

```ts
import { generateText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import cron from 'node-cron'
import type { BrowserWindow } from 'electron'
import type { FleetCommandHandler } from './socket-command-handler'
import { AutomationFileStore } from './automation-store'
import { createShellTool, createReadFileTool, createWriteFileTool, createFleetTool } from './automation-tools'
import type { AutomationConfig, LogEvent } from '../shared/automation-types'
import { IPC_CHANNELS } from '../shared/ipc-channels'

interface EngineOptions {
  automationStore: AutomationFileStore
  commandHandler: FleetCommandHandler
  getWindow: () => BrowserWindow | null
  getApiKey: (provider: string) => string | undefined
}

interface ActiveRun {
  automationId: string
  runId: string
  outputDir: string
  abortController: AbortController
}

export class AutomationEngine {
  private cronJobs = new Map<string, cron.ScheduledTask>()
  private activeRuns = new Map<string, ActiveRun>()
  private store: AutomationFileStore
  private commandHandler: FleetCommandHandler
  private getWindow: () => BrowserWindow | null
  private getApiKey: (provider: string) => string | undefined

  constructor(opts: EngineOptions) {
    this.store = opts.automationStore
    this.commandHandler = opts.commandHandler
    this.getWindow = opts.getWindow
    this.getApiKey = opts.getApiKey
  }

  async init(): Promise<void> {
    const automations = await this.store.list()
    for (const meta of automations) {
      const config = await this.store.read(meta.id)
      if (config?.trigger.schedule) {
        this.registerCron(config)
      }
    }
  }

  dispose(): void {
    for (const [, job] of this.cronJobs) {
      job.stop()
    }
    this.cronJobs.clear()
    for (const [, run] of this.activeRuns) {
      run.abortController.abort()
    }
    this.activeRuns.clear()
  }

  isRunning(automationId: string): boolean {
    return this.activeRuns.has(automationId)
  }

  async run(automationId: string): Promise<string> {
    if (this.activeRuns.has(automationId)) {
      throw new Error(`Automation ${automationId} is already running`)
    }

    const config = await this.store.read(automationId)
    if (!config) throw new Error(`Automation ${automationId} not found`)

    const apiKey = this.getApiKey(config.agent.provider)
    if (!apiKey) throw new Error(`No API key configured for provider: ${config.agent.provider}`)

    const { runId, outputDir } = await this.store.createRunDir(automationId)
    const abortController = new AbortController()

    this.activeRuns.set(automationId, { automationId, runId, outputDir, abortController })
    this.sendLog({ automationId, runId, type: 'status', timestamp: now(), content: 'Automation started' })

    // Run in background — don't await
    this.executeRun(config, runId, outputDir, abortController).catch((err) => {
      console.error(`Automation ${automationId} failed:`, err)
    })

    return runId
  }

  async stop(automationId: string): Promise<void> {
    const run = this.activeRuns.get(automationId)
    if (!run) return
    run.abortController.abort()
    await this.store.updateRunManifest(run.outputDir, {
      status: 'cancelled',
      completedAt: now(),
    })
    this.activeRuns.delete(automationId)
    this.sendLog({ automationId, runId: run.runId, type: 'status', timestamp: now(), content: 'Automation cancelled' })
  }

  registerCron(config: AutomationConfig): void {
    this.deregisterCron(config.id)
    const schedule = config.trigger.schedule
    if (!schedule) return

    try {
      const job = cron.schedule(schedule.cron, () => {
        if (this.activeRuns.has(config.id)) {
          console.warn(`Skipping cron for ${config.id}: already running`)
          return
        }
        this.run(config.id).catch((err) => {
          console.error(`Cron run failed for ${config.id}:`, err)
        })
      })
      this.cronJobs.set(config.id, job)
    } catch (e) {
      console.error(`Invalid cron for ${config.id}:`, e)
    }
  }

  deregisterCron(automationId: string): void {
    const job = this.cronJobs.get(automationId)
    if (job) {
      job.stop()
      this.cronJobs.delete(automationId)
    }
  }

  private async executeRun(
    config: AutomationConfig,
    runId: string,
    outputDir: string,
    abortController: AbortController
  ): Promise<void> {
    const { agent } = config
    const automationId = config.id

    try {
      const model = this.createModel(agent.provider, agent.model)
      const tools = this.buildTools(agent.tools, outputDir, agent.shellTimeout ?? 60, abortController.signal)

      const systemPrompt = [
        agent.systemPrompt,
        `Output directory for files: ${outputDir}`,
        'Write any output files (reports, CSVs, etc.) to the output directory using the write_file tool.',
      ].filter(Boolean).join('\n\n')

      const result = await generateText({
        model,
        system: systemPrompt,
        prompt: agent.prompt,
        tools,
        maxSteps: agent.maxSteps,
        maxTokens: agent.maxTokens,
        abortSignal: abortController.signal,
        onStepFinish: ({ text, toolCalls, toolResults }) => {
          if (text) {
            this.sendLog({ automationId, runId, type: 'text', timestamp: now(), content: text })
          }
          for (const tc of toolCalls) {
            this.sendLog({
              automationId, runId, type: 'tool-call', timestamp: now(),
              content: JSON.stringify(tc.args, null, 2), toolName: tc.toolName,
            })
          }
          for (const tr of toolResults) {
            this.sendLog({
              automationId, runId, type: 'tool-result', timestamp: now(),
              content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
              toolName: tr.toolName,
            })
          }
        },
      })

      await this.store.updateRunManifest(outputDir, {
        status: 'success',
        completedAt: now(),
        stepCount: result.steps.length,
      })
      this.sendLog({ automationId, runId, type: 'status', timestamp: now(), content: 'Automation completed successfully' })
    } catch (e) {
      if (abortController.signal.aborted) return // Already handled by stop()
      const errorMsg = e instanceof Error ? e.message : String(e)
      await this.store.updateRunManifest(outputDir, {
        status: 'error',
        completedAt: now(),
        error: errorMsg,
      })
      this.sendLog({ automationId, runId, type: 'error', timestamp: now(), content: errorMsg })
    } finally {
      this.activeRuns.delete(automationId)
    }
  }

  private createModel(provider: string, modelId: string) {
    const apiKey = this.getApiKey(provider)
    if (!apiKey) throw new Error(`No API key for provider: ${provider}`)

    switch (provider) {
      case 'anthropic':
        return createAnthropic({ apiKey })(modelId)
      case 'openai':
        return createOpenAI({ apiKey })(modelId)
      case 'google':
        return createGoogleGenerativeAI({ apiKey })(modelId)
      default:
        throw new Error(`Unsupported provider: ${provider}`)
    }
  }

  private buildTools(
    toolNames: readonly string[],
    outputDir: string,
    shellTimeout: number,
    abortSignal: AbortSignal
  ) {
    const tools: Record<string, ReturnType<typeof createShellTool>> = {}

    for (const name of toolNames) {
      switch (name) {
        case 'shell':
          tools.shell = createShellTool({ timeoutSeconds: shellTimeout, abortSignal })
          break
        case 'read_file':
          tools.read_file = createReadFileTool()
          break
        case 'write_file':
          tools.write_file = createWriteFileTool(outputDir)
          break
        case 'fleet':
          tools.fleet = createFleetTool(this.commandHandler)
          break
      }
    }

    return tools
  }

  private sendLog(event: LogEvent): void {
    const win = this.getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.AUTOMATION_LOG, event)
    }
  }
}

function now(): string {
  return new Date().toISOString()
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/automation-engine.ts
git commit -m "feat(automation): add execution engine with Vercel AI SDK, cron, and cancellation"
```

---

## Task 6: IPC Handlers and Preload Bridge

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add automation IPC handlers**

In `src/main/ipc-handlers.ts`, inside the `registerIpcHandlers` function, add the automation handlers. The function will need to accept the `AutomationFileStore` and `AutomationEngine` as parameters.

Add to the function signature:

```ts
automationStore: AutomationFileStore,
automationEngine: AutomationEngine,
```

Add handlers:

```ts
// --- Automation ---
ipcMain.handle(IPC_CHANNELS.AUTOMATION_LIST, async () => {
  const automations = await automationStore.list()
  // Enrich with running status from engine
  return {
    automations: automations.map((a) => ({
      ...a,
      status: automationEngine.isRunning(a.id) ? 'running' : a.status,
    })),
  }
})

ipcMain.handle(IPC_CHANNELS.AUTOMATION_READ, async (_event, req: { id: string }) => {
  return automationStore.read(req.id)
})

ipcMain.handle(IPC_CHANNELS.AUTOMATION_WRITE, async (_event, req: { config: AutomationConfig }) => {
  await automationStore.write(req.config)
  // Re-register cron if schedule changed
  if (req.config.trigger.schedule) {
    automationEngine.registerCron(req.config)
  } else {
    automationEngine.deregisterCron(req.config.id)
  }
})

ipcMain.handle(IPC_CHANNELS.AUTOMATION_DELETE, async (_event, req: { id: string }) => {
  automationEngine.deregisterCron(req.id)
  if (automationEngine.isRunning(req.id)) {
    await automationEngine.stop(req.id)
  }
  await automationStore.delete(req.id)
})

ipcMain.handle(IPC_CHANNELS.AUTOMATION_RUN, async (_event, req: { id: string }) => {
  const runId = await automationEngine.run(req.id)
  return { runId }
})

ipcMain.handle(IPC_CHANNELS.AUTOMATION_STOP, async (_event, req: { id: string }) => {
  await automationEngine.stop(req.id)
})

ipcMain.handle(IPC_CHANNELS.AUTOMATION_OUTPUTS, async (_event, req: { id: string }) => {
  const runs = await automationStore.listOutputs(req.id)
  return { runs }
})
```

- [ ] **Step 2: Add automation API to preload bridge**

In `src/preload/index.ts`, add to the `fleetApi` object:

```ts
automation: {
  list: () => typedInvoke<AutomationListResponse>(IPC_CHANNELS.AUTOMATION_LIST),
  read: (id: string) => typedInvoke<AutomationConfig | null>(IPC_CHANNELS.AUTOMATION_READ, { id }),
  write: (config: AutomationConfig) => typedInvoke<void>(IPC_CHANNELS.AUTOMATION_WRITE, { config }),
  delete: (id: string) => typedInvoke<void>(IPC_CHANNELS.AUTOMATION_DELETE, { id }),
  run: (id: string) => typedInvoke<{ runId: string }>(IPC_CHANNELS.AUTOMATION_RUN, { id }),
  stop: (id: string) => typedInvoke<void>(IPC_CHANNELS.AUTOMATION_STOP, { id }),
  outputs: (id: string) => typedInvoke<AutomationOutputsResponse>(IPC_CHANNELS.AUTOMATION_OUTPUTS, { id }),
  onLog: (callback: (event: LogEvent) => void) =>
    onChannel<LogEvent>(IPC_CHANNELS.AUTOMATION_LOG, callback),
},
```

Import the needed types at the top of the preload file.

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc-handlers.ts src/preload/index.ts
git commit -m "feat(automation): add IPC handlers and preload bridge for automation API"
```

---

## Task 7: Renderer Zustand Store

**Files:**
- Create: `src/renderer/src/store/automation-store.ts`

- [ ] **Step 1: Create the automation Zustand store**

Create `src/renderer/src/store/automation-store.ts`:

```ts
import { create } from 'zustand'
import type { AutomationConfig, AutomationMeta, LogEvent, RunOutput } from '../../../shared/automation-types'

interface AutomationStore {
  // List state
  automations: AutomationMeta[]
  isLoaded: boolean

  // Run state
  runningAutomations: Record<string, RunState>

  // Actions
  loadAutomations: () => Promise<void>
  runAutomation: (id: string) => Promise<string>
  stopAutomation: (id: string) => Promise<void>
  appendLog: (event: LogEvent) => void
  updateStatus: (automationId: string, status: AutomationMeta['status']) => void
}

interface RunState {
  runId: string
  automationId: string
  startedAt: string
  logs: LogEvent[]
  status: 'running' | 'success' | 'error' | 'cancelled'
}

export const useAutomationStore = create<AutomationStore>((set, get) => ({
  automations: [],
  isLoaded: false,
  runningAutomations: {},

  loadAutomations: async () => {
    const { automations } = await window.fleet.automation.list()
    set({ automations, isLoaded: true })
  },

  runAutomation: async (id: string) => {
    const { runId } = await window.fleet.automation.run(id)

    set((state) => ({
      automations: state.automations.map((a) =>
        a.id === id ? { ...a, status: 'running' as const } : a
      ),
      runningAutomations: {
        ...state.runningAutomations,
        [id]: {
          runId,
          automationId: id,
          startedAt: new Date().toISOString(),
          logs: [],
          status: 'running',
        },
      },
    }))

    return runId
  },

  stopAutomation: async (id: string) => {
    await window.fleet.automation.stop(id)
    set((state) => {
      const { [id]: _, ...rest } = state.runningAutomations
      return {
        automations: state.automations.map((a) =>
          a.id === id ? { ...a, status: 'cancelled' as const } : a
        ),
        runningAutomations: rest, // Remove the run — it's done
      }
    })
  },

  appendLog: (event: LogEvent) => {
    set((state) => {
      const run = state.runningAutomations[event.automationId]
      if (!run) return state
      return {
        runningAutomations: {
          ...state.runningAutomations,
          [event.automationId]: {
            ...run,
            logs: [...run.logs, event],
          },
        },
      }
    })

    // Handle terminal status events
    if (event.type === 'status') {
      if (event.content.includes('completed successfully')) {
        get().updateStatus(event.automationId, 'idle')
      } else if (event.content.includes('cancelled')) {
        get().updateStatus(event.automationId, 'cancelled')
      }
    } else if (event.type === 'error') {
      get().updateStatus(event.automationId, 'error')
    }
  },

  updateStatus: (automationId: string, status: AutomationMeta['status']) => {
    set((state) => ({
      automations: state.automations.map((a) =>
        a.id === automationId ? { ...a, status } : a
      ),
    }))
  },
}))
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS (may require adding `automation` to the window.fleet type declaration — check `src/renderer/src/env.d.ts` or similar)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/store/automation-store.ts
git commit -m "feat(automation): add renderer Zustand store"
```

---

## Task 8: Sidebar Section

**Files:**
- Create: `src/renderer/src/components/AutomationSidebar.tsx`
- Modify: `src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Create the AutomationSidebar component**

Create `src/renderer/src/components/AutomationSidebar.tsx`:

```tsx
import { useState, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAutomationStore } from '../store/automation-store'
import { useWorkspaceStore } from '../store/workspace-store'
import {
  ChevronDown, ChevronRight, Plus, Zap, Clock, Loader2, AlertCircle, Ban
} from 'lucide-react'
import * as ContextMenu from '@radix-ui/react-context-menu'

export function AutomationSidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const { automations, isLoaded, loadAutomations } = useAutomationStore(
    useShallow((s) => ({
      automations: s.automations,
      isLoaded: s.isLoaded,
      loadAutomations: s.loadAutomations,
    }))
  )

  useEffect(() => {
    if (!isLoaded) loadAutomations()
  }, [isLoaded, loadAutomations])

  const handleNew = async () => {
    const id = crypto.randomUUID().slice(0, 8)
    const config = {
      id,
      name: 'New Automation',
      description: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      trigger: { manual: true },
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        systemPrompt: '',
        prompt: '',
        maxTokens: 8192,
        maxSteps: 25,
        tools: ['shell', 'read_file', 'write_file', 'fleet'] as const,
        shellTimeout: 60,
      },
    }
    await window.fleet.automation.write(config)
    await loadAutomations()
    openAutomationTab(id, config.name)
  }

  const openAutomationTab = (id: string, name: string) => {
    const ws = useWorkspaceStore.getState()
    // Check if tab already exists
    const existing = ws.workspace.tabs.find(
      (t) => t.type === 'automation' && t.splitRoot.type === 'leaf' && t.splitRoot.id === id
    )
    if (existing) {
      ws.setActiveTab(existing.id)
      return
    }
    // Create new automation tab
    const tabId = crypto.randomUUID()
    const tab = {
      id: tabId,
      label: name,
      labelIsCustom: true,
      cwd: '',
      type: 'automation' as const,
      splitRoot: {
        type: 'leaf' as const,
        id, // automation ID as pane ID
        cwd: '',
        paneType: 'automation' as const,
      },
    }
    ws.setWorkspace({
      ...ws.workspace,
      tabs: [...ws.workspace.tabs, tab],
      activeTabId: tabId,
    })
  }

  const handleDelete = async (id: string) => {
    await window.fleet.automation.delete(id)
    await loadAutomations()
  }

  const handleDuplicate = async (id: string) => {
    const config = await window.fleet.automation.read(id)
    if (!config) return
    const newId = crypto.randomUUID().slice(0, 8)
    await window.fleet.automation.write({
      ...config,
      id: newId,
      name: `${config.name} (copy)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await loadAutomations()
  }

  const handleShowOutputs = (id: string) => {
    window.fleet.shell.openExternal(`~/.fleet/automations/${id}`)
  }

  const handleShowInFinder = (id: string) => {
    window.fleet.shell.openExternal(`~/.fleet/automations/${id}.json`)
  }

  const statusIcon = (status: string) => {
    switch (status) {
      case 'running': return <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
      case 'error': return <AlertCircle className="w-3 h-3 text-red-400" />
      case 'cancelled': return <Ban className="w-3 h-3 text-neutral-500" />
      default: return null
    }
  }

  return (
    <div className="flex flex-col">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-neutral-400 hover:text-neutral-200 transition-colors"
      >
        {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        <Zap className="w-3 h-3" />
        <span>Automations</span>
        <button
          onClick={(e) => { e.stopPropagation(); handleNew() }}
          className="ml-auto p-0.5 rounded hover:bg-neutral-700"
          title="New Automation"
        >
          <Plus className="w-3 h-3" />
        </button>
      </button>

      {!collapsed && (
        <div className="flex flex-col gap-0.5 px-1">
          {automations.map((a) => (
            <ContextMenu.Root key={a.id}>
              <ContextMenu.Trigger asChild>
                <button
                  onClick={() => openAutomationTab(a.id, a.name)}
                  className="flex items-center gap-2 px-2 py-1 rounded text-xs text-neutral-300 hover:bg-neutral-800 w-full text-left"
                >
                  {statusIcon(a.status)}
                  <span className="truncate flex-1">{a.name}</span>
                  {a.hasSchedule && <Clock className="w-3 h-3 text-neutral-500 shrink-0" />}
                </button>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="bg-neutral-800 rounded border border-neutral-700 py-1 text-xs min-w-[160px]">
                  <ContextMenu.Item className="px-3 py-1.5 hover:bg-neutral-700 cursor-pointer" onSelect={() => openAutomationTab(a.id, a.name)}>
                    Open
                  </ContextMenu.Item>
                  <ContextMenu.Item className="px-3 py-1.5 hover:bg-neutral-700 cursor-pointer" onSelect={() => handleDuplicate(a.id)}>
                    Duplicate
                  </ContextMenu.Item>
                  <ContextMenu.Separator className="h-px bg-neutral-700 my-1" />
                  <ContextMenu.Item className="px-3 py-1.5 hover:bg-neutral-700 cursor-pointer" onSelect={() => handleShowOutputs(a.id)}>
                    Show Outputs in Finder
                  </ContextMenu.Item>
                  <ContextMenu.Item className="px-3 py-1.5 hover:bg-neutral-700 cursor-pointer" onSelect={() => handleShowInFinder(a.id)}>
                    Show in Finder
                  </ContextMenu.Item>
                  <ContextMenu.Separator className="h-px bg-neutral-700 my-1" />
                  <ContextMenu.Item className="px-3 py-1.5 hover:bg-red-900 text-red-400 cursor-pointer" onSelect={() => handleDelete(a.id)}>
                    Delete
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ))}

          {isLoaded && automations.length === 0 && (
            <p className="px-2 py-1 text-xs text-neutral-500">No automations yet</p>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Integrate into Sidebar.tsx**

In `src/renderer/src/components/Sidebar.tsx`, import and render `<AutomationSidebar />` between the `StarCommandTabCard` and the tab list. Find the appropriate location in the JSX (after the StarCommandTabCard rendering, before the `{tabs.map(...)}`).

```tsx
import { AutomationSidebar } from './AutomationSidebar'

// In JSX, between StarCommandTabCard and tab list:
<AutomationSidebar />
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/AutomationSidebar.tsx src/renderer/src/components/Sidebar.tsx
git commit -m "feat(automation): add sidebar section with automation list"
```

---

## Task 9: Automation Editor Tab

**Files:**
- Create: `src/renderer/src/components/AutomationTab.tsx`
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Create the AutomationTab component**

Create `src/renderer/src/components/AutomationTab.tsx`:

```tsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAutomationStore } from '../store/automation-store'
import { AutomationLogs } from './AutomationLogs'
import { AutomationOutputs } from './AutomationOutputs'
import { Play, Square, MoreHorizontal } from 'lucide-react'
import { SCHEDULE_PRESETS, AUTOMATION_TOOLS, type AutomationConfig, type SchedulePresetKey } from '../../../shared/automation-types'

interface AutomationTabProps {
  automationId: string
}

export function AutomationTab({ automationId }: AutomationTabProps) {
  const [config, setConfig] = useState<AutomationConfig | null>(null)
  const [saving, setSaving] = useState(false)

  const { runAutomation, stopAutomation, runningAutomations } = useAutomationStore(
    useShallow((s) => ({
      runAutomation: s.runAutomation,
      stopAutomation: s.stopAutomation,
      runningAutomations: s.runningAutomations,
    }))
  )

  const isRunning = !!runningAutomations[automationId]

  useEffect(() => {
    window.fleet.automation.read(automationId).then((c) => {
      if (c) setConfig(c)
    })
  }, [automationId])

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const save = useCallback((updated: AutomationConfig) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true)
      await window.fleet.automation.write(updated)
      setSaving(false)
    }, 500)
  }, [])

  const updateConfig = useCallback((partial: Partial<AutomationConfig>) => {
    setConfig((prev) => {
      if (!prev) return prev
      const updated = { ...prev, ...partial, updatedAt: new Date().toISOString() }
      save(updated)
      return updated
    })
  }, [save])

  const updateAgent = useCallback((partial: Partial<AutomationConfig['agent']>) => {
    setConfig((prev) => {
      if (!prev) return prev
      const updated = { ...prev, agent: { ...prev.agent, ...partial }, updatedAt: new Date().toISOString() }
      save(updated)
      return updated
    })
  }, [save])

  const updateTrigger = useCallback((partial: Partial<AutomationConfig['trigger']>) => {
    setConfig((prev) => {
      if (!prev) return prev
      const updated = { ...prev, trigger: { ...prev.trigger, ...partial }, updatedAt: new Date().toISOString() }
      save(updated)
      return updated
    })
  }, [save])

  if (!config) {
    return <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm">Loading...</div>
  }

  return (
    <div className="flex flex-col h-full bg-neutral-900 text-neutral-100">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800">
        <div className="flex-1 min-w-0">
          <input
            value={config.name}
            onChange={(e) => updateConfig({ name: e.target.value })}
            className="text-lg font-semibold bg-transparent border-none outline-none w-full text-neutral-100 placeholder-neutral-600"
            placeholder="Automation name"
          />
          <input
            value={config.description}
            onChange={(e) => updateConfig({ description: e.target.value })}
            className="text-xs bg-transparent border-none outline-none w-full text-neutral-400 placeholder-neutral-600 mt-0.5"
            placeholder="Description"
          />
        </div>
        {isRunning ? (
          <button
            onClick={() => stopAutomation(automationId)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-xs font-medium"
          >
            <Square className="w-3 h-3" /> Stop
          </button>
        ) : (
          <button
            onClick={() => runAutomation(automationId)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium"
          >
            <Play className="w-3 h-3" /> Run
          </button>
        )}
      </div>

      {/* Config form */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Trigger section */}
        <section>
          <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wide mb-2">Trigger</h3>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={config.trigger.manual}
                onChange={(e) => updateTrigger({ manual: e.target.checked })}
                className="rounded"
              />
              Manual
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={!!config.trigger.schedule}
                onChange={(e) => {
                  if (e.target.checked) {
                    updateTrigger({ schedule: { cron: '0 9 * * *', preset: 'daily-9am' } })
                  } else {
                    updateTrigger({ schedule: undefined })
                  }
                }}
                className="rounded"
              />
              Schedule
            </label>
            {config.trigger.schedule && (
              <select
                value={config.trigger.schedule.preset || 'custom'}
                onChange={(e) => {
                  const key = e.target.value as SchedulePresetKey
                  if (key in SCHEDULE_PRESETS) {
                    const preset = SCHEDULE_PRESETS[key]
                    updateTrigger({ schedule: { cron: preset.cron, preset: key } })
                  }
                }}
                className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
              >
                {Object.entries(SCHEDULE_PRESETS).map(([key, val]) => (
                  <option key={key} value={key}>{val.label}</option>
                ))}
                <option value="custom">Custom</option>
              </select>
            )}
            {config.trigger.schedule && !config.trigger.schedule.preset && (
              <input
                value={config.trigger.schedule.cron}
                onChange={(e) => updateTrigger({ schedule: { cron: e.target.value } })}
                placeholder="* * * * *"
                className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs font-mono w-40"
              />
            )}
          </div>
        </section>

        {/* Agent section */}
        <section>
          <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wide mb-2">Agent</h3>
          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-xs text-neutral-500 mb-1 block">Provider</label>
                <select
                  value={config.agent.provider}
                  onChange={(e) => updateAgent({ provider: e.target.value })}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-xs"
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="google">Google</option>
                </select>
              </div>
              <div className="flex-1">
                <label className="text-xs text-neutral-500 mb-1 block">Model</label>
                <input
                  value={config.agent.model}
                  onChange={(e) => updateAgent({ model: e.target.value })}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-xs font-mono"
                  placeholder="claude-sonnet-4-6"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-neutral-500 mb-1 block">System prompt (optional)</label>
              <textarea
                value={config.agent.systemPrompt}
                onChange={(e) => updateAgent({ systemPrompt: e.target.value })}
                rows={2}
                className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-xs font-mono resize-y"
                placeholder="You are a helpful assistant..."
              />
            </div>

            <div>
              <label className="text-xs text-neutral-500 mb-1 block">Prompt</label>
              <textarea
                value={config.agent.prompt}
                onChange={(e) => updateAgent({ prompt: e.target.value })}
                rows={6}
                className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-xs font-mono resize-y"
                placeholder="Describe what this automation should do..."
              />
            </div>

            <div>
              <label className="text-xs text-neutral-500 mb-1 block">Tools</label>
              <div className="flex gap-3">
                {AUTOMATION_TOOLS.map((tool) => (
                  <label key={tool} className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={config.agent.tools.includes(tool)}
                      onChange={(e) => {
                        const tools = e.target.checked
                          ? [...config.agent.tools, tool]
                          : config.agent.tools.filter((t) => t !== tool)
                        updateAgent({ tools })
                      }}
                      className="rounded"
                    />
                    {tool}
                  </label>
                ))}
              </div>
            </div>

            <div className="flex gap-3">
              <div>
                <label className="text-xs text-neutral-500 mb-1 block">Max steps</label>
                <input
                  type="number"
                  value={config.agent.maxSteps}
                  onChange={(e) => updateAgent({ maxSteps: Number(e.target.value) })}
                  min={1}
                  max={100}
                  className="w-20 bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="text-xs text-neutral-500 mb-1 block">Max tokens</label>
                <input
                  type="number"
                  value={config.agent.maxTokens}
                  onChange={(e) => updateAgent({ maxTokens: Number(e.target.value) })}
                  min={256}
                  max={32768}
                  className="w-24 bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-xs"
                />
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Bottom panels */}
      <div className="border-t border-neutral-800">
        <AutomationLogs automationId={automationId} />
        <AutomationOutputs automationId={automationId} />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Route automation tab type in App.tsx**

In `src/renderer/src/App.tsx`, add the import and render logic:

```tsx
import { AutomationTab } from './components/AutomationTab'
```

In the tab content rendering section (~line 460), the existing code uses a ternary: `tab.type === 'star-command' ? <StarCommandTab /> : <PaneGrid .../>`. Convert this to handle `automation` tabs:

```tsx
{activeTab?.type === 'star-command' ? (
  <StarCommandTab ... />
) : activeTab?.type === 'automation' && activeTab.splitRoot.type === 'leaf' ? (
  <AutomationTab automationId={activeTab.splitRoot.id} />
) : (
  <PaneGrid ... />
)}
```

Also add `'automation'` to the PaneGrid's `PaneNodeRenderer` in `src/renderer/src/components/PaneGrid.tsx` — add an early return for `paneType === 'automation'` that renders nothing (automation tabs are handled by App.tsx, not PaneGrid):

```tsx
if (node.paneType === 'automation') return null
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/AutomationTab.tsx src/renderer/src/App.tsx
git commit -m "feat(automation): add editor tab with trigger and agent config forms"
```

---

## Task 10: Logs Panel

**Files:**
- Create: `src/renderer/src/components/AutomationLogs.tsx`

- [ ] **Step 1: Create the AutomationLogs component**

Create `src/renderer/src/components/AutomationLogs.tsx`:

```tsx
import { useState, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAutomationStore } from '../store/automation-store'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import type { LogEvent } from '../../../shared/automation-types'

interface AutomationLogsProps {
  automationId: string
}

export function AutomationLogs({ automationId }: AutomationLogsProps) {
  const [expanded, setExpanded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const run = useAutomationStore(
    useShallow((s) => s.runningAutomations[automationId])
  )

  const logs = run?.logs ?? []

  // Auto-expand when a run starts
  useEffect(() => {
    if (run?.status === 'running') setExpanded(true)
  }, [run?.status])

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current && expanded) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs.length, expanded])

  const logColor = (type: LogEvent['type']) => {
    switch (type) {
      case 'tool-call': return 'text-blue-400'
      case 'tool-result': return 'text-green-400'
      case 'error': return 'text-red-400'
      case 'status': return 'text-yellow-400'
      default: return 'text-neutral-300'
    }
  }

  const logPrefix = (event: LogEvent) => {
    switch (event.type) {
      case 'tool-call': return `[${event.toolName}]`
      case 'tool-result': return `[${event.toolName} result]`
      case 'error': return '[error]'
      case 'status': return '[status]'
      default: return ''
    }
  }

  return (
    <div className="border-t border-neutral-800">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-neutral-400 hover:text-neutral-200 w-full"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Logs
        {logs.length > 0 && (
          <span className="text-neutral-500 ml-1">({logs.length})</span>
        )}
      </button>

      {expanded && (
        <div
          ref={scrollRef}
          className="max-h-48 overflow-y-auto px-4 pb-2 font-mono text-xs space-y-0.5"
        >
          {logs.length === 0 ? (
            <p className="text-neutral-500 py-2">No logs yet. Run the automation to see output.</p>
          ) : (
            logs.map((event, i) => (
              <div key={i} className={`${logColor(event.type)} whitespace-pre-wrap break-all`}>
                <span className="text-neutral-500">{new Date(event.timestamp).toLocaleTimeString()}</span>
                {' '}
                {logPrefix(event) && <span className="font-semibold">{logPrefix(event)} </span>}
                {event.content}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/AutomationLogs.tsx
git commit -m "feat(automation): add collapsible log panel with streaming output"
```

---

## Task 11: Outputs Panel

**Files:**
- Create: `src/renderer/src/components/AutomationOutputs.tsx`

- [ ] **Step 1: Create the AutomationOutputs component**

Create `src/renderer/src/components/AutomationOutputs.tsx`:

```tsx
import { useState, useEffect } from 'react'
import {
  ChevronDown, ChevronRight, CheckCircle, AlertCircle, Ban,
  Loader2, FileText, FileSpreadsheet, FileImage, File,
  FolderOpen, Clipboard
} from 'lucide-react'
import type { RunOutput, RunOutputFile } from '../../../shared/automation-types'

interface AutomationOutputsProps {
  automationId: string
}

export function AutomationOutputs({ automationId }: AutomationOutputsProps) {
  const [expanded, setExpanded] = useState(false)
  const [runs, setRuns] = useState<RunOutput[]>([])
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set())

  const loadOutputs = async () => {
    const { runs } = await window.fleet.automation.outputs(automationId)
    setRuns(runs)
    // Auto-expand most recent
    if (runs.length > 0) {
      setExpandedRuns(new Set([runs[0].runId]))
    }
  }

  useEffect(() => {
    if (expanded) loadOutputs()
  }, [expanded, automationId])

  const toggleRun = (runId: string) => {
    setExpandedRuns((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const formatTimestamp = (iso: string) => {
    const date = new Date(iso)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'Just now'
    if (mins < 60) return `${mins} min ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours} hrs ago`
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  const statusIcon = (status: string) => {
    switch (status) {
      case 'success': return <CheckCircle className="w-3.5 h-3.5 text-green-400" />
      case 'error': return <AlertCircle className="w-3.5 h-3.5 text-red-400" />
      case 'cancelled': return <Ban className="w-3.5 h-3.5 text-neutral-500" />
      case 'running': return <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
      default: return null
    }
  }

  const fileIcon = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase()
    if (['csv', 'tsv', 'xlsx'].includes(ext ?? '')) return <FileSpreadsheet className="w-3.5 h-3.5 text-green-400" />
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext ?? '')) return <FileImage className="w-3.5 h-3.5 text-purple-400" />
    if (['md', 'txt', 'log', 'json'].includes(ext ?? '')) return <FileText className="w-3.5 h-3.5 text-blue-400" />
    return <File className="w-3.5 h-3.5 text-neutral-400" />
  }

  const copyPath = (path: string) => {
    navigator.clipboard.writeText(path)
  }

  const openInFinder = (path: string) => {
    window.fleet.shell.openExternal(path)
  }

  // Group runs by day
  const groupByDay = (runs: RunOutput[]) => {
    const groups: { label: string; runs: RunOutput[] }[] = []
    const today = new Date().toDateString()
    const yesterday = new Date(Date.now() - 86400000).toDateString()

    for (const run of runs) {
      const day = new Date(run.startedAt).toDateString()
      let label = new Date(run.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      if (day === today) label = 'Today'
      else if (day === yesterday) label = 'Yesterday'

      const existing = groups.find((g) => g.label === label)
      if (existing) existing.runs.push(run)
      else groups.push({ label, runs: [run] })
    }
    return groups
  }

  const groups = groupByDay(runs)

  return (
    <div className="border-t border-neutral-800">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-neutral-400 hover:text-neutral-200 w-full"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Outputs
        {runs.length > 0 && (
          <span className="text-neutral-500 ml-1">({runs.length} runs)</span>
        )}
      </button>

      {expanded && (
        <div className="max-h-64 overflow-y-auto px-4 pb-3 text-xs">
          {runs.length === 0 ? (
            <p className="text-neutral-500 py-4 text-center">
              No outputs yet. Run your automation to see results here.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="mb-2">
                <p className="text-neutral-500 font-medium uppercase tracking-wide text-[10px] mb-1">
                  {group.label}
                </p>
                {group.runs.map((run) => (
                  <div key={run.runId} className="mb-1">
                    <button
                      onClick={() => toggleRun(run.runId)}
                      className="flex items-center gap-2 w-full py-1 px-1 rounded hover:bg-neutral-800"
                    >
                      {expandedRuns.has(run.runId)
                        ? <ChevronDown className="w-3 h-3 text-neutral-500" />
                        : <ChevronRight className="w-3 h-3 text-neutral-500" />
                      }
                      {statusIcon(run.status)}
                      <span className="text-neutral-400">{formatTimestamp(run.startedAt)}</span>
                      <span className="text-neutral-500 ml-auto">{run.files.length} files</span>
                    </button>

                    {expandedRuns.has(run.runId) && run.files.length > 0 && (
                      <div className="ml-5 mt-0.5 space-y-0.5">
                        {run.files.map((file) => (
                          <div
                            key={file.path}
                            className="flex items-center gap-2 py-0.5 px-1 rounded hover:bg-neutral-800 group"
                          >
                            {fileIcon(file.name)}
                            <span className="text-neutral-300 truncate flex-1">{file.name}</span>
                            <span className="text-neutral-600">{formatSize(file.sizeBytes)}</span>
                            <div className="hidden group-hover:flex items-center gap-1">
                              <button
                                onClick={() => openInFinder(file.path)}
                                className="p-0.5 rounded hover:bg-neutral-700"
                                title="Open"
                              >
                                <FolderOpen className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => copyPath(file.path)}
                                className="p-0.5 rounded hover:bg-neutral-700"
                                title="Copy path"
                              >
                                <Clipboard className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/AutomationOutputs.tsx
git commit -m "feat(automation): add outputs panel with grouped runs and file browser"
```

---

## Task 12: Settings — AI Providers

**Files:**
- Modify: `src/renderer/src/components/SettingsModal.tsx`

- [ ] **Step 1: Add AI Providers tab to SettingsModal**

In `src/renderer/src/components/SettingsModal.tsx`:

1. Add `'ai-providers'` to the tab type union (around line 56)
2. Add a tab button for "AI Providers" in the tab bar
3. Add the providers section content:

```tsx
{activeTab === 'ai-providers' && (
  <div className="space-y-4">
    <h3 className="text-sm font-medium">AI Providers</h3>
    <p className="text-xs text-neutral-400">
      API keys for automation agents. Environment variables (e.g., ANTHROPIC_API_KEY) are used as fallback.
    </p>
    {(['anthropic', 'openai', 'google'] as const).map((provider) => (
      <div key={provider} className="flex items-center gap-3">
        <label className="text-xs w-20 capitalize">{provider}</label>
        <input
          type="password"
          value={settings?.aiProviders?.[provider]?.apiKey ?? ''}
          onChange={(e) => {
            const current = settings?.aiProviders ?? {}
            updateSettings({
              aiProviders: {
                ...current,
                [provider]: { ...current[provider], apiKey: e.target.value },
              },
            })
          }}
          placeholder="API key"
          className="flex-1 bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-xs font-mono"
        />
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/SettingsModal.tsx
git commit -m "feat(automation): add AI Providers settings tab"
```

---

## Task 13: Main Process Integration

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Initialize automation engine on app startup**

In `src/main/index.ts`, after existing services are initialized:

1. Import `AutomationFileStore` and `AutomationEngine`
2. Create the store with `~/.fleet/automations/` base dir
3. Create the engine with dependencies
4. Call `init()` on both
5. Pass them to `registerIpcHandlers()`

```ts
import { AutomationFileStore } from './automation-store'
import { AutomationEngine } from './automation-engine'
import { homedir } from 'os'
import { join } from 'path'

// After existing service init:
const automationStore = new AutomationFileStore(join(homedir(), '.fleet', 'automations'))
await automationStore.init()

const automationEngine = new AutomationEngine({
  automationStore,
  commandHandler, // existing FleetCommandHandler instance
  getWindow: () => mainWindow,
  getApiKey: (provider: string) => {
    const settings = settingsStore.get()
    return settings.aiProviders?.[provider]?.apiKey || process.env[`${provider.toUpperCase()}_API_KEY`]
  },
})
await automationEngine.init()

// Pass to registerIpcHandlers:
registerIpcHandlers(
  // ...existing params,
  automationStore,
  automationEngine,
)
```

6. Set up the log listener in the renderer:

In `src/renderer/src/App.tsx`, inside the main `useEffect` block where other IPC listeners are registered (around line 103-110 where `loadSettings` and CWD listeners are set up), add the automation log subscription:

```ts
import { useAutomationStore } from './store/automation-store'

// Inside the useEffect:
const unsubLog = window.fleet.automation.onLog((event) => {
  useAutomationStore.getState().appendLog(event)
})

// In the cleanup return:
return () => { unsubLog() /* ...existing cleanup */ }
```

- [ ] **Step 2: Run typecheck and build**

```bash
npm run typecheck && npm run build
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(automation): wire up engine and store in main process startup"
```

---

## Task 14: Final Verification

> **Note on window.fleet types:** The `FleetApi` type is inferred from `typeof fleetApi` in the preload file and re-exported. Adding the `automation` namespace to the preload's `fleetApi` object (Task 6) automatically makes `window.fleet.automation` typed. No manual `env.d.ts` changes needed.

- [ ] **Step 1: Run full typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: PASS (fix any lint issues)

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all automation tests PASS

- [ ] **Step 4: Run build**

```bash
npm run build
```

Expected: PASS

- [ ] **Step 5: Manual smoke test**

Start the dev server and verify:
1. Sidebar shows "Automations" section under Star Command
2. Click "+" creates a new automation and opens the tab
3. Editor shows trigger config, agent config, tools
4. Settings has "AI Providers" tab
5. (If API key configured) Run button triggers execution, logs stream in real time

```bash
npm run dev
```

- [ ] **Step 6: Commit any remaining fixes**

```bash
git add -A
git commit -m "fix(automation): address lint and type issues from integration"
```
