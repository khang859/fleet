# Claude Session Cost Estimator + Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, per Claude Code session, an estimated USD cost plus richer metadata (model(s), token breakdown, git branch, start/end + duration) in the Sessions tool — list row and transcript header.

**Architecture:** Pure pricing math in `src/shared/claude-pricing.ts` (prefix-keyed table + cost formula). A best-effort `pricing-source.ts` in main fetches an updated table from a public raw GitHub URL (24h TTL), validated by zod, cached to `userData`, falling back to the bundled table. `claude-source.ts` parses raw JSONL to aggregate per-model token usage (deduped by `message.id`) and computes cost at list time. New optional `SessionSummary` fields carry the data to the renderer, which renders a cost badge and a metadata strip.

**Tech Stack:** Electron (main + renderer), TypeScript, React, Tailwind, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-claude-session-cost-estimator-design.md`

---

## File Structure

- **Create** `src/shared/claude-pricing.ts` — zod schema, `BUNDLED_PRICES`, `resolvePrice`, `estimateCostUsd`, `estimateSessionCostUsd`. Pure; no electron/node imports.
- **Create** `src/shared/__tests__/claude-pricing.test.ts` — pricing unit tests + bundled/JSON sync guard.
- **Create** `resources/claude-pricing.json` — the hosted artifact (serialized bundled table).
- **Create** `src/main/sessions/pricing-source.ts` — fetch/cache/`getPriceTable`/`ensurePricesFresh`.
- **Create** `src/main/sessions/__tests__/pricing-source.test.ts` — schema validation + cache round-trip.
- **Modify** `src/shared/sessions.ts` — add `ClaudeUsage` type and optional `SessionSummary` fields.
- **Modify** `src/main/sessions/claude-source.ts` — `aggregateClaudeUsage`, wire cost into list/read.
- **Modify** `src/main/sessions/__tests__/claude-source.test.ts` — aggregation tests.
- **Modify** `src/main/sessions/service.ts` — trigger `ensurePricesFresh()` on `list()`.
- **Modify** `src/renderer/src/components/sessions/SessionList.tsx` — cost badge.
- **Modify** `src/renderer/src/components/sessions/TranscriptView.tsx` — metadata strip.

---

## Task 1: Pricing module (pure)

**Files:**
- Create: `src/shared/claude-pricing.ts`
- Create: `resources/claude-pricing.json`
- Test: `src/shared/__tests__/claude-pricing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/shared/__tests__/claude-pricing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BUNDLED_PRICES,
  priceTableSchema,
  resolvePrice,
  estimateCostUsd,
  estimateSessionCostUsd,
  type ClaudeUsageInput
} from '../claude-pricing';

const zeroUsage: ClaudeUsageInput = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0
};

describe('resolvePrice', () => {
  it('matches an exact known family prefix', () => {
    expect(resolvePrice('claude-opus-4-8', BUNDLED_PRICES)?.input).toBe(5);
    expect(resolvePrice('claude-fable-5', BUNDLED_PRICES)?.input).toBe(10);
    expect(resolvePrice('claude-sonnet-4-6', BUNDLED_PRICES)?.input).toBe(3);
    expect(resolvePrice('claude-haiku-4-5', BUNDLED_PRICES)?.input).toBe(1);
  });

  it('matches a future point release within a family via prefix', () => {
    expect(resolvePrice('claude-opus-4-99', BUNDLED_PRICES)?.input).toBe(5);
  });

  it('prefers the longest matching prefix', () => {
    // mythos and fable both $10/$50 but resolve via their own prefixes
    expect(resolvePrice('claude-mythos-5', BUNDLED_PRICES)?.output).toBe(50);
  });

  it('returns undefined for an unknown model', () => {
    expect(resolvePrice('gpt-4o', BUNDLED_PRICES)).toBeUndefined();
    expect(resolvePrice('claude-opus-3', BUNDLED_PRICES)).toBeUndefined();
  });
});

describe('estimateCostUsd', () => {
  it('computes cost from tokens × rates with cache multipliers', () => {
    // opus-4-8: input $5/MTok, output $25/MTok, cacheRead 0.1×, write5m 1.25×, write1h 2×
    const cost = estimateCostUsd(
      {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 1_000_000
      },
      'claude-opus-4-8',
      BUNDLED_PRICES
    );
    // 5 + 25 + (5*0.1) + (5*1.25) + (5*2) = 5 + 25 + 0.5 + 6.25 + 10 = 46.75
    expect(cost).toBeCloseTo(46.75, 5);
  });

  it('returns undefined for an unpriced model', () => {
    expect(estimateCostUsd(zeroUsage, 'mystery-model', BUNDLED_PRICES)).toBeUndefined();
  });
});

describe('estimateSessionCostUsd', () => {
  it('sums cost across models', () => {
    const perModel = new Map<string, ClaudeUsageInput>([
      ['claude-opus-4-8', { ...zeroUsage, output: 1_000_000 }], // $25
      ['claude-haiku-4-5', { ...zeroUsage, output: 1_000_000 }] // $5
    ]);
    expect(estimateSessionCostUsd(perModel, BUNDLED_PRICES)).toBeCloseTo(30, 5);
  });

  it('returns undefined if any model is unpriced', () => {
    const perModel = new Map<string, ClaudeUsageInput>([
      ['claude-opus-4-8', { ...zeroUsage, output: 1_000_000 }],
      ['mystery-model', { ...zeroUsage, output: 1_000_000 }]
    ]);
    expect(estimateSessionCostUsd(perModel, BUNDLED_PRICES)).toBeUndefined();
  });
});

describe('bundled table', () => {
  it('passes its own schema', () => {
    expect(priceTableSchema.safeParse(BUNDLED_PRICES).success).toBe(true);
  });

  it('stays in sync with resources/claude-pricing.json', () => {
    const json = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../resources/claude-pricing.json', import.meta.url)),
        'utf8'
      )
    );
    expect(json).toEqual(BUNDLED_PRICES);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/__tests__/claude-pricing.test.ts`
Expected: FAIL — cannot resolve `../claude-pricing`.

- [ ] **Step 3: Write the pricing module**

Create `src/shared/claude-pricing.ts`:

```ts
// src/shared/claude-pricing.ts
// Pure pricing table + cost math for Claude sessions. No electron/node imports.
import { z } from 'zod';

/** Per-model pricing entry. Rates are USD per 1,000,000 tokens. */
export const modelPriceSchema = z.object({
  prefix: z.string(),
  input: z.number(),
  output: z.number(),
  cacheReadMult: z.number(),
  cacheWrite5mMult: z.number(),
  cacheWrite1hMult: z.number()
});
export type ModelPrice = z.infer<typeof modelPriceSchema>;

export const priceTableSchema = z.object({
  schemaVersion: z.literal(1),
  updated: z.string(),
  models: z.array(modelPriceSchema)
});
export type PriceTable = z.infer<typeof priceTableSchema>;

/** Token counts for cost math. Mirrors ClaudeUsage in shared/sessions.ts. */
export type ClaudeUsageInput = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

/**
 * Bundled fallback table. Also the seed and the source of truth for
 * resources/claude-pricing.json (kept in sync by a test). Cache multipliers are
 * uniform today (read 0.1×, 5m-write 1.25×, 1h-write 2×) but carried per-entry to
 * future-proof against Anthropic changing cache economics.
 */
export const BUNDLED_PRICES: PriceTable = {
  schemaVersion: 1,
  updated: '2026-06-12',
  models: [
    { prefix: 'claude-fable-', input: 10, output: 50, cacheReadMult: 0.1, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2 },
    { prefix: 'claude-mythos-', input: 10, output: 50, cacheReadMult: 0.1, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2 },
    { prefix: 'claude-opus-4-', input: 5, output: 25, cacheReadMult: 0.1, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2 },
    { prefix: 'claude-sonnet-4-', input: 3, output: 15, cacheReadMult: 0.1, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2 },
    { prefix: 'claude-haiku-4-', input: 1, output: 5, cacheReadMult: 0.1, cacheWrite5mMult: 1.25, cacheWrite1hMult: 2 }
  ]
};

/** Longest-prefix match on the model id. Returns undefined when nothing matches. */
export function resolvePrice(model: string, table: PriceTable): ModelPrice | undefined {
  let best: ModelPrice | undefined;
  for (const entry of table.models) {
    if (model.startsWith(entry.prefix) && (!best || entry.prefix.length > best.prefix.length)) {
      best = entry;
    }
  }
  return best;
}

/** Cost for one usage bucket against one model. undefined when the model is unpriced. */
export function estimateCostUsd(
  usage: ClaudeUsageInput,
  model: string,
  table: PriceTable
): number | undefined {
  const p = resolvePrice(model, table);
  if (!p) return undefined;
  const perInputTok = p.input / 1_000_000;
  return (
    usage.input * perInputTok +
    usage.output * (p.output / 1_000_000) +
    usage.cacheRead * perInputTok * p.cacheReadMult +
    usage.cacheWrite5m * perInputTok * p.cacheWrite5mMult +
    usage.cacheWrite1h * perInputTok * p.cacheWrite1hMult
  );
}

/** Sum cost across a session's per-model usage. undefined if ANY model is unpriced. */
export function estimateSessionCostUsd(
  perModel: Map<string, ClaudeUsageInput>,
  table: PriceTable
): number | undefined {
  let total = 0;
  for (const [model, usage] of perModel) {
    const c = estimateCostUsd(usage, model, table);
    if (c === undefined) return undefined;
    total += c;
  }
  return total;
}
```

- [ ] **Step 4: Create the hosted JSON artifact**

Create `resources/claude-pricing.json` (must deep-equal `BUNDLED_PRICES`):

```json
{
  "schemaVersion": 1,
  "updated": "2026-06-12",
  "models": [
    { "prefix": "claude-fable-", "input": 10, "output": 50, "cacheReadMult": 0.1, "cacheWrite5mMult": 1.25, "cacheWrite1hMult": 2 },
    { "prefix": "claude-mythos-", "input": 10, "output": 50, "cacheReadMult": 0.1, "cacheWrite5mMult": 1.25, "cacheWrite1hMult": 2 },
    { "prefix": "claude-opus-4-", "input": 5, "output": 25, "cacheReadMult": 0.1, "cacheWrite5mMult": 1.25, "cacheWrite1hMult": 2 },
    { "prefix": "claude-sonnet-4-", "input": 3, "output": 15, "cacheReadMult": 0.1, "cacheWrite5mMult": 1.25, "cacheWrite1hMult": 2 },
    { "prefix": "claude-haiku-4-", "input": 1, "output": 5, "cacheReadMult": 0.1, "cacheWrite5mMult": 1.25, "cacheWrite1hMult": 2 }
  ]
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/shared/__tests__/claude-pricing.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/shared/claude-pricing.ts src/shared/__tests__/claude-pricing.test.ts resources/claude-pricing.json
git commit -m "feat(sessions): claude pricing table + cost math"
```

---

## Task 2: Shared session types

**Files:**
- Modify: `src/shared/sessions.ts:21-32` (extend `SessionSummary`)

- [ ] **Step 1: Add the `ClaudeUsage` type and new `SessionSummary` fields**

In `src/shared/sessions.ts`, replace the `SessionSummary` type (currently lines 21-32) with:

```ts
/** Aggregated Claude token usage for a session (summed across models). */
export type ClaudeUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

export type SessionSummary = {
  agent: SessionAgent;
  id: string;
  title: string;
  project: string; // display name for the cwd group
  cwd: string;
  model?: string;
  provider?: string; // Rune only
  updatedAt: number; // epoch ms
  messageCount: number;
  preview: string;
  // Claude-only cost + metadata (all undefined for Rune and for transcripts without usage):
  costUsd?: number; // undefined when a model in the session is unpriced
  claudeUsage?: ClaudeUsage;
  models?: string[]; // distinct models, first-appearance order
  gitBranch?: string;
  startedAt?: number; // epoch ms of first timestamped entry
  endedAt?: number; // epoch ms of last timestamped entry
};
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS (no usages broken — all new fields are optional).

- [ ] **Step 3: Commit**

```bash
git add src/shared/sessions.ts
git commit -m "feat(sessions): add claude cost/usage fields to SessionSummary"
```

---

## Task 3: Pricing source (fetch + cache, main process)

**Files:**
- Create: `src/main/sessions/pricing-source.ts`
- Test: `src/main/sessions/__tests__/pricing-source.test.ts`

Note: `app` from electron is imported **lazily** (inside `defaultCacheFile()`) so vitest can import this module without an electron stub. `loadCachedTable` / `writeCachedTable` take an explicit path so tests never touch `app`.

- [ ] **Step 1: Write the failing test**

Create `src/main/sessions/__tests__/pricing-source.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_PRICES } from '../../../shared/claude-pricing';
import { parsePriceTable, loadCachedTable, writeCachedTable } from '../pricing-source';

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'fleet-pricing-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parsePriceTable', () => {
  it('accepts a valid table', () => {
    expect(parsePriceTable(JSON.stringify(BUNDLED_PRICES))).toEqual(BUNDLED_PRICES);
  });

  it('rejects malformed JSON', () => {
    expect(parsePriceTable('{not json')).toBeNull();
  });

  it('rejects an unknown schemaVersion', () => {
    const bad = { ...BUNDLED_PRICES, schemaVersion: 2 };
    expect(parsePriceTable(JSON.stringify(bad))).toBeNull();
  });

  it('rejects a missing required field', () => {
    const bad = { schemaVersion: 1, updated: 'x', models: [{ prefix: 'claude-opus-4-', input: 5 }] };
    expect(parsePriceTable(JSON.stringify(bad))).toBeNull();
  });
});

describe('cache round-trip', () => {
  it('writes then reads back the same table', () => {
    const file = join(tmp(), 'claude-pricing.json');
    writeCachedTable(file, BUNDLED_PRICES);
    expect(loadCachedTable(file)).toEqual(BUNDLED_PRICES);
  });

  it('returns null for a missing cache file', () => {
    expect(loadCachedTable(join(tmp(), 'nope.json'))).toBeNull();
  });

  it('returns null for a corrupt cache file', () => {
    const file = join(tmp(), 'claude-pricing.json');
    writeFileSync(file, 'garbage');
    expect(loadCachedTable(file)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/sessions/__tests__/pricing-source.test.ts`
Expected: FAIL — cannot resolve `../pricing-source`.

- [ ] **Step 3: Write the pricing source**

Create `src/main/sessions/pricing-source.ts`:

```ts
// src/main/sessions/pricing-source.ts
// Best-effort remote price table with cache + bundled fallback. Resolution order:
// in-memory current -> userData cache -> BUNDLED_PRICES. Never throws on the read path.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BUNDLED_PRICES, priceTableSchema, type PriceTable } from '../../shared/claude-pricing';

const REMOTE_URL =
  'https://raw.githubusercontent.com/khang859/fleet/main/resources/claude-pricing.json';
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

let currentTable: PriceTable = BUNDLED_PRICES;
let lastFetchAt = 0;
let initialized = false;

/** Parse + validate a JSON string into a PriceTable, or null if invalid. */
export function parsePriceTable(text: string): PriceTable | null {
  try {
    const parsed = priceTableSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Read a cached table from disk. null if missing/corrupt. */
export function loadCachedTable(file: string): PriceTable | null {
  try {
    return parsePriceTable(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Write a table to the cache file (best effort; swallows errors). */
export function writeCachedTable(file: string, table: PriceTable): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(table), 'utf8');
  } catch {
    // best effort
  }
}

async function defaultCacheFile(): Promise<string> {
  // Lazy dynamic import so this module is testable without an electron stub
  // (no `require`, no cast — keeps the repo's no-cast lint rule happy).
  const { app } = await import('electron');
  return join(app.getPath('userData'), 'claude-pricing.json');
}

/** Synchronous accessor used by the list path. */
export function getPriceTable(): PriceTable {
  return currentTable;
}

/**
 * Ensure the in-memory table is reasonably fresh. Fire-and-forget from callers.
 * First call loads the on-disk cache; then a TTL-gated fetch refreshes it.
 */
export async function ensurePricesFresh(now: number = Date.now()): Promise<void> {
  let cacheFile = '';
  try {
    cacheFile = await defaultCacheFile();
  } catch {
    cacheFile = '';
  }

  if (!initialized) {
    initialized = true;
    if (cacheFile) {
      const cached = loadCachedTable(cacheFile);
      if (cached) currentTable = cached;
    }
  }

  if (now - lastFetchAt < TTL_MS) return;
  lastFetchAt = now;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(REMOTE_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const table = parsePriceTable(await res.text());
    if (!table) return;
    currentTable = table;
    if (cacheFile) writeCachedTable(cacheFile, table);
  } catch {
    // offline / timeout / bad response -> keep current table
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/sessions/__tests__/pricing-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/sessions/pricing-source.ts src/main/sessions/__tests__/pricing-source.test.ts
git commit -m "feat(sessions): best-effort remote claude price table with cache fallback"
```

---

## Task 4: Usage aggregation + cost wiring in claude-source

**Files:**
- Modify: `src/main/sessions/claude-source.ts`
- Modify: `src/main/sessions/service.ts:11-14`
- Test: `src/main/sessions/__tests__/claude-source.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/main/sessions/__tests__/claude-source.test.ts`:

```ts
import { aggregateClaudeUsage } from '../claude-source';

function assistantLine(opts: {
  id: string;
  model: string;
  ts?: string;
  branch?: string;
  sidechain?: boolean;
  usage: Record<string, unknown>;
}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `${opts.id}-${Math.random()}`,
    timestamp: opts.ts,
    gitBranch: opts.branch,
    isSidechain: opts.sidechain ?? false,
    message: { id: opts.id, model: opts.model, role: 'assistant', usage: opts.usage }
  });
}

describe('aggregateClaudeUsage', () => {
  it('aggregates tokens, dedups by message.id, splits cache writes', () => {
    const jsonl = [
      assistantLine({
        id: 'msg_1',
        model: 'claude-opus-4-8',
        ts: '2026-05-01T10:00:00Z',
        branch: 'feature/x',
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 50,
          cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 5 }
        }
      }),
      // duplicate message.id (second content-block line) must NOT double-count
      assistantLine({
        id: 'msg_1',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 50,
          cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 5 }
        }
      }),
      assistantLine({
        id: 'msg_2',
        model: 'claude-opus-4-8',
        ts: '2026-05-01T10:05:00Z',
        // no cache_creation object -> cache_creation_input_tokens counts as 5m
        usage: { input_tokens: 200, output_tokens: 20, cache_creation_input_tokens: 8 }
      })
    ].join('\n');

    const agg = aggregateClaudeUsage(jsonl);
    expect(agg.total).toEqual({
      input: 300,
      output: 30,
      cacheRead: 50,
      cacheWrite5m: 28, // 20 + 8
      cacheWrite1h: 5
    });
    expect(agg.models).toEqual(['claude-opus-4-8']);
    expect(agg.gitBranch).toBe('feature/x');
    expect(agg.startedAt).toBe(Date.parse('2026-05-01T10:00:00Z'));
    expect(agg.endedAt).toBe(Date.parse('2026-05-01T10:05:00Z'));
    expect(agg.hasUsage).toBe(true);
    expect(agg.perModel.get('claude-opus-4-8')?.input).toBe(300);
  });

  it('tracks multiple models in first-appearance order and includes sidechains', () => {
    const jsonl = [
      assistantLine({ id: 'a', model: 'claude-opus-4-8', usage: { output_tokens: 10 } }),
      assistantLine({
        id: 'b',
        model: 'claude-haiku-4-5',
        sidechain: true,
        usage: { output_tokens: 4 }
      })
    ].join('\n');
    const agg = aggregateClaudeUsage(jsonl);
    expect(agg.models).toEqual(['claude-opus-4-8', 'claude-haiku-4-5']);
    expect(agg.total.output).toBe(14); // sidechain counted
    expect(agg.perModel.get('claude-haiku-4-5')?.output).toBe(4);
  });

  it('reports hasUsage=false when no assistant usage exists', () => {
    const jsonl = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    const agg = aggregateClaudeUsage(jsonl);
    expect(agg.hasUsage).toBe(false);
    expect(agg.models).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/sessions/__tests__/claude-source.test.ts`
Expected: FAIL — `aggregateClaudeUsage` is not exported.

- [ ] **Step 3: Add aggregation + cost wiring to `claude-source.ts`**

In `src/main/sessions/claude-source.ts`, update the imports at the top (lines 5-13) to:

```ts
import { z } from 'zod';
import { cwdToProjectDir, parseClaudeTranscript } from '../copilot/conversation-reader';
import type { CopilotChatMessage } from '../../shared/types';
import type {
  ClaudeUsage,
  SessionSummary,
  SessionTranscript,
  TranscriptBlock,
  TranscriptMessage
} from '../../shared/sessions';
import type { ClaudeUsageInput } from '../../shared/claude-pricing';
import { estimateSessionCostUsd } from '../../shared/claude-pricing';
import { getPriceTable } from './pricing-source';
```

Then add, immediately after the existing `cwdLineSchema` (after line 15):

```ts
const usageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_creation: z
      .object({
        ephemeral_5m_input_tokens: z.number().optional(),
        ephemeral_1h_input_tokens: z.number().optional()
      })
      .partial()
      .optional()
  })
  .passthrough();

const assistantLineSchema = z
  .object({
    type: z.literal('assistant'),
    timestamp: z.string().optional(),
    gitBranch: z.string().optional(),
    message: z
      .object({
        id: z.string().optional(),
        model: z.string().optional(),
        usage: usageSchema.optional()
      })
      .passthrough()
  })
  .passthrough();

const tsLineSchema = z
  .object({ timestamp: z.string().optional(), gitBranch: z.string().optional() })
  .passthrough();

export type ClaudeAggregate = {
  total: ClaudeUsage;
  perModel: Map<string, ClaudeUsageInput>;
  models: string[];
  gitBranch?: string;
  startedAt?: number;
  endedAt?: number;
  hasUsage: boolean;
};

function emptyUsage(): ClaudeUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

/**
 * Scan raw transcript JSONL and aggregate assistant token usage. Dedups by
 * message.id (Claude Code writes one line per content block, all repeating the
 * same usage object). Sidechain/subagent entries are included — they cost money.
 */
export function aggregateClaudeUsage(content: string): ClaudeAggregate {
  const total = emptyUsage();
  const perModel = new Map<string, ClaudeUsageInput>();
  const models: string[] = [];
  const seenIds = new Set<string>();
  let gitBranch: string | undefined;
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let hasUsage = false;

  for (const line of content.split('\n')) {
    if (!line) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }

    const tsParsed = tsLineSchema.safeParse(json);
    if (tsParsed.success) {
      if (gitBranch === undefined && tsParsed.data.gitBranch) gitBranch = tsParsed.data.gitBranch;
      if (tsParsed.data.timestamp) {
        const t = Date.parse(tsParsed.data.timestamp);
        if (!Number.isNaN(t)) {
          if (startedAt === undefined || t < startedAt) startedAt = t;
          if (endedAt === undefined || t > endedAt) endedAt = t;
        }
      }
    }

    const parsed = assistantLineSchema.safeParse(json);
    if (!parsed.success) continue;
    const { message } = parsed.data;
    const u = message.usage;
    if (!u) continue;
    const id = message.id;
    if (id && seenIds.has(id)) continue; // dedup repeated content-block lines
    if (id) seenIds.add(id);

    const model = message.model ?? '';
    if (model && !models.includes(model)) models.push(model);

    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    let write5m = 0;
    let write1h = 0;
    if (u.cache_creation) {
      write5m = u.cache_creation.ephemeral_5m_input_tokens ?? 0;
      write1h = u.cache_creation.ephemeral_1h_input_tokens ?? 0;
    } else {
      write5m = u.cache_creation_input_tokens ?? 0;
    }

    if (input || output || cacheRead || write5m || write1h) hasUsage = true;

    total.input += input;
    total.output += output;
    total.cacheRead += cacheRead;
    total.cacheWrite5m += write5m;
    total.cacheWrite1h += write1h;

    const bucket = perModel.get(model) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0
    };
    bucket.input += input;
    bucket.output += output;
    bucket.cacheRead += cacheRead;
    bucket.cacheWrite5m += write5m;
    bucket.cacheWrite1h += write1h;
    perModel.set(model, bucket);
  }

  return { total, perModel, models, gitBranch, startedAt, endedAt, hasUsage };
}

/** Build the Claude-only cost/metadata fields for a SessionSummary. */
function claudeCostFields(content: string): Partial<SessionSummary> {
  const agg = aggregateClaudeUsage(content);
  if (!agg.hasUsage) return {};
  return {
    claudeUsage: agg.total,
    models: agg.models,
    gitBranch: agg.gitBranch,
    startedAt: agg.startedAt,
    endedAt: agg.endedAt,
    costUsd: estimateSessionCostUsd(agg.perModel, getPriceTable())
  };
}
```

Now wire it into the list path. In `listClaudeSessions`, replace the `out.push({...})` block (currently lines 69-78) with:

```ts
        out.push({
          agent: 'claude',
          id,
          title: preview || '(untitled)',
          project: basename(cwd),
          cwd,
          updatedAt: st.mtimeMs,
          messageCount: messages.length,
          preview: preview.slice(0, 140),
          ...claudeCostFields(content)
        });
```

And into the read path. In `readClaudeSession`, replace the `summary: {...}` block (currently lines 105-114) with:

```ts
    summary: {
      agent: 'claude',
      id,
      title: preview || '(untitled)',
      project: basename(cwd),
      cwd,
      updatedAt,
      messageCount: messages.length,
      preview: preview.slice(0, 140),
      ...claudeCostFields(content)
    },
```

- [ ] **Step 4: Trigger a background price refresh on list**

In `src/main/sessions/service.ts`, add the import (after line 5):

```ts
import { ensurePricesFresh } from './pricing-source';
```

Then change `list()` (currently lines 11-14) to kick off a fire-and-forget refresh:

```ts
  async list(): Promise<SessionSummary[]> {
    void ensurePricesFresh(); // best-effort; next list reflects any update
    const [rune, claude] = await Promise.all([listRuneSessions(), listClaudeSessions()]);
    return [...rune, ...claude].sort((a, b) => b.updatedAt - a.updatedAt);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/sessions/__tests__/claude-source.test.ts`
Expected: PASS (new aggregation tests + existing tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/sessions/claude-source.ts src/main/sessions/service.ts src/main/sessions/__tests__/claude-source.test.ts
git commit -m "feat(sessions): aggregate claude usage and estimate session cost"
```

---

## Task 5: Cost badge in the session list

**Files:**
- Modify: `src/renderer/src/components/sessions/SessionList.tsx`

- [ ] **Step 1: Add a cost formatter**

In `src/renderer/src/components/sessions/SessionList.tsx`, add after `relativeTime` (after line 32):

```ts
function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
```

- [ ] **Step 2: Render the badge on the meta row**

Replace the meta-row block (currently lines 103-107) with:

```tsx
                    <div className="flex items-center gap-2 text-[10px] text-fleet-text-subtle">
                      <span className="rounded bg-fleet-surface-2 px-1">{s.agent}</span>
                      {s.model && <span className="truncate">{s.model}</span>}
                      <span>· {s.messageCount} msgs</span>
                      {s.agent === 'claude' && (
                        <span className="ml-auto flex-shrink-0 font-mono text-fleet-text">
                          {s.costUsd === undefined ? '—' : formatCost(s.costUsd)}
                        </span>
                      )}
                    </div>
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/sessions/SessionList.tsx
git commit -m "feat(sessions): cost badge on claude session rows"
```

---

## Task 6: Metadata strip in the transcript header

**Files:**
- Modify: `src/renderer/src/components/sessions/TranscriptView.tsx`

- [ ] **Step 1: Add formatting helpers**

In `src/renderer/src/components/sessions/TranscriptView.tsx`, add after `resumeCommand` (after line 16):

```ts
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function ClaudeMetaStrip({ s }: { s: SessionSummary }): React.JSX.Element | null {
  if (s.agent !== 'claude') return null;
  const u = s.claudeUsage;
  const hasMeta = u || s.gitBranch || s.startedAt || (s.models && s.models.length > 0);
  if (!hasMeta) return null;
  const cacheWrite = u ? u.cacheWrite5m + u.cacheWrite1h : 0;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fleet-text-subtle">
      {s.models?.map((m) => (
        <span key={m} className="rounded bg-fleet-surface-2 px-1 font-mono text-fleet-text">
          {m}
        </span>
      ))}
      {u && (
        <span className="font-mono" title="input / output / cache-read / cache-write tokens">
          ↑{formatTokens(u.input)} ↓{formatTokens(u.output)} ⚡{formatTokens(u.cacheRead)} ✎
          {formatTokens(cacheWrite)}
        </span>
      )}
      <span
        className="font-mono text-fleet-text"
        title="estimated from token counts × public per-model pricing"
      >
        {s.costUsd === undefined ? 'cost unavailable' : formatCost(s.costUsd)}
      </span>
      {s.gitBranch && <span className="truncate">⎇ {s.gitBranch}</span>}
      {s.startedAt && s.endedAt && (
        <span title="session start → end">
          {formatClock(s.startedAt)} → {formatClock(s.endedAt)} ·{' '}
          {formatDuration(s.endedAt - s.startedAt)}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Render the strip in the header**

Replace the header title block (currently lines 134-140) with:

```tsx
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-fleet-text">{s.title}</div>
          <div className="text-xs text-fleet-text-subtle">
            {s.agent} {s.provider ? `· ${s.provider}` : ''} {s.model ? `· ${s.model}` : ''} ·{' '}
            {messages.length} msgs
          </div>
          <ClaudeMetaStrip s={s} />
        </div>
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/sessions/TranscriptView.tsx
git commit -m "feat(sessions): claude metadata strip in transcript header"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm run test`
Expected: PASS (all suites, including the three new/extended files).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: No new errors in the files touched by this plan. (The repo lint baseline may already be red — confirm none of the new findings are in `claude-pricing.ts`, `pricing-source.ts`, `claude-source.ts`, `service.ts`, `SessionList.tsx`, `TranscriptView.tsx`.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS (typecheck + electron-vite build succeed).

- [ ] **Step 5: Final commit (if lint auto-fixed anything)**

```bash
git add -A
git commit -m "chore(sessions): lint/format cost estimator" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** three-tier pricing (Tasks 1+3), prefix matching + unknown→`—` (Task 1, UI Tasks 5/6), `message.id` dedup (Task 4 test), 5m/1h cache split + fallback (Task 4), sidechains included (Task 4 test), multi-model handling (Task 1 `estimateSessionCostUsd` + Task 4), metadata strip + list badge (Tasks 5/6), raw.githubusercontent fetch with cache + bundled fallback (Task 3), bundled/JSON sync guard (Task 1). All covered.
- **Decisions honored:** JSON at `resources/claude-pricing.json`, fetched from `raw.githubusercontent.com/khang859/fleet/main/resources/claude-pricing.json`; no Opus 4.0/4.1 overrides (the `claude-opus-4-` prefix intentionally covers all Opus 4.x at $5/$25).
- **Type consistency:** `ClaudeUsage` (shared/sessions) and `ClaudeUsageInput` (shared/claude-pricing) are structurally identical; `aggregateClaudeUsage` returns `total: ClaudeUsage` and `perModel: Map<string, ClaudeUsageInput>` — both consumed correctly by `estimateSessionCostUsd`. `getPriceTable`/`ensurePricesFresh` names match across pricing-source, claude-source, and service.
```
