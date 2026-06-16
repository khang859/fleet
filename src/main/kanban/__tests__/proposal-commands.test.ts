import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban-store';
import { KanbanDispatcher } from '../kanban-dispatcher';
import { KanbanCommands } from '../kanban-commands';

const TEST_DIR = join(tmpdir(), `fleet-kanban-proposals-${process.pid}`);

function makeCommands(): { store: KanbanStore; commands: KanbanCommands } {
  const store = new KanbanStore(join(TEST_DIR, `prop-${Math.random().toString(36).slice(2)}.db`));
  const dispatcher = new KanbanDispatcher(store, {
    now: () => 0,
    isAlive: () => true,
    spawnWorker: () => undefined,
    config: {
      failureLimit: 2,
      claimGraceMs: 0,
      maxInProgress: 3,
      claimTtlMs: 1000,
      autoDecompose: false,
      autoAssign: false,
      autoIntegrate: false,
      autoReview: false,
      maxDecompose: 1,
      artifactRetentionDays: 0
    }
  });
  const commands = new KanbanCommands(store, dispatcher, () => ({
    workspaceKind: 'scratch',
    maxRuntimeSeconds: null
  }));
  return { store, commands };
}

describe('KanbanCommands proposals approve/dismiss guards', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('rejects approving an already-resolved proposal', () => {
    const { commands } = makeCommands();
    const task = commands.create({ title: 'done me' });
    const proposal = commands.proposeAction('default', 'complete_task', task.id, 'finish it');
    // first approve resolves it (complete on a non-running task succeeds)
    expect(commands.approveProposal(proposal.id).status).toBe('accepted');
    // second approve must be refused
    expect(() => commands.approveProposal(proposal.id)).toThrow(/already resolved/);
  });

  it('dismiss after resolution is a no-op (preserves accepted status)', () => {
    const { store, commands } = makeCommands();
    const task = commands.create({ title: 'keep history' });
    const proposal = commands.proposeAction('default', 'complete_task', task.id, 'finish it');
    store.resolveProposal(proposal.id, 'accepted', null);
    commands.dismissProposal(proposal.id);
    expect(store.getProposal(proposal.id)?.status).toBe('accepted');
  });

  it('marks the proposal failed (without throwing) when the command fails', () => {
    const { commands } = makeCommands();
    // a scratch task can never enter review, so mergeReviewTask throws → funnel to 'failed'
    const task = commands.create({ title: 'not in review' });
    const proposal = commands.proposeAction('default', 'merge_review_task', task.id, 'merge it');
    const after = commands.approveProposal(proposal.id);
    expect(after.status).toBe('failed');
    expect(after.error).toBeTruthy();
  });
});
