import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { KanbanStore } from '../kanban-store';

function makeStore(now = () => 5000): KanbanStore {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-digest-cfg-'));
  return new KanbanStore(join(dir, 'kanban.db'), { now });
}

describe('board digest config', () => {
  it('defaults to no cron and no watermark', () => {
    const store = makeStore();
    const slug = store.createBoard('b1').slug;
    expect(store.getDigestConfig(slug)).toEqual({ digestCron: null, lastDigestAt: null });
  });

  it('sets the cron and stamps the watermark', () => {
    const store = makeStore();
    const slug = store.createBoard('b1').slug;
    store.setDigestCron(slug, '0 9 * * *');
    expect(store.getDigestConfig(slug).digestCron).toBe('0 9 * * *');
    store.stampLastDigest(slug);
    expect(store.getDigestConfig(slug).lastDigestAt).toBe(5000);
  });
});
