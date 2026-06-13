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
    // offline / timeout / bad response -> keep current table; allow retry next list()
    lastFetchAt = 0;
  }
}
