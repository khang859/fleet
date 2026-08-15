import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKGROUND_MAX_JOBS,
  type AgentToolContext,
  type AgentToolResult
} from '../../../../shared/agent-tools';
import { runAgentTool } from '../run';
import { killAllBackgroundCommands, killThreadBackgroundCommands } from '../background';

/**
 * Commands that outlive their turn, against real processes.
 *
 * The interesting assertions are all about a process nobody is holding on to
 * any more: one conversation reaching another's, a slot that a finished command
 * gives back and a running one does not, and the two ways everything gets
 * killed. Those are the failures that do not announce themselves - a leaked
 * `sleep` is invisible until the machine is full of them - so they are the ones
 * worth a test.
 */

let dir: string;
let approved: boolean;

const ctx = (threadId = 'thread-1'): AgentToolContext => ({
  cwd: dir,
  threadId,
  signal: new AbortController().signal,
  handOff: () => {},
  approve: async () => Promise.resolve(approved),
  wasRefused: () => false,
  generateImage: null,
  fetchUrl: null,
  mcp: null,
  dispatchTask: null,
  findSubagent: null,
  findSkill: null,
  findMemory: null,
  schedule: null,
  todos: { list: () => [], save: () => {} }
});

const runIn = async (threadId: string, name: string, args: object): Promise<AgentToolResult> =>
  runAgentTool(name, JSON.stringify(args), ctx(threadId));

const run = async (name: string, args: object): Promise<AgentToolResult> =>
  runIn('thread-1', name, args);

/** Start one and hand back the id the result named. */
const start = async (command: string, threadId = 'thread-1'): Promise<string> => {
  const { text } = await runIn(threadId, 'bash', { command, background: true });
  const id = /\bbg_\d+\b/.exec(text)?.[0];
  if (id === undefined) throw new Error(`no id in: ${text}`);
  return id;
};

/**
 * Read until the output says something, or give up.
 *
 * A process writes when it is ready rather than when the test asks, so a single
 * read right after starting one is a coin toss. Polling is what a model does
 * with this tool too, which makes it the honest thing to test against.
 */
const until = async (
  id: string,
  matches: (result: AgentToolResult) => boolean
): Promise<AgentToolResult> => {
  for (let i = 0; i < 100; i++) {
    const result = await run('bash_output', { id });
    if (matches(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${id} never got there`);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agent-background-'));
  approved = true;
});

afterEach(() => {
  killAllBackgroundCommands();
  rmSync(dir, { recursive: true, force: true });
});

describe('starting one', () => {
  it('returns an id straight away rather than the output', async () => {
    const { text, summary } = await run('bash', { command: 'echo hello', background: true });

    expect(text).toMatch(/Started in the background as bg_1/);
    expect(text).not.toContain('hello');
    expect(summary).toBe('bg_1 started');
  });

  it('asks permission first, and starts nothing when told no', async () => {
    approved = false;

    const { text, summary } = await run('bash', { command: 'echo hello', background: true });

    expect(summary).toBe('not allowed');
    await expect(run('bash_output', { id: 'bg_1' })).rejects.toThrow(/no background command/);
    expect(text).toContain('did not allow');
  });

  it('counts ids up within a conversation', async () => {
    expect(await start('sleep 30')).toBe('bg_1');
    expect(await start('sleep 30')).toBe('bg_2');
  });
});

describe('reading one', () => {
  it('hands over what it has printed, and only once', async () => {
    const id = await start('echo one; sleep 30');

    const first = await until(id, (r) => r.text.includes('one'));
    expect(first.text).toContain('is still running');

    const second = await run('bash_output', { id });
    expect(second.text).toContain('Nothing new since you last looked');
    expect(second.summary).toBe('running, nothing new');
  });

  it('says how a finished command ended, and keeps its last output', async () => {
    const id = await start('echo done; exit 3');

    const result = await until(id, (r) => r.text.includes('exit status'));

    expect(result.text).toContain('ended with exit status 3');
    expect(result.text).toContain('done');
    expect(result.summary).toContain('exit 3');
  });

  it('names the ids it does have when asked for one it does not', async () => {
    await start('sleep 30');

    await expect(run('bash_output', { id: 'bg_9' })).rejects.toThrow(/The ones this conversation/);
  });

  it('does not let one conversation read another’s', async () => {
    const id = await start('sleep 30', 'thread-1');

    await expect(runIn('thread-2', 'bash_output', { id })).rejects.toThrow(
      /has not started any, or they have all been cleared away/
    );
  });
});

describe('stopping one', () => {
  it('kills it and says so, and a later read finds it stopped', async () => {
    const id = await start('sleep 30');

    const killed = await run('bash_kill', { id });
    expect(killed.text).toContain('was stopped');

    const after = await run('bash_output', { id });
    expect(after.text).toContain('was stopped after');
  });

  /** The whole point of the process group: the shell dies, its children too. */
  it('kills what the command started, not just the shell', async () => {
    // A duration no other test uses, so `pgrep` cannot find one of theirs still
    // inside its two seconds of grace and call it this one's grandchild.
    const id = await start('sh -c "sleep 37" & wait');
    await run('bash_kill', { id });

    // If the group survived, the grandchild would still be holding the name.
    // `3[7]` matches `sleep 37` without the probe's own command line matching
    // it: Linux `pgrep -f` reads every process's arguments and only skips
    // itself, so a plain `sleep 37` here finds the shell asking the question.
    const { text } = await run('bash', {
      command: 'sleep 0.3; pgrep -f "sleep 3[7]" || echo none'
    });
    expect(text).toContain('none');
  });

  it('reports a command that had already finished rather than pretending to stop it', async () => {
    const id = await start('echo bye');
    await until(id, (r) => r.text.includes('finished in'));

    const { text } = await run('bash_kill', { id });
    expect(text).toContain('had already finished');
  });
});

describe('how many one conversation may hold', () => {
  it('refuses past the cap while they are all running', async () => {
    for (let i = 0; i < BACKGROUND_MAX_JOBS; i++) await start('sleep 30');

    await expect(run('bash', { command: 'sleep 30', background: true })).rejects.toThrow(
      /Stop one with bash_kill before starting another/
    );
  });

  it('gives the slot back when one of them finishes', async () => {
    const first = await start('echo quick');
    for (let i = 1; i < BACKGROUND_MAX_JOBS; i++) await start('sleep 30');
    await until(first, (r) => r.text.includes('finished in'));

    // The finished one is evicted to make room rather than the cap being raised.
    await expect(start('sleep 30')).resolves.toMatch(/bg_\d+/);
    await expect(run('bash_output', { id: first })).rejects.toThrow(/no background command/);
  });
});

describe('clearing up', () => {
  it('kills everything one conversation started, which is what ends a subagent', async () => {
    const id = await start('sleep 30', 'child-1');
    await start('sleep 30', 'thread-1');

    killThreadBackgroundCommands('child-1');

    await expect(runIn('child-1', 'bash_output', { id })).rejects.toThrow(/no background command/);
    // The other conversation's is untouched: this is one thread's clean-up.
    await expect(run('bash_output', { id: 'bg_1' })).resolves.toBeDefined();
  });

  it('kills everything, which is what quitting does', async () => {
    await start('sleep 30', 'thread-1');
    await start('sleep 30', 'thread-2');

    killAllBackgroundCommands();

    await expect(run('bash_output', { id: 'bg_1' })).rejects.toThrow(/no background command/);
    await expect(runIn('thread-2', 'bash_output', { id: 'bg_1' })).rejects.toThrow(
      /no background command/
    );
  });
});
