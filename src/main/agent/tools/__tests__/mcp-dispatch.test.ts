import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runAgentTool } from '../run';
import type { AgentToolContext } from '../../../../shared/agent-tools';
import type { McpToolOutput } from '../../../../shared/agent-mcp';
import { isAgentImagePath } from '../../image-store';

/**
 * How a call to a connected server gets from the model to the server and back.
 *
 * The manager's own tests cover talking to a server; these cover the seam - a
 * namespaced name reaching the caller untouched, a failure becoming something
 * the model can read, and a picture ending up somewhere the sandbox will let it
 * be read from again.
 */

let dir: string;
/** Every call that reached the fake server, so a test can see what got through. */
let seen: Array<{ name: string; args: string }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-mcp-dispatch-'));
  seen = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(output: McpToolOutput | null, threadId = randomUUID()): AgentToolContext {
  return {
    cwd: dir,
    threadId,
    signal: new AbortController().signal,
    handOff: () => {},
    approve: async () => Promise.resolve(true),
    wasRefused: () => false,
    generateImage: null,
    todos: { list: () => [], save: () => {} },
    mcp:
      output === null
        ? null
        : async (name, args) => {
            seen.push({ name, args });
            return Promise.resolve(output);
          },
    dispatchTask: null,
    findSubagent: null,
    findSkill: null,
    schedule: null
  };
}

const text = (value: string): McpToolOutput => ({ text: value, isError: false, image: null });

describe('running an MCP tool', () => {
  it('hands a namespaced call to the caller, arguments untouched', async () => {
    const result = await runAgentTool(
      'mcp__linear__list_issues',
      '{"team":"core"}',
      ctx(text('two issues'))
    );

    expect(seen).toEqual([{ name: 'mcp__linear__list_issues', args: '{"team":"core"}' }]);
    expect(result.text).toBe('two issues');
  });

  it('does not try to parse arguments the server owns', async () => {
    // A server whose schema takes a bare string would be refused by a parse
    // this file has no business doing.
    await runAgentTool('mcp__x__y', 'not json at all', ctx(text('fine')));
    expect(seen[0].args).toBe('not json at all');
  });

  it('turns a server failure into a sentence, rather than a crash', async () => {
    await expect(
      runAgentTool('mcp__x__y', '{}', ctx({ text: 'no such issue', isError: true, image: null }))
    ).rejects.toThrow('no such issue');
  });

  it('says a tool does not exist when no server is connected', async () => {
    await expect(runAgentTool('mcp__gone__y', '{}', ctx(null))).rejects.toThrow(
      'There is no tool called mcp__gone__y'
    );
  });

  it('leaves the agent own tools to the dispatcher', async () => {
    await expect(runAgentTool('not_a_tool', '{}', ctx(text('unused')))).rejects.toThrow(
      'There is no tool called not_a_tool'
    );
    expect(seen).toEqual([]);
  });

  it('summarises the answer for the row', async () => {
    expect((await runAgentTool('mcp__x__y', '{}', ctx(text('one\ntwo\nthree')))).summary).toBe(
      '3 lines'
    );
    expect((await runAgentTool('mcp__x__y', '{}', ctx(text('short')))).summary).toBe(
      '5 characters'
    );
    expect((await runAgentTool('mcp__x__y', '{}', ctx(text('')))).summary).toBe('no output');
  });

  it('writes a picture where it can be read from again', async () => {
    const pixel = Buffer.from('89504e470d0a1a0a', 'hex');
    const result = await runAgentTool(
      'mcp__browser__screenshot',
      '{}',
      ctx({
        text: 'the page',
        isError: false,
        image: { data: pixel.toString('base64'), mimeType: 'image/png' }
      })
    );

    expect(result.image?.mimeType).toBe('image/png');
    // Outside the working folder, and in the one place outside it that a
    // picture may be read from - otherwise the model could never look at it.
    expect(result.image?.path.startsWith(dir)).toBe(false);
    expect(isAgentImagePath(result.image?.path ?? '')).toBe(true);
    expect(readFileSync(result.image?.path ?? '')).toEqual(pixel);
    expect(result.text).toBe('the page');

    rmSync(result.image?.path ?? '', { force: true });
  });
});
