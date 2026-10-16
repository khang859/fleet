import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionSummary } from '../../../shared/sessions';

const source = vi.hoisted(() => ({
  list: vi.fn<() => Promise<SessionSummary[]>>()
}));
vi.mock('../claude-source', () => ({
  claudeProjectsDir: () => '/nonexistent',
  listClaudeSessions: source.list,
  readClaudeSession: vi.fn()
}));
vi.mock('../pricing-source', () => ({ ensurePricesFresh: vi.fn() }));

import { SessionsService } from '../service';

let service: SessionsService;

beforeEach(() => {
  source.list.mockReset();
  service = new SessionsService();
});

function summary(id: string, updatedAt: number): SessionSummary {
  return { id, title: id, project: 'p', cwd: '/p', updatedAt, messageCount: 1, preview: id };
}

describe('SessionsService.list', () => {
  it('sorts newest first', async () => {
    source.list.mockResolvedValue([summary('old', 1), summary('new', 2)]);
    expect((await service.list()).map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('runs one more list for any number of calls made while one runs', async () => {
    let finish: (v: SessionSummary[]) => void = () => undefined;
    source.list.mockImplementationOnce(async () => new Promise((r) => (finish = r)));
    source.list.mockResolvedValue([summary('after', 2)]);
    const first = service.list();
    const queued = [service.list(), service.list(), service.list()];
    finish([summary('before', 1)]);
    expect((await first)[0].id).toBe('before');
    for (const later of await Promise.all(queued)) expect(later[0].id).toBe('after');
    expect(source.list).toHaveBeenCalledTimes(2);
  });
});
