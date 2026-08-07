import { describe, it, expect, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/client';
import { McpManager, readResult } from '../manager';
import type { McpServersConfig } from '../../../../shared/agent-mcp';
import { wireToolName } from '../../../../shared/agent-mcp-names';
import { fakeServer, hangingTransport, type FakeServer } from './fake-server';

const SEARCH: Tool = {
  name: 'search',
  description: 'Search the docs',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } }
};

const DELETE: Tool = {
  name: 'delete_everything',
  description: 'Do not',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: false }
};

const READER: Tool = {
  name: 'read_page',
  description: 'Read one page',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true }
};

function managerOver(
  config: McpServersConfig,
  servers: Record<string, FakeServer | undefined>,
  onStatusChange?: () => void
): McpManager {
  return new McpManager({
    getConfig: () => config,
    onStatusChange,
    // A name with no fake behind it gets a transport that never connects,
    // which is how the startup timeout gets something to time out on.
    createTransport: (cfg) => {
      const name = Object.entries(config).find(([, candidate]) => candidate === cfg)?.[0] ?? '';
      return servers[name]?.transport ?? hangingTransport();
    }
  });
}

const enabled = (url: string): McpServersConfig[string] => ({ url, enabled: true });

describe('McpManager', () => {
  it('offers every tool a connected server has, under a namespaced name', async () => {
    const docs = fakeServer({ tools: [SEARCH, READER] });
    const manager = managerOver({ docs: enabled('https://docs.test') }, { docs });

    await manager.reload();

    expect(manager.getToolSpecs().map((s) => s.function.name)).toEqual([
      'mcp__docs__search',
      'mcp__docs__read_page'
    ]);
    await manager.closeAll();
  });

  it('routes a call back to the server and tool the name stands for', async () => {
    const docs = fakeServer({ tools: [SEARCH] });
    const manager = managerOver({ docs: enabled('https://docs.test') }, { docs });
    await manager.reload();

    const result = await manager.callTool('mcp__docs__search', '{"q":"pty"}');

    expect(result).toEqual({ text: 'ran search', isError: false, image: null });
    expect(docs.calls).toEqual([{ name: 'search', args: { q: 'pty' } }]);
    await manager.closeAll();
  });

  it('routes correctly when the wire name had to be shortened', async () => {
    const long: Tool = { ...SEARCH, name: 'x'.repeat(90) };
    const docs = fakeServer({ tools: [long] });
    const manager = managerOver({ docs: enabled('https://docs.test') }, { docs });
    await manager.reload();

    const wire = wireToolName('docs', long.name);
    expect(wire).not.toContain(long.name);

    await manager.callTool(wire, '{}');
    expect(docs.calls[0].name).toBe(long.name);
    await manager.closeAll();
  });

  it('contributes nothing for a server that is switched off', async () => {
    const docs = fakeServer({ tools: [SEARCH] });
    const manager = managerOver({ docs: { url: 'https://docs.test', enabled: false } }, { docs });

    await manager.reload();

    expect(manager.getToolSpecs()).toEqual([]);
    expect(manager.statuses()[0].state).toBe('disabled');
    await manager.closeAll();
  });

  it('hides a tool the user switched off, and refuses to call it', async () => {
    const docs = fakeServer({ tools: [SEARCH, DELETE] });
    const manager = managerOver(
      { docs: { url: 'https://docs.test', enabled: true, disabledTools: ['delete_everything'] } },
      { docs }
    );
    await manager.reload();

    expect(manager.getToolSpecs().map((s) => s.function.name)).toEqual(['mcp__docs__search']);

    const result = await manager.callTool('mcp__docs__delete_everything', '{}');
    expect(result.isError).toBe(true);
    expect(docs.calls).toEqual([]);
    await manager.closeAll();
  });

  it('reports a server that cannot connect as failed, with the reason', async () => {
    const broken = fakeServer({ tools: [], failEverything: 'the database is on fire' });
    const manager = managerOver({ broken: enabled('https://broken.test') }, { broken });

    await manager.reload();

    const status = manager.statuses()[0];
    expect(status.state).toBe('failed');
    expect(status.error).toContain('the database is on fire');
    expect(manager.getToolSpecs()).toEqual([]);
    await manager.closeAll();
  });

  it('does not let one dead server stall the pane', async () => {
    vi.useFakeTimers();
    try {
      const manager = managerOver({ dead: enabled('https://dead.test') }, {});
      const reloading = manager.reload();
      await vi.advanceTimersByTimeAsync(6_000);
      await reloading;

      const status = manager.statuses()[0];
      expect(status.state).toBe('failed');
      expect(status.error).toContain('Timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a healthy server when another one alongside it is broken', async () => {
    const docs = fakeServer({ tools: [SEARCH] });
    const broken = fakeServer({ tools: [], failEverything: 'nope' });
    const manager = managerOver(
      { docs: enabled('https://docs.test'), broken: enabled('https://broken.test') },
      { docs, broken }
    );

    await manager.reload();

    expect(manager.getToolSpecs().map((s) => s.function.name)).toEqual(['mcp__docs__search']);
    await manager.closeAll();
  });

  it('follows a server that changes its own tool list', async () => {
    const docs = fakeServer({ tools: [SEARCH] });
    const changed = vi.fn();
    const manager = managerOver({ docs: enabled('https://docs.test') }, { docs }, changed);
    await manager.reload();

    await docs.changeTools([SEARCH, READER]);
    await vi.waitFor(() => {
      expect(manager.getToolSpecs()).toHaveLength(2);
    });

    expect(manager.hasTool('mcp__docs__read_page')).toBe(true);
    expect(changed).toHaveBeenCalled();
    await manager.closeAll();
  });

  it('forgets a tool the server dropped', async () => {
    const docs = fakeServer({ tools: [SEARCH, READER] });
    const manager = managerOver({ docs: enabled('https://docs.test') }, { docs });
    await manager.reload();

    await docs.changeTools([SEARCH]);
    await vi.waitFor(() => {
      expect(manager.hasTool('mcp__docs__read_page')).toBe(false);
    });
    await manager.closeAll();
  });

  it('reports what a server claims only reads', async () => {
    const docs = fakeServer({ tools: [READER, DELETE] });
    const manager = managerOver({ docs: enabled('https://docs.test') }, { docs });
    await manager.reload();

    expect(manager.isReadOnly('mcp__docs__read_page')).toBe(true);
    expect(manager.isReadOnly('mcp__docs__delete_everything')).toBe(false);
    await manager.closeAll();
  });

  it('says which server a tool came from, for labelling', async () => {
    const docs = fakeServer({ tools: [SEARCH] });
    const manager = managerOver({ docs: enabled('https://docs.test') }, { docs });
    await manager.reload();

    expect(manager.serverOf('mcp__docs__search')).toBe('docs');
    expect(manager.toolOf('mcp__docs__search')).toBe('search');
    expect(manager.serverOf('read')).toBeNull();
    await manager.closeAll();
  });

  it('turns a tool that errored into something the model can read', async () => {
    const docs = fakeServer({
      tools: [SEARCH],
      respond: () => ({ isError: true, content: [{ type: 'text', text: 'no such document' }] })
    });
    const manager = managerOver({ docs: enabled('https://docs.test') }, { docs });
    await manager.reload();

    expect(await manager.callTool('mcp__docs__search', '{}')).toEqual({
      text: 'no such document',
      isError: true,
      image: null
    });
    await manager.closeAll();
  });

  it('rejects arguments that are not a JSON object without calling the server', async () => {
    const docs = fakeServer({ tools: [SEARCH] });
    const manager = managerOver({ docs: enabled('https://docs.test') }, { docs });
    await manager.reload();

    expect((await manager.callTool('mcp__docs__search', '{oops')).isError).toBe(true);
    expect((await manager.callTool('mcp__docs__search', '[1,2]')).isError).toBe(true);
    expect(docs.calls).toEqual([]);
    await manager.closeAll();
  });

  it('names an unknown tool rather than failing obscurely', async () => {
    const manager = managerOver({}, {});
    await manager.reload();

    expect(await manager.callTool('mcp__gone__search', '{}')).toEqual({
      text: 'There is no tool called mcp__gone__search',
      isError: true,
      image: null
    });
  });

  it('drops every connection on reload so a config change actually takes', async () => {
    const config: McpServersConfig = { docs: enabled('https://docs.test') };
    const docs = fakeServer({ tools: [SEARCH] });
    const manager = managerOver(config, { docs });
    await manager.reload();
    expect(manager.getToolSpecs()).toHaveLength(1);

    delete config.docs;
    await manager.reload();

    expect(manager.getToolSpecs()).toEqual([]);
    expect(manager.statuses()).toEqual([]);
    expect(manager.hasTool('mcp__docs__search')).toBe(false);
  });

  it('describes a tool the server left undescribed', async () => {
    const bare: Tool = { name: 'go', inputSchema: { type: 'object' } };
    const docs = fakeServer({ tools: [bare] });
    const manager = managerOver({ docs: enabled('https://docs.test') }, { docs });
    await manager.reload();

    expect(manager.getToolSpecs()[0].function.description).toBe('go, from the docs server.');
    await manager.closeAll();
  });
});

describe('readResult', () => {
  it('joins several text blocks', () => {
    const result = readResult({
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' }
      ]
    });
    expect(result.text).toBe('a\nb');
  });

  it('lifts a picture out to travel beside the text', () => {
    const result = readResult({
      content: [
        { type: 'text', text: 'here is the page' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' }
      ]
    });
    expect(result.text).toBe('here is the page');
    expect(result.image).toEqual({ data: 'aGk=', mimeType: 'image/png' });
  });

  it('says a picture arrived when that is all there was', () => {
    const result = readResult({
      content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]
    });
    expect(result.text).toBe('(an image)');
  });

  it('takes only the first picture, however many came back', () => {
    const result = readResult({
      content: [
        { type: 'image', data: 'first', mimeType: 'image/png' },
        { type: 'image', data: 'second', mimeType: 'image/png' }
      ]
    });
    expect(result.image?.data).toBe('first');
  });

  it('names content it can neither read nor show', () => {
    const result = readResult({ content: [{ type: 'audio', data: '...', mimeType: 'audio/wav' }] });
    expect(result.text).toBe('(audio content)');
    expect(result.image).toBeNull();
  });

  it('says so rather than returning nothing at all', () => {
    expect(readResult({ content: [] }).text).toBe('(no output)');
  });

  it('truncates a result too large to spend the turn on', () => {
    const result = readResult({ content: [{ type: 'text', text: 'x'.repeat(30_000) }] });
    expect(result.text.length).toBeLessThan(26_000);
    expect(result.text).toContain('truncated 5000 characters');
  });

  it('lets a large result through, but says it was large', () => {
    const result = readResult({ content: [{ type: 'text', text: 'x'.repeat(12_000) }] });
    expect(result.text).toContain('a large result, 12000 characters');
  });

  it('leaves an ordinary result alone', () => {
    expect(readResult({ content: [{ type: 'text', text: 'fine' }] }).text).toBe('fine');
  });
});
