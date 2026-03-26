# Per-Mission-Type Model Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users configure which Claude model each mission type uses, globally, via the Starbase Settings UI.

**Architecture:** Add 5 new `crew_model_<type>` config keys to `starbase_config` (migration + defaults). Wire `crew-service.ts` to read the model from config instead of the sector row. Surface all model keys in the StarCommandConfig UI. Remove the per-sector model input.

**Tech Stack:** TypeScript, better-sqlite3, React, Vitest

---

### Task 1: Add migration and config defaults for crew model keys

**Files:**
- Modify: `src/main/starbase/migrations.ts:310-367`

- [ ] **Step 1: Add migration 016 to the MIGRATIONS array**

In `src/main/starbase/migrations.ts`, add a new migration entry after the last one (version 15). Insert it before the closing `];` of the `MIGRATIONS` array:

```typescript
  {
    version: 16,
    name: '016-crew-model-config',
    sql: `
      INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('crew_model_code', '"claude-haiku-4-5"');
      INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('crew_model_research', '"claude-haiku-4-5"');
      INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('crew_model_review', '"claude-haiku-4-5"');
      INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('crew_model_architect', '"claude-haiku-4-5"');
      INSERT OR IGNORE INTO starbase_config (key, value) VALUES ('crew_model_repair', '"claude-haiku-4-5"');
    `
  },
```

- [ ] **Step 2: Add the 5 keys to CONFIG_DEFAULTS**

In the `CONFIG_DEFAULTS` object (same file), add these entries after `protocol_executions_retention_days`:

```typescript
  crew_model_code: 'claude-haiku-4-5',
  crew_model_research: 'claude-haiku-4-5',
  crew_model_review: 'claude-haiku-4-5',
  crew_model_architect: 'claude-haiku-4-5',
  crew_model_repair: 'claude-haiku-4-5'
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors)

- [ ] **Step 4: Commit**

```bash
git add src/main/starbase/migrations.ts
git commit -m "feat: add crew_model_* config keys via migration 016"
```

---

### Task 2: Wire crew-service to read model from config

**Files:**
- Modify: `src/main/starbase/crew-service.ts:229`
- Modify: `src/main/starbase/hull.ts:120-137, 264`

- [ ] **Step 1: Make HullOpts.model required**

In `src/main/starbase/hull.ts`, change the `model` field in `HullOpts` from optional to required:

```typescript
  /** Claude model for the agent session */
  model: string;
```

(Remove the `?` from `model?: string` and update the JSDoc to remove "override" and "default" language.)

- [ ] **Step 2: Remove the fallback in Hull.start()**

In `src/main/starbase/hull.ts` line 264, change:

```typescript
      const model = this.opts.model || 'claude-sonnet-4-6';
```

to:

```typescript
      const model = this.opts.model;
```

- [ ] **Step 3: Read model from configService in crew-service.ts**

In `src/main/starbase/crew-service.ts`, replace line 229:

```typescript
      model: sector.model ?? undefined,
```

with:

```typescript
      model: configService.getString(`crew_model_${missionType}`),
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Run existing crew-service tests**

Run: `npx vitest run src/main/__tests__/crew-service.test.ts`
Expected: PASS (existing tests still pass — they use ConfigService with defaults from migrations)

- [ ] **Step 6: Commit**

```bash
git add src/main/starbase/hull.ts src/main/starbase/crew-service.ts
git commit -m "feat: read crew model from global config by mission type"
```

---

### Task 3: Add model fields to StarCommandConfig UI

**Files:**
- Modify: `src/renderer/src/components/StarCommandConfig.tsx:618-650, 252-259`

- [ ] **Step 1: Add model config fields to CONFIG_FIELDS**

In `src/renderer/src/components/StarCommandConfig.tsx`, add these entries to the `CONFIG_FIELDS` array. Insert them right after the existing `admiral_model` entry (line 625):

```typescript
  { key: 'crew_model_code', label: 'Crew Model (Code)', type: 'text' },
  { key: 'crew_model_research', label: 'Crew Model (Research)', type: 'text' },
  { key: 'crew_model_review', label: 'Crew Model (Review)', type: 'text' },
  { key: 'crew_model_architect', label: 'Crew Model (Architect)', type: 'text' },
  { key: 'crew_model_repair', label: 'Crew Model (Repair)', type: 'text' },
  { key: 'first_officer_model', label: 'First Officer Model', type: 'text' },
  { key: 'navigator_model', label: 'Navigator Model', type: 'text' },
  { key: 'analyst_model', label: 'Analyst Model', type: 'text' },
```

- [ ] **Step 2: Remove the per-sector Model input**

In the same file, remove the per-sector "Model" input block (lines ~251-259). Delete this entire `<div>`:

```tsx
            <div>
              <label className="text-neutral-500 block mb-1">Model</label>
              <input
                type="text"
                value={sector.model ?? ''}
                placeholder="claude-sonnet-4-6"
                onChange={(e) => onUpdate(sector.id, { model: e.target.value || null })}
                className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none font-mono"
              />
            </div>
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/StarCommandConfig.tsx
git commit -m "feat: add per-mission-type model fields to Starbase Settings UI"
```

---

### Task 4: Clean up stale references to sector-level model

**Files:**
- Modify: `src/main/starbase/workspace-templates.ts:165, 173, 180`
- Modify: `src/main/fleet-cli.ts:712`

- [ ] **Step 1: Update workspace-templates.ts help text**

In `src/main/starbase/workspace-templates.ts`, find the line:

```
| `model` | `claude-sonnet-4-6` | Claude model for the agent session |
```

and remove it (delete the entire table row).

Find the line:

```
fleet sectors show <id>    # Show full Sector details including model and agent config
```

and change it to:

```
fleet sectors show <id>    # Show full Sector details and agent config
```

Find the line:

```
- `claude-sonnet-4-6` — Default; suitable for most development Missions
```

and remove it (and any surrounding model-choice text if present — check context).

- [ ] **Step 2: Update fleet-cli.ts help text**

In `src/main/fleet-cli.ts`, find line 712:

```
  fleet sectors show <id>                Show full Sector details (model, config, base branch)
```

and change it to:

```
  fleet sectors show <id>                Show full Sector details (config, base branch)
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/starbase/workspace-templates.ts src/main/fleet-cli.ts
git commit -m "chore: remove stale sector-level model references from help text"
```
