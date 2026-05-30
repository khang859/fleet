import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';

const TEST_DIR = join(tmpdir(), `fleet-kanban-store-test-${Date.now()}`);
const DB_PATH = join(TEST_DIR, 'kanban.db');

describe('KanbanStore', () => {
  let store: KanbanStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new KanbanStore(DB_PATH);
  });

  afterEach(() => {
    store.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates the db file and runs migrations', () => {
    expect(existsSync(DB_PATH)).toBe(true);
    expect(store.schemaVersion()).toBe(1);
  });
});
