import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CrewRuntime } from '../../../../shared/agency-crew';
import { TEST_PROMPT, testRuntime, type RuntimeTestDeps, type TestEvent } from '../runtime-test';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-runtime-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A terminal that sends `events` once it starts, as hook events reach Fleet,
 * or fails to start with `refuse`.
 */
function deps(
  events: Array<Omit<TestEvent, 'paneId'>>,
  opts: { refuse?: string; readable?: boolean; evaHook?: string } = {}
): RuntimeTestDeps & { spawned: Array<{ cmd: string; env: Record<string, string> }> } {
  const listeners = new Set<(e: TestEvent) => void>();
  const spawned: Array<{ cmd: string; env: Record<string, string> }> = [];
  let ids = 0;
  let clock = 1_000;
  return {
    spawned,
    spawn: async (pane) => {
      spawned.push({ cmd: pane.cmd, env: pane.env });
      if (opts.refuse) return Promise.resolve(opts.refuse);
      // Another pane's events are not the test's.
      queueMicrotask(() => {
        for (const l of listeners) l({ paneId: 'other', event: 'Stop', transcriptPath: null });
        clock += 1_500;
        for (const e of events) for (const l of listeners) l({ paneId: pane.paneId, ...e });
      });
      return Promise.resolve(null);
    },
    kill: vi.fn(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readable: vi.fn().mockResolvedValue(opts.readable ?? true),
    hooks: () => ({}),
    evaHook: async () => Promise.resolve(opts.evaHook),
    dir,
    now: () => clock,
    newId: () => `id-${++ids}`,
    waits: { firstEventMs: 50, turnMs: 100 }
  };
}

const run = async (runtime: CrewRuntime, d: RuntimeTestDeps, model?: string) =>
  testRuntime(runtime, '/repo', model, d);

describe('testRuntime', () => {
  it('reports each thing that reached Fleet for Claude Code, then ends the terminal', async () => {
    const d = deps([
      { event: 'SessionStart', transcriptPath: '/t.jsonl' },
      { event: 'Stop', transcriptPath: '/t.jsonl' }
    ]);

    const out = await run('claude', d, 'sonnet');

    expect(out).toEqual({
      ok: true,
      rows: [
        {
          what: 'Claude Code started in a hidden pane',
          ok: true,
          detail: 'First event after 1.5s'
        },
        { what: 'Hook events reach Fleet', ok: true, detail: 'SessionStart, Stop' },
        { what: 'The turn ended', ok: true, detail: 'Stop' },
        { what: 'Transcript can be read', ok: true, detail: 'JSONL' }
      ]
    });
    expect(d.readable).toHaveBeenCalledWith('/t.jsonl');
    expect(d.kill).toHaveBeenCalledWith('id-1');
    expect(d.spawned[0].cmd).toContain('--permission-mode default');
    expect(d.spawned[0].cmd).toContain('--model');
    expect(d.spawned[0].env).toMatchObject({ FLEET_SPAWN_PROMPT: TEST_PROMPT });
  });

  it('starts eva with no question tool, and reports no transcript row', async () => {
    const d = deps([
      { event: 'SessionStart', transcriptPath: null },
      { event: 'Stop', transcriptPath: null }
    ]);

    const out = await run('eva', d, 'qwen/qwen3-coder');

    expect(out.ok && out.rows.map((r) => r.what)).toEqual([
      'eva started in a hidden pane',
      'Hook events reach Fleet',
      'The turn ended'
    ]);
    expect(d.spawned[0].cmd).toContain('--no-ask-user');
    expect(d.spawned[0].cmd).not.toContain(' -b');
    expect(d.spawned[0].env).toMatchObject({ CHAT_MODEL: 'qwen/qwen3-coder' });
  });

  it('says why when no event comes, and still ends the terminal', async () => {
    const d = deps([]);

    const out = await run('claude', d);

    expect(out.ok).toBe(true);
    const rows = out.ok ? out.rows : [];
    expect(rows[0]).toMatchObject({ ok: true, detail: 'Its terminal started' });
    expect(rows[1]).toMatchObject({ ok: false });
    expect(rows[1].detail).toContain('folder trust prompt for /repo');
    expect(rows[2]).toEqual({ what: 'The turn ended', ok: false, detail: 'No Stop event' });
    expect(rows[3]).toMatchObject({ ok: false, detail: 'Not reported, or not found' });
    expect(d.kill).toHaveBeenCalled();
  });

  it("starts eva with Fleet's hooks file when it takes one, and says why an eva is silent", async () => {
    const hooked = deps([], { evaHook: "'/h/fleet-hook'" });
    const out = await run('eva', hooked);
    expect(hooked.spawned[0].cmd).toContain('--hooks "$FLEET_CREW_HOOKS"');
    expect(out.ok && out.rows[1].detail).toBe(
      'No event came. eva may be waiting at a prompt in its pane.'
    );

    const old = deps([]);
    const silent = await run('eva', old);
    expect(old.spawned[0].cmd).not.toContain('--hooks');
    expect(silent.ok && silent.rows[1].detail).toContain('This eva cannot take a hooks file');
  });

  it('reports a turn that stopped on an error', async () => {
    const d = deps([{ event: 'StopFailure', transcriptPath: null, error: 'rate_limit' }]);

    const out = await run('eva', d);

    expect(out.ok && out.rows[2]).toEqual({
      what: 'The turn ended',
      ok: false,
      detail: 'Stopped on an error: rate_limit'
    });
  });

  it('gives the reason when the terminal does not start', async () => {
    const d = deps([], { refuse: 'claude: command not found' });

    expect(await run('claude', d)).toEqual({ ok: false, reason: 'claude: command not found' });
    expect(d.kill).toHaveBeenCalled();
  });

  it('writes its launch files in its own folder', async () => {
    await run('claude', deps([{ event: 'Stop', transcriptPath: null }]));
    const files = readdirSync(dir, { recursive: true }).map(String);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      expect(() => JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown).not.toThrow();
    }
  });
});
