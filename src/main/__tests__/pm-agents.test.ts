import { describe, it, expect } from 'vitest';
import { buildPmAgentsMd } from '../kanban/pm-agents';
import type { Project } from '../../shared/kanban-types';

const proj = (over: Partial<Project>): Project => ({
  id: 'p1',
  boardId: 'default',
  name: 'fleet',
  path: '/Users/me/fleet',
  description: null,
  verifyCommands: [],
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
