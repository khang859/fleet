import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetLedgerStore, type FleetCursor } from '../ledger-store';

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

const THREAD = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const cursor = (rev: number): FleetCursor => ({ sessionId: 's', epoch: 0, rev, turn: 1 });

describe('FleetLedgerStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-ledger-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps cursors across a restart, next to the session log', () => {
    new FleetLedgerStore(dir).setCursor(THREAD, 'abcdef12', cursor(4));
    expect(readdirSync(dir)).toEqual([`${THREAD}.fleet.json`]);
    expect(new FleetLedgerStore(dir).cursor(THREAD, 'abcdef12')).toEqual(cursor(4));
  });

  it('starts over from a damaged file rather than failing', () => {
    writeFileSync(join(dir, `${THREAD}.fleet.json`), '{not json');
    const store = new FleetLedgerStore(dir);
    expect(store.cursor(THREAD, 'abcdef12')).toBeNull();
    store.setCursor(THREAD, 'abcdef12', cursor(1));
    expect(new FleetLedgerStore(dir).cursor(THREAD, 'abcdef12')).toEqual(cursor(1));
  });

  it('writes nothing for an id that is not a uuid', () => {
    const store = new FleetLedgerStore(dir);
    store.setCursor('../../escape', 'abcdef12', cursor(2));
    expect(store.cursor('../../escape', 'abcdef12')).toEqual(cursor(2));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is deleted with the session', () => {
    const store = new FleetLedgerStore(dir);
    store.setCursor(THREAD, 'abcdef12', cursor(3));
    store.delete(THREAD);
    expect(existsSync(join(dir, `${THREAD}.fleet.json`))).toBe(false);
    expect(store.cursor(THREAD, 'abcdef12')).toBeNull();
  });

  it('keeps the most recently read sessions when it is full', () => {
    const store = new FleetLedgerStore(dir);
    for (let i = 0; i < 105; i++) store.setCursor(THREAD, `ref-${i}`, cursor(i));
    expect(store.cursor(THREAD, 'ref-4')).toBeNull();
    // Read again, so it is the newest and ref-6 is next to go.
    store.setCursor(THREAD, 'ref-5', cursor(99));
    store.setCursor(THREAD, 'ref-105', cursor(105));
    const reloaded = new FleetLedgerStore(dir);
    expect(reloaded.cursor(THREAD, 'ref-6')).toBeNull();
    expect(reloaded.cursor(THREAD, 'ref-5')).toEqual(cursor(99));
    expect(reloaded.cursor(THREAD, 'ref-105')).toEqual(cursor(105));
  });
});
