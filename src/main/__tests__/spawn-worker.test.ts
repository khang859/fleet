import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildWorkerInvocation } from '../kanban/spawn-worker';

function ws(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-spawn-'));
}
const baseTask = {
  id: 't1',
  title: 'Add billing',
  body: 'body',
  assignee: 'explorer',
  modelOverride: null
};

describe('buildWorkerInvocation explore mode', () => {
  it('emits a read-only mapping prompt and complete/block require-tool', () => {
    const inv = buildWorkerInvocation({
      task: baseTask,
      workspace: ws(),
      mcpPort: 1,
      runToken: 'tok',
      logPath: '/tmp/x.log',
      mode: 'explore'
    });
    const prompt = inv.args[inv.args.indexOf('--prompt') + 1];
    expect(prompt).toContain('explore kanban task t1');
    expect(prompt).toContain('Write NO code');
    expect(prompt).toContain('kanban_artifact');
    expect(inv.args[inv.args.indexOf('--require-tool') + 1]).toBe('kanban_complete,kanban_block');
  });
});
