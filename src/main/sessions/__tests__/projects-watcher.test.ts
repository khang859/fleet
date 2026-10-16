import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectsWatcher } from '../projects-watcher';

const TIMING = { debounceMs: 50, maxWaitMs: 200 };

let root = '';
let watcher: ProjectsWatcher | null = null;
const onChange = vi.fn();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-projects-'));
  onChange.mockReset();
});

afterEach(() => {
  watcher?.dispose();
  watcher = null;
  rmSync(root, { recursive: true, force: true });
});

const sleep = async (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Start watching, and let the events macOS replays for dirs just made pass. */
async function watchQuietly(): Promise<void> {
  watcher = new ProjectsWatcher(root, onChange, TIMING);
  await sleep(500);
  onChange.mockClear();
}

/** Resolves on the next change reported. */
async function nextChange(): Promise<void> {
  const calls = onChange.mock.calls.length;
  await vi.waitFor(() => expect(onChange.mock.calls.length).toBeGreaterThan(calls), {
    timeout: 3000
  });
}

describe('ProjectsWatcher', () => {
  it('reports a write to a transcript in a project dir', async () => {
    const project = join(root, 'proj');
    mkdirSync(project);
    writeFileSync(join(project, 'sess.jsonl'), '{}\n');
    await watchQuietly();
    appendFileSync(join(project, 'sess.jsonl'), '{}\n');
    await nextChange();
  });

  it('watches a project dir made after watching began', async () => {
    await watchQuietly();
    const project = join(root, 'later');
    mkdirSync(project);
    await nextChange();
    writeFileSync(join(project, 'sess.jsonl'), '{}\n');
    await nextChange();
  });

  it('ignores files in a session folder', async () => {
    const project = join(root, 'proj');
    mkdirSync(join(project, 'sess', 'subagents'), { recursive: true });
    await watchQuietly();
    writeFileSync(join(project, 'sess', 'subagents', 'agent-a.jsonl'), '{}\n');
    writeFileSync(join(project, 'notes.txt'), 'x');
    await sleep(300);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports during a stream of writes that never goes quiet', async () => {
    const project = join(root, 'proj');
    mkdirSync(project);
    await watchQuietly();
    watcher?.dispose();
    // The quiet time is longer than the gaps between writes, and than the
    // batching macOS does, so only the cap can report before the stream ends.
    watcher = new ProjectsWatcher(root, onChange, { debounceMs: 400, maxWaitMs: 500 });
    await sleep(200);
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      appendFileSync(join(project, 'sess.jsonl'), '{}\n');
      await sleep(20);
    }
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does nothing when the root does not exist', async () => {
    watcher = new ProjectsWatcher(join(root, 'missing'), onChange, TIMING);
    await sleep(100);
    expect(onChange).not.toHaveBeenCalled();
  });
});
