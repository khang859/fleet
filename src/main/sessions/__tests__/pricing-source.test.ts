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
    const bad = {
      schemaVersion: 1,
      updated: 'x',
      models: [{ prefix: 'claude-opus-4-', input: 5 }]
    };
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
