import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../../../shared/workflows';
import { ToolRefused } from '../bridge-routes';
import { itemMarker, type Exec } from '../pr';
import { WorkflowPosting } from '../posting';
import {
  flush,
  makeDef,
  makeHarness,
  makePlan,
  SAMPLE_PR,
  sessionsUp,
  startRun,
  type Harness
} from './helpers';

describe('WorkflowPosting', () => {
  let dir: string;
  let h: Harness;
  let run: WorkflowRun;
  let comments: Array<{ number: string; body: string | undefined }>;
  let existing: string;
  let failing: boolean;
  let posting: WorkflowPosting;

  /** Plays `gh`: it records each comment and lists what is on the PR. */
  const exec: Exec = async (_command, args, _cwd, input) => {
    if (args[0] === 'api') return Promise.resolve(existing);
    if (failing) return Promise.reject(new Error('gh failed'));
    comments.push({ number: args[2], body: input });
    return Promise.resolve('');
  };

  function addItems(...texts: string[]): void {
    for (const text of texts) {
      h.manager.addFinding(run.id, run.agents[0].id, { kind: 'bug', text, file: `${text}.ts` });
    }
  }

  async function refusalOf(action: Promise<unknown>): Promise<string> {
    const error: unknown = await action.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ToolRefused);
    return (error as ToolRefused).code;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-wf-posting-'));
    comments = [];
    existing = '';
    failing = false;
    h = makeHarness(dir);
    const def = makeDef({ workspace: 'pr-worktree' });
    run = await startRun(h, makePlan(def, { pr: SAMPLE_PR }));
    sessionsUp(h, run);
    posting = new WorkflowPosting({
      runs: h.manager,
      store: h.deps.store,
      exec,
      devExtension: null
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('start', () => {
    it('opens a post pane with the ids left to post', async () => {
      addItems('one', 'two');

      expect(await posting.start(run.id)).toBe(2);
      await flush();

      expect(run.postPaneId).not.toBeNull();
      expect(h.manager.identify(run.postPaneId ?? '')).toEqual({
        kind: 'post',
        runId: run.id,
        agentId: null
      });
      expect(h.opened.at(-1)?.line).toContain(`'--tools' 'fleet_post_item'`);
    });

    it('opens nothing with nothing to post', async () => {
      expect(await posting.start(run.id)).toBe(0);
      expect(run.postPaneId).toBeNull();
    });

    it('refuses a run with no PR', async () => {
      const plain = await startRun(h, makePlan(makeDef(), { target: 'other' }));

      expect(await refusalOf(posting.start(plain.id))).toBe('no-pr');
    });

    it('refuses a run that is gone', async () => {
      expect(await refusalOf(posting.start('gone'))).toBe('not-found');
    });

    it('settles a posting item from the PR comments', async () => {
      addItems('one', 'two');
      h.manager.markPost(run.id, '1', 'posting');
      h.manager.markPost(run.id, '2', 'posting');
      existing = `Looks good.\n${itemMarker(run.id, '1')}\n`;

      expect(await posting.start(run.id)).toBe(1);

      expect(run.board.map((item) => item.post)).toEqual(['posted', 'failed']);
      expect(h.deps.store.loadBoard(run.id).map((item) => item.post)).toEqual(['posted', 'failed']);
    });

    it('never offers a merged item', () => {
      addItems('one', 'two');
      h.manager.mergeFindings(run.id, run.agents[0].id, ['1', '2'], { kind: 'bug', text: 'both' });

      expect(posting.remaining(run).map((item) => item.id)).toEqual(['3']);
    });
  });

  describe('postItem', () => {
    it('refuses an id nobody confirmed', async () => {
      addItems('one');

      expect(await refusalOf(posting.postItem(run.id, '1'))).toBe('not-allowed');
      expect(comments).toEqual([]);
    });

    it('refuses an id added after the confirm', async () => {
      addItems('one');
      await posting.start(run.id);
      addItems('two');

      expect(await refusalOf(posting.postItem(run.id, '2'))).toBe('not-allowed');
    });

    it('posts the stored text with a hidden mark', async () => {
      addItems('one');
      await posting.start(run.id);

      expect(await posting.postItem(run.id, '1')).toEqual({ posted: '1' });

      expect(comments).toHaveLength(1);
      expect(comments[0].number).toBe('7');
      expect(comments[0].body).toContain('**bug** `one.ts`');
      expect(comments[0].body).toContain(itemMarker(run.id, '1'));
      expect(run.board[0].post).toBe('posted');
    });

    it('never posts an item twice', async () => {
      addItems('one');
      await posting.start(run.id);

      await posting.postItem(run.id, '1');
      await posting.postItem(run.id, '1');

      expect(comments).toHaveLength(1);
    });

    it('never posts an item twice at once', async () => {
      addItems('one');
      await posting.start(run.id);

      await Promise.allSettled([posting.postItem(run.id, '1'), posting.postItem(run.id, '1')]);

      expect(comments).toHaveLength(1);
      expect(run.board[0].post).toBe('posted');
    });

    it('never offers a posted item again', async () => {
      addItems('one', 'two');
      await posting.start(run.id);
      await posting.postItem(run.id, '1');

      expect(posting.remaining(run).map((item) => item.id)).toEqual(['2']);
    });

    it('marks a failed post and offers it again', async () => {
      addItems('one');
      await posting.start(run.id);
      failing = true;

      expect(await refusalOf(posting.postItem(run.id, '1'))).toBe('post-failed');

      expect(run.board[0].post).toBe('failed');
      expect(posting.remaining(run)).toHaveLength(1);
    });

    it('keeps the posted mark on disk', async () => {
      addItems('one');
      await posting.start(run.id);

      await posting.postItem(run.id, '1');

      expect(h.deps.store.loadBoard(run.id)[0].post).toBe('posted');
    });
  });
});
