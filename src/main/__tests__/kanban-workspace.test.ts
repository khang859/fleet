import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { prepareWorkspace, cleanupWorkspace } from '../kanban/workspace';

const ROOT = join(tmpdir(), `fleet-kanban-ws-test-${Date.now()}`);

describe('kanban workspace', () => {
  beforeEach(() => mkdirSync(ROOT, { recursive: true }));
  afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

  it('creates a scratch dir under the root', () => {
    const path = prepareWorkspace({ kind: 'scratch', taskId: 'abc', workspacesRoot: ROOT });
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(ROOT)).toBe(true);
  });

  it('cleans up a scratch dir', () => {
    const path = prepareWorkspace({ kind: 'scratch', taskId: 'abc', workspacesRoot: ROOT });
    cleanupWorkspace({ kind: 'scratch', path });
    expect(existsSync(path)).toBe(false);
  });

  it('does not delete a dir-kind workspace on cleanup', () => {
    const keep = join(ROOT, 'keep');
    mkdirSync(keep);
    cleanupWorkspace({ kind: 'dir', path: keep });
    expect(existsSync(keep)).toBe(true);
  });
});
